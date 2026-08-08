package main

import (
	"crypto/rand"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// DefaultAxes are used unless an organizer sets a custom issue-set schema.
var DefaultAxes = []string{"Uncertainty", "Complexity", "Toil"}

const (
	AxisMax        = 10.0
	maxNameLen     = 24
	maxTitleLen    = 200
	maxRoundSecs   = 3600
	writeWait      = 10 * time.Second
	pongWait       = 70 * time.Second
	pingPeriod     = 30 * time.Second
	helloDeadline  = 10 * time.Second
	sendBufferSize = 32
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 4096,
	// No auth by design: sessions are short-lived, unlisted, and hold no
	// sensitive data. Same-origin checks are relaxed accordingly.
	CheckOrigin: func(r *http.Request) bool { return true },
}

// ---------------------------------------------------------------------------
// Hub

type Hub struct {
	mu       sync.Mutex
	sessions map[string]*Session
	store    SessionStore
}

func NewHub() *Hub {
	return NewHubWithStore(nil)
}

func NewHubWithStore(store SessionStore) *Hub {
	return &Hub{sessions: make(map[string]*Session), store: store}
}

func (h *Hub) create() *Session {
	h.mu.Lock()
	defer h.mu.Unlock()
	for {
		code := randCode(5)
		if _, taken := h.sessions[code]; taken {
			continue
		}
		s := &Session{
			Code:           code,
			hub:            h,
			clients:        make(map[*Client]bool),
			organizerToken: randCode(20),
			axes:           append([]string(nil), DefaultAxes...),
		}
		h.sessions[code] = s
		return s
	}
}

func (h *Hub) get(code string) *Session {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.sessions[code]
}

func (h *Hub) remove(code string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.sessions, code)
}

// ---------------------------------------------------------------------------
// Client

type Client struct {
	id        string
	name      string
	organizer bool
	session   *Session
	conn      *websocket.Conn
	send      chan []byte
}

func (c *Client) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		_ = c.conn.Close()
	}()
	for {
		select {
		case msg, ok := <-c.send:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				_ = c.conn.WriteMessage(websocket.CloseMessage,
					websocket.FormatCloseMessage(websocket.CloseNormalClosure, "session closed"))
				return
			}
			if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		case <-ticker.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (c *Client) readPump() {
	defer func() {
		c.session.leave(c)
		_ = c.conn.Close()
	}()
	_ = c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		return c.conn.SetReadDeadline(time.Now().Add(pongWait))
	})
	for {
		_, data, err := c.conn.ReadMessage()
		if err != nil {
			return
		}
		var msg inboundMsg
		if err := json.Unmarshal(data, &msg); err != nil {
			c.trySend(mustJSON(map[string]string{"type": "error", "message": "malformed message"}))
			continue
		}
		c.session.handle(c, &msg)
	}
}

// trySend drops the message (and lets the ping timeout reap the client)
// rather than blocking the whole session on one slow socket.
func (c *Client) trySend(msg []byte) {
	select {
	case c.send <- msg:
	default:
	}
}

// ---------------------------------------------------------------------------
// Session

type Session struct {
	Code           string
	hub            *Hub
	organizerToken string

	mu       sync.Mutex
	clients  map[*Client]bool
	round    *Round
	items    []string
	nextItem int
	axes     []string
	closed   bool
}

type Round struct {
	Number      int
	Title       string
	Open        bool
	Deadline    *time.Time
	timer       *time.Timer
	Submissions map[string]*Submission // keyed by client id; survives disconnects
	Summary     *Summary
}

type Submission struct {
	Name   string
	Values []float64
}

type inboundMsg struct {
	Type    string    `json:"type"`
	Title   string    `json:"title"`
	Items   []string  `json:"items"`
	Aspects []string  `json:"aspects"`
	Seconds int       `json:"seconds"`
	Values  []float64 `json:"values"`
}

func (s *Session) handle(c *Client, msg *inboundMsg) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	switch msg.Type {
	case "load_items":
		if !c.organizer {
			c.trySend(errMsg("Only the organizer can load issues."))
			return
		}
		if s.round != nil && s.round.Open {
			c.trySend(errMsg("End the current round before loading issues."))
			return
		}
		items := cleanItems(msg.Items)
		if len(items) == 0 {
			c.trySend(errMsg("Add at least one issue to load it."))
			return
		}
		aspects, err := cleanAspects(msg.Aspects)
		if err != nil {
			c.trySend(errMsg(err.Error()))
			return
		}
		s.items = items
		s.nextItem = 0
		s.axes = aspects
		s.persistLocked()
		s.broadcastStateLocked()

	case "start_round":
		if !c.organizer {
			c.trySend(errMsg("Only the organizer can start a round."))
			return
		}
		if s.round != nil && s.round.Open {
			c.trySend(errMsg("End the current round before starting a new one."))
			return
		}
		title := strings.TrimSpace(msg.Title)
		if title == "" && s.nextItem < len(s.items) {
			title = s.items[s.nextItem]
			s.nextItem++
		}
		if title == "" {
			c.trySend(errMsg("Load issues or give the round a title."))
			return
		}
		if len(title) > maxTitleLen {
			title = title[:maxTitleLen]
		}
		num := 1
		if s.round != nil {
			num = s.round.Number + 1
		}
		r := &Round{
			Number:      num,
			Title:       title,
			Open:        true,
			Submissions: make(map[string]*Submission),
		}
		if msg.Seconds > 0 {
			secs := msg.Seconds
			if secs > maxRoundSecs {
				secs = maxRoundSecs
			}
			dl := time.Now().Add(time.Duration(secs) * time.Second)
			r.Deadline = &dl
			r.timer = time.AfterFunc(time.Until(dl), func() { s.timerFired(r) })
		}
		s.round = r
		s.persistLocked()
		s.broadcastStateLocked()

	case "submit":
		r := s.round
		if r == nil || !r.Open {
			c.trySend(errMsg("No round is open for estimates right now."))
			return
		}
		if len(msg.Values) != len(s.axes) {
			c.trySend(errMsg("Estimate must cover every axis."))
			return
		}
		vals := make([]float64, len(msg.Values))
		for i, v := range msg.Values {
			if v < 0 {
				v = 0
			}
			if v > AxisMax {
				v = AxisMax
			}
			vals[i] = v
		}
		r.Submissions[c.id] = &Submission{Name: c.name, Values: vals}
		s.persistLocked()
		s.broadcastStateLocked()

	case "end_round":
		if !c.organizer {
			c.trySend(errMsg("Only the organizer can end the round."))
			return
		}
		s.endRoundLocked()

	case "close_session":
		if !c.organizer {
			c.trySend(errMsg("Only the organizer can close the session."))
			return
		}
		s.closeLocked("The organizer closed the session.")

	default:
		c.trySend(errMsg("Unknown message type."))
	}
}

func (s *Session) timerFired(r *Round) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.round != r || !r.Open {
		return
	}
	s.endRoundLocked()
}

func (s *Session) endRoundLocked() {
	r := s.round
	if r == nil || !r.Open {
		return
	}
	r.Open = false
	if r.timer != nil {
		r.timer.Stop()
		r.timer = nil
	}
	r.Deadline = nil
	r.Summary = computeSummary(shapesOf(r.Submissions), s.axes)
	s.persistLocked()
	s.broadcastStateLocked()
}

func (s *Session) join(c *Client) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	s.clients[c] = true
	s.persistLocked()
	s.broadcastStateLocked()
}

func (s *Session) leave(c *Client) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	if _, ok := s.clients[c]; ok {
		delete(s.clients, c)
		close(c.send)
	}
	empty := len(s.clients) == 0
	if empty {
		// Last person out: the session and everything in it ceases to exist.
		s.closed = true
		if s.round != nil && s.round.timer != nil {
			s.round.timer.Stop()
		}
	} else {
		s.persistLocked()
		s.broadcastStateLocked()
	}
	s.mu.Unlock()
	if empty {
		s.hub.remove(s.Code)
		s.hub.deleteCached(s.Code)
	}
}

func (s *Session) closeLocked(reason string) {
	if s.closed {
		return
	}
	s.closed = true
	if s.round != nil && s.round.timer != nil {
		s.round.timer.Stop()
	}
	bye := mustJSON(map[string]string{"type": "closed", "message": reason})
	for c := range s.clients {
		c.trySend(bye)
		close(c.send)
		delete(s.clients, c)
	}
	go func() {
		s.hub.remove(s.Code)
		s.hub.deleteCached(s.Code)
	}()
}

// ---------------------------------------------------------------------------
// Views / broadcast

type ParticipantView struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Organizer bool   `json:"organizer"`
	Submitted bool   `json:"submitted"`
}

type RoundView struct {
	Number         int       `json:"number"`
	Title          string    `json:"title"`
	Open           bool      `json:"open"`
	DeadlineMs     int64     `json:"deadlineMs,omitempty"`
	SubmittedCount int       `json:"submittedCount"`
	Average        []float64 `json:"average,omitempty"`
	Summary        *Summary  `json:"summary,omitempty"`
}

type StateView struct {
	Type         string            `json:"type"`
	Code         string            `json:"code"`
	Axes         []string          `json:"axes"`
	AxisMax      float64           `json:"axisMax"`
	Participants []ParticipantView `json:"participants"`
	QueuedItems  int               `json:"queuedItems"`
	Round        *RoundView        `json:"round,omitempty"`
}

func (s *Session) broadcastStateLocked() {
	sv := StateView{
		Type: "state", Code: s.Code, Axes: s.axes, AxisMax: AxisMax,
		QueuedItems: len(s.items) - s.nextItem,
	}
	for c := range s.clients {
		submitted := false
		if s.round != nil {
			_, submitted = s.round.Submissions[c.id]
		}
		sv.Participants = append(sv.Participants, ParticipantView{
			ID: c.id, Name: c.name, Organizer: c.organizer, Submitted: submitted,
		})
	}
	if r := s.round; r != nil {
		rv := &RoundView{
			Number:         r.Number,
			Title:          r.Title,
			Open:           r.Open,
			SubmittedCount: len(r.Submissions),
			Summary:        r.Summary,
		}
		if r.Deadline != nil {
			rv.DeadlineMs = r.Deadline.UnixMilli()
		}
		// Live group average while the round is open (revealed as it forms).
		if r.Open && len(r.Submissions) > 0 {
			rv.Average = axisAverages(shapesOf(r.Submissions), len(s.axes))
		}
		sv.Round = rv
	}
	msg := mustJSON(sv)
	for c := range s.clients {
		c.trySend(msg)
	}
}

// ---------------------------------------------------------------------------
// WS handshake

func (h *Hub) HandleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	_ = conn.SetReadDeadline(time.Now().Add(helloDeadline))
	_, data, err := conn.ReadMessage()
	if err != nil {
		_ = conn.Close()
		return
	}
	var hello struct {
		Type           string `json:"type"` // "create" | "join"
		Name           string `json:"name"`
		Code           string `json:"code"`
		OrganizerToken string `json:"organizerToken"`
	}
	if err := json.Unmarshal(data, &hello); err != nil {
		closeWith(conn, "malformed hello")
		return
	}
	name := strings.TrimSpace(hello.Name)
	if name == "" {
		name = "Anonymous"
	}
	if len(name) > maxNameLen {
		name = name[:maxNameLen]
	}

	var s *Session
	organizer := false
	switch hello.Type {
	case "create":
		s = h.create()
		organizer = true
	case "join":
		s = h.get(strings.ToUpper(strings.TrimSpace(hello.Code)))
		if s == nil {
			closeWith(conn, "No session with that code. It may have ended.")
			return
		}
		organizer = hello.OrganizerToken != "" && hello.OrganizerToken == s.organizerToken
	default:
		closeWith(conn, "first message must be create or join")
		return
	}

	c := &Client{
		id:        randCode(12),
		name:      name,
		organizer: organizer,
		session:   s,
		conn:      conn,
		send:      make(chan []byte, sendBufferSize),
	}

	welcome := map[string]any{
		"type": "joined", "code": s.Code, "selfId": c.id,
		"organizer": organizer, "axes": s.axes, "axisMax": AxisMax,
	}
	if organizer {
		welcome["organizerToken"] = s.organizerToken
	}
	c.send <- mustJSON(welcome)

	go c.writePump()
	s.join(c)
	c.readPump()
}

func closeWith(conn *websocket.Conn, msg string) {
	_ = conn.SetWriteDeadline(time.Now().Add(writeWait))
	_ = conn.WriteMessage(websocket.TextMessage,
		mustJSON(map[string]string{"type": "error", "message": msg, "fatal": "true"}))
	_ = conn.Close()
}

// ---------------------------------------------------------------------------
// Helpers

const codeAlphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"

func randCode(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		log.Fatalf("crypto/rand unavailable: %v", err)
	}
	for i := range b {
		b[i] = codeAlphabet[int(b[i])%len(codeAlphabet)]
	}
	return string(b)
}

func errMsg(m string) []byte {
	return mustJSON(map[string]string{"type": "error", "message": m})
}

func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		log.Printf("marshal error: %v", err)
		return []byte(`{"type":"error","message":"internal error"}`)
	}
	return b
}
