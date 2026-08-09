package main

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// DefaultAxes are used unless an organizer sets a custom issue-set schema.
var DefaultAxes = []string{"Uncertainty", "Complexity", "Toil"}

const (
	AxisMax        = 8.0
	AxisMin        = 1.0
	maxNameLen     = 24
	maxTitleLen    = 200
	maxRoundSecs   = 3600
	writeWait      = 10 * time.Second
	pongWait       = 70 * time.Second
	pingPeriod     = 30 * time.Second
	helloDeadline  = 10 * time.Second
	sendBufferSize = 32
	// Shown whenever an organizer tries to change a session that has already
	// produced its final summary. Hiding these controls in the UI is not
	// enough — a stale tab can still send the message.
	concludedMsg = "This session has concluded. Restart it to change the queue or run another round."
	// gorilla reads a frame fully into memory before returning it, and defaults
	// to no cap — one client could otherwise exhaust the box's RAM. The largest
	// legitimate message is a full 100-issue queue with links and descriptions.
	maxMessageBytes = 256 << 10
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
	limits   Limits
	// Live counts per client IP. Sessions are held in RAM, so these are the
	// ceilings that stop one caller from allocating the box out from under
	// everyone else.
	ipConns    map[string]int
	ipSessions map[string]int
}

func NewHub() *Hub {
	return NewHubWithStore(nil)
}

func NewHubWithStore(store SessionStore) *Hub {
	return NewHubWithLimits(store, DefaultLimits)
}

func NewHubWithLimits(store SessionStore, limits Limits) *Hub {
	return &Hub{
		sessions:   make(map[string]*Session),
		store:      store,
		limits:     limits,
		ipConns:    make(map[string]int),
		ipSessions: make(map[string]int),
	}
}

// acquireConn reserves a connection slot for ip, or reports that the caller is
// already holding as many as it is allowed.
func (h *Hub) acquireConn(ip string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.ipConns[ip] >= h.limits.MaxConnectionsPerIP {
		return false
	}
	h.ipConns[ip]++
	return true
}

func (h *Hub) releaseConn(ip string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.ipConns[ip] <= 1 {
		delete(h.ipConns, ip) // don't let the map itself become the leak
		return
	}
	h.ipConns[ip]--
}

func (h *Hub) create(ip string) *Session {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.sessions) >= h.limits.MaxSessions {
		return nil
	}
	if h.ipSessions[ip] >= h.limits.MaxSessionsPerIP {
		return nil
	}
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
			axisMins:       defaultAxisValues(AxisMin),
			axisMaxes:      defaultAxisValues(AxisMax),
			pointLabels:    cleanPointLabels(nil, int(AxisMax)),
		}
		s.creatorIP = ip
		h.sessions[code] = s
		h.ipSessions[ip]++
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
	if s, ok := h.sessions[code]; ok {
		if h.ipSessions[s.creatorIP] <= 1 {
			delete(h.ipSessions, s.creatorIP)
		} else {
			h.ipSessions[s.creatorIP]--
		}
	}
	delete(h.sessions, code)
}

// ---------------------------------------------------------------------------
// Client

type Client struct {
	id        string
	ip        string
	name      string
	color     string
	organizer bool
	session   *Session
	conn      *websocket.Conn
	send      chan []byte
}

// ShapeColors is the fixed pool participants pick from. It is sent to the
// client on join so the palette lives in exactly one place, and uniqueness
// within a session is enforced here rather than trusted from the browser.
var ShapeColors = []string{
	"#6D57B8", "#2A6F8E", "#A87428", "#C03B2D",
	"#43775C", "#9A4E86", "#536B9B", "#875E3A",
}

func validShapeColor(want string) bool {
	for _, color := range ShapeColors {
		if strings.EqualFold(color, want) {
			return true
		}
	}
	return false
}

// colorTakenLocked reports whether anyone other than `self` already holds it.
func (s *Session) colorTakenLocked(want string, self *Client) bool {
	for other := range s.clients {
		if other != self && strings.EqualFold(other.color, want) {
			return true
		}
	}
	return false
}

// freeColorLocked hands out the first unclaimed colour. A session larger than
// the palette leaves the surplus empty, and the client falls back to a slot
// colour — better than two people sharing one on the overlay by default.
func (s *Session) freeColorLocked(self *Client) string {
	for _, color := range ShapeColors {
		if !s.colorTakenLocked(color, self) {
			return color
		}
	}
	return ""
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
	c.conn.SetReadLimit(maxMessageBytes)
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
	creatorIP      string

	mu                sync.Mutex
	clients           map[*Client]bool
	round             *Round
	history           []HistoryEntry // concluded rounds, oldest first
	items             []Item
	nextItem          int
	axes              []string
	axisMins          []float64
	axisMaxes         []float64
	pointLabels       []string
	finalSummaryShown bool
	closed            bool
}

type Round struct {
	Number      int
	Title       string
	Link        string
	Description string
	Open        bool
	Deadline    *time.Time
	// Paused holds what was left on the clock when the organizer stopped it,
	// so resuming continues the round rather than restarting it.
	Paused      time.Duration
	timer       *time.Timer
	Submissions map[string]*Submission // keyed by client id; survives disconnects
	Previews    map[string]*Submission // keyed by client id; current unsent chart
	Summary     *Summary
}

type Submission struct {
	Name    string
	Values  []float64
	Touched bool
}

type Item struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Link        string `json:"link,omitempty"`
	Description string `json:"description,omitempty"`
}

// HistoryEntry is a round that has been concluded. It carries the finished
// summary, which already holds the averages, spread, outliers and every
// individual shape, so the organizer can page back through past issues
// without the server keeping the live round machinery alive.
type HistoryEntry struct {
	Number      int      `json:"number"`
	Title       string   `json:"title"`
	Link        string   `json:"link,omitempty"`
	Description string   `json:"description,omitempty"`
	Summary     *Summary `json:"summary,omitempty"`
}

type inboundMsg struct {
	Type        string    `json:"type"`
	Title       string    `json:"title"`
	Items       []Item    `json:"items"`
	Aspects     []string  `json:"aspects"`
	Max         float64   `json:"max"`
	PointLabels []string  `json:"pointLabels"`
	Seconds     int       `json:"seconds"`
	Values      []float64 `json:"values"`
	Touched     bool      `json:"touched"`
	ItemID      string    `json:"itemId"`
	Color       string    `json:"color"`
	Restore     bool      `json:"restore"`
}

func (s *Session) handle(c *Client, msg *inboundMsg) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	switch msg.Type {
	case "delete_queued_item":
		if !c.organizer {
			c.trySend(errMsg("Only the organizer can delete queued issues."))
			return
		}
		if s.finalSummaryShown {
			c.trySend(errMsg(concludedMsg))
			return
		}
		for i := s.nextItem; i < len(s.items); i++ {
			if s.items[i].ID != msg.ItemID {
				continue
			}
			s.items = append(s.items[:i], s.items[i+1:]...)
			s.persistLocked()
			s.broadcastStateLocked()
			return
		}
		c.trySend(errMsg("That issue is no longer in the queued work."))

	case "append_items":
		if !c.organizer {
			c.trySend(errMsg("Only the organizer can add issues to the queue."))
			return
		}
		// The final summary reports on a fixed set of rounds. Letting work be
		// appended afterwards would silently change what that total covers.
		if s.finalSummaryShown {
			c.trySend(errMsg(concludedMsg))
			return
		}
		items := cleanItems(msg.Items)
		if len(items) == 0 {
			c.trySend(errMsg("Add at least one issue to the queue."))
			return
		}
		s.items = append(s.items, items...)
		s.persistLocked()
		s.broadcastStateLocked()

	case "replace_items":
		if !c.organizer {
			c.trySend(errMsg("Only the organizer can replace queued issues."))
			return
		}
		if s.finalSummaryShown {
			c.trySend(errMsg(concludedMsg))
			return
		}
		if s.round != nil && s.round.Open {
			c.trySend(errMsg("End the current round before replacing queued issues."))
			return
		}
		items := cleanItems(msg.Items)
		if len(items) == 0 {
			c.trySend(errMsg("Add at least one issue to replace the queue."))
			return
		}
		s.items = items
		s.nextItem = 0
		s.persistLocked()
		s.broadcastStateLocked()

	case "load_items":
		if !c.organizer {
			c.trySend(errMsg("Only the organizer can load issues."))
			return
		}
		if s.finalSummaryShown {
			c.trySend(errMsg(concludedMsg))
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
		mins, maxes, err := cleanBounds(msg.Max, len(aspects))
		if err != nil {
			c.trySend(errMsg(err.Error()))
			return
		}
		s.items = items
		s.nextItem = 0
		s.axes = aspects
		s.axisMins = mins
		s.axisMaxes = maxes
		s.pointLabels = cleanPointLabels(msg.PointLabels, int(maxes[0]))
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
		item := Item{Title: strings.TrimSpace(msg.Title)}
		if item.Title == "" && s.nextItem < len(s.items) {
			item = s.items[s.nextItem]
			s.nextItem++
		}
		if item.Title == "" {
			c.trySend(errMsg("Load issues or give the round a title."))
			return
		}
		if len(item.Title) > maxTitleLen {
			item.Title = item.Title[:maxTitleLen]
		}
		num := 1
		if s.round != nil {
			num = s.round.Number + 1
		}
		r := &Round{
			Number:      num,
			Title:       item.Title,
			Link:        item.Link,
			Description: item.Description,
			Open:        true,
			Submissions: make(map[string]*Submission),
			Previews:    make(map[string]*Submission),
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

	case "preview", "submit":
		r := s.round
		if r == nil || !r.Open {
			if msg.Type == "submit" {
				c.trySend(errMsg("No round is open for estimates right now."))
			}
			return
		}
		if len(msg.Values) != len(s.axes) {
			if msg.Type == "submit" {
				c.trySend(errMsg("Estimate must cover every axis."))
			}
			return
		}
		if _, submitted := r.Submissions[c.id]; submitted {
			if msg.Type == "submit" {
				c.trySend(errMsg("Your estimate has already been submitted for this issue."))
			}
			return
		}
		vals := make([]float64, len(msg.Values))
		for i, v := range msg.Values {
			v = math.Round(v)
			if v < s.axisMins[i] {
				v = s.axisMins[i]
			}
			if v > s.axisMaxes[i] {
				v = s.axisMaxes[i]
			}
			vals[i] = v
		}
		preview := &Submission{Name: c.name, Values: vals, Touched: msg.Touched}
		r.Previews[c.id] = preview
		if msg.Type == "submit" {
			preview.Touched = true
			r.Submissions[c.id] = preview
		}
		s.persistLocked()
		s.broadcastStateLocked()

	case "set_color":
		if c.organizer {
			c.trySend(errMsg("The organizer does not submit a shape, so has no colour."))
			return
		}
		want := strings.TrimSpace(msg.Color)
		if !validShapeColor(want) {
			c.trySend(errMsg("That is not one of the available colours."))
			return
		}
		if s.colorTakenLocked(want, c) {
			// A restore is a best-effort reclaim after a refresh, not a
			// deliberate pick — losing the race is not worth a toast.
			if !msg.Restore {
				c.trySend(errMsg("Someone else already has that colour."))
			}
			return
		}
		if strings.EqualFold(c.color, want) {
			return
		}
		c.color = want
		s.broadcastStateLocked()

	case "remind":
		if !c.organizer {
			c.trySend(errMsg("Only the organizer can send reminders."))
			return
		}
		r := s.round
		if r == nil || !r.Open {
			c.trySend(errMsg("There is no open issue to remind people about."))
			return
		}
		reminder := mustJSON(map[string]string{"type": "reminder", "message": "A gentle reminder: please submit your estimate when you are ready."})
		for participant := range s.clients {
			if participant.organizer {
				continue
			}
			if _, submitted := r.Submissions[participant.id]; !submitted {
				participant.trySend(reminder)
			}
		}

	case "set_timer":
		if !c.organizer {
			c.trySend(errMsg("Only the organizer can start a timer."))
			return
		}
		if s.finalSummaryShown {
			c.trySend(errMsg(concludedMsg))
			return
		}
		r := s.round
		if r == nil || !r.Open {
			c.trySend(errMsg("There is no open issue to time."))
			return
		}
		left := time.Duration(msg.Seconds) * time.Second
		if msg.Seconds <= 0 {
			// No length given: pick up a paused clock where it stopped.
			if r.Paused <= 0 {
				c.trySend(errMsg("Enter a round length like 90s or 5m."))
				return
			}
			left = r.Paused
		}
		if left > maxRoundSecs*time.Second {
			left = maxRoundSecs * time.Second
		}
		if r.timer != nil {
			r.timer.Stop()
		}
		r.Paused = 0
		dl := time.Now().Add(left)
		r.Deadline = &dl
		r.timer = time.AfterFunc(time.Until(dl), func() { s.timerFired(r) })
		s.persistLocked()
		s.broadcastStateLocked()

	case "pause_timer":
		if !c.organizer {
			c.trySend(errMsg("Only the organizer can pause the timer."))
			return
		}
		r := s.round
		if r == nil || !r.Open || r.Deadline == nil {
			c.trySend(errMsg("There is no running timer to stop."))
			return
		}
		left := time.Until(*r.Deadline)
		if left < 0 {
			left = 0
		}
		if r.timer != nil {
			r.timer.Stop()
			r.timer = nil
		}
		r.Deadline = nil
		r.Paused = left
		s.persistLocked()
		s.broadcastStateLocked()

	case "end_round":
		if !c.organizer {
			c.trySend(errMsg("Only the organizer can end the round."))
			return
		}
		s.endRoundLocked()

	case "restart_round":
		if !c.organizer {
			c.trySend(errMsg("Only the organizer can restart a round."))
			return
		}
		r := s.round
		if r == nil || r.Open {
			c.trySend(errMsg("Only a concluded round can be restarted."))
			return
		}
		if len(s.history) > 0 && s.history[len(s.history)-1].Number == r.Number {
			s.history = s.history[:len(s.history)-1]
		}
		r.Open = true
		r.Summary = nil
		r.Submissions = make(map[string]*Submission)
		r.Previews = make(map[string]*Submission)
		s.finalSummaryShown = false
		s.persistLocked()
		s.broadcastStateLocked()

	case "show_final_summary":
		if !c.organizer {
			c.trySend(errMsg("Only the organizer can show the final summary."))
			return
		}
		if s.round == nil || s.round.Open || s.nextItem < len(s.items) {
			c.trySend(errMsg("Finish every issue before showing the final summary."))
			return
		}
		s.finalSummaryShown = true
		s.persistLocked()
		s.broadcastStateLocked()

	case "restart_session":
		if !c.organizer {
			c.trySend(errMsg("Only the organizer can restart the session."))
			return
		}
		if len(s.items) == 0 {
			c.trySend(errMsg("There are no issues to restart."))
			return
		}
		if s.round != nil && s.round.timer != nil {
			s.round.timer.Stop()
		}
		s.round = nil
		s.history = nil
		s.nextItem = 0
		s.finalSummaryShown = false
		s.startNextRoundLocked(0)
		s.persistLocked()
		s.broadcastStateLocked()

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

func (s *Session) startNextRoundLocked(seconds int) {
	if s.nextItem >= len(s.items) {
		return
	}
	item := s.items[s.nextItem]
	s.nextItem++
	number := 1
	if s.round != nil {
		number = s.round.Number + 1
	}
	r := &Round{
		Number:      number,
		Title:       item.Title,
		Link:        item.Link,
		Description: item.Description,
		Open:        true,
		Submissions: make(map[string]*Submission),
		Previews:    make(map[string]*Submission),
	}
	if seconds > 0 {
		if seconds > maxRoundSecs {
			seconds = maxRoundSecs
		}
		dl := time.Now().Add(time.Duration(seconds) * time.Second)
		r.Deadline = &dl
		r.timer = time.AfterFunc(time.Until(dl), func() { s.timerFired(r) })
	}
	s.round = r
}

func (s *Session) timerFired(r *Round) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.round != r || !r.Open {
		return
	}
	s.endRoundLocked()
}

func (s *Session) submitCurrentChartsLocked(r *Round) {
	for c := range s.clients {
		if c.organizer {
			continue
		}
		if _, submitted := r.Submissions[c.id]; submitted {
			continue
		}
		if preview := r.Previews[c.id]; preview != nil {
			values := append([]float64(nil), preview.Values...)
			r.Submissions[c.id] = &Submission{Name: c.name, Values: values, Touched: preview.Touched}
			continue
		}
		values := make([]float64, len(s.axes))
		for i := range values {
			values[i] = math.Min(s.axisMaxes[i], math.Max(s.axisMins[i], 3))
		}
		r.Submissions[c.id] = &Submission{Name: c.name, Values: values}
	}
}

func (s *Session) endRoundLocked() {
	r := s.round
	if r == nil || !r.Open {
		return
	}
	// However the round ends — timer expiry or the organizer calling it — the
	// chart in front of each person is their answer. Waiting for an explicit
	// submit would silently drop everyone who was still deliberating.
	s.submitCurrentChartsLocked(r)
	r.Open = false
	if r.timer != nil {
		r.timer.Stop()
		r.timer = nil
	}
	r.Deadline = nil
	r.Paused = 0
	r.Summary = computeSummary(shapesOf(r.Submissions), s.axes)
	// A round concludes once, so this is the one place history grows.
	s.history = append(s.history, HistoryEntry{
		Number: r.Number, Title: r.Title, Link: r.Link, Description: r.Description, Summary: r.Summary,
	})
	s.persistLocked()
	s.broadcastStateLocked()
}

// join adds the client, reporting false if the session is closed or already at
// capacity — the caller must close the connection in that case.
func (s *Session) join(c *Client) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return false
	}
	if len(s.clients) >= s.hub.limits.MaxClientsPerSession {
		return false
	}
	// The organizer only observes, so they never consume a colour.
	if !c.organizer && c.color == "" {
		c.color = s.freeColorLocked(c)
	}
	s.clients[c] = true
	s.persistLocked()
	s.broadcastStateLocked()
	return true
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
	Color     string `json:"color,omitempty"`
	Organizer bool   `json:"organizer"`
	Submitted bool   `json:"submitted"`
	Responded bool   `json:"responded"`
}

type FinalSummary struct {
	Issues      []HistoryEntry `json:"issues"`
	TotalPoints int            `json:"totalPoints"`
}

type RoundView struct {
	Number         int          `json:"number"`
	Title          string       `json:"title"`
	Link           string       `json:"link,omitempty"`
	Description    string       `json:"description,omitempty"`
	Open           bool         `json:"open"`
	DeadlineMs     int64        `json:"deadlineMs,omitempty"`
	PausedMs       int64        `json:"pausedMs,omitempty"`
	SubmittedCount int          `json:"submittedCount"`
	Average        []float64    `json:"average,omitempty"`
	LiveShapes     []NamedShape `json:"liveShapes,omitempty"`
	Summary        *Summary     `json:"summary,omitempty"`
}

type StateView struct {
	Type         string            `json:"type"`
	Code         string            `json:"code"`
	Axes         []string          `json:"axes"`
	AxisMax      float64           `json:"axisMax"`
	AxisMins     []float64         `json:"axisMins"`
	AxisMaxes    []float64         `json:"axisMaxes"`
	PointLabels  []string          `json:"pointLabels"`
	Participants []ParticipantView `json:"participants"`
	QueuedItems  int               `json:"queuedItems"`
	Round        *RoundView        `json:"round,omitempty"`
	FinalSummary *FinalSummary     `json:"finalSummary,omitempty"`
	// History is sent to the organizer only — participants estimate the
	// issue in front of them and shouldn't be anchored by past results.
	History []HistoryEntry `json:"history,omitempty"`
}

func (s *Session) broadcastStateLocked() {
	sv := StateView{
		Type: "state", Code: s.Code, Axes: s.axes, AxisMax: AxisMax,
		AxisMins: s.axisMins, AxisMaxes: s.axisMaxes,
		PointLabels: s.pointLabels,
		QueuedItems: len(s.items) - s.nextItem,
	}
	for c := range s.clients {
		submitted := false
		responded := false
		if s.round != nil {
			if submission := s.round.Submissions[c.id]; submission != nil {
				submitted = true
				responded = submission.Touched
			}
		}
		sv.Participants = append(sv.Participants, ParticipantView{
			ID: c.id, Name: c.name, Color: c.color,
			Organizer: c.organizer, Submitted: submitted, Responded: responded,
		})
	}
	if r := s.round; r != nil {
		rv := &RoundView{
			Number:         r.Number,
			Title:          r.Title,
			Link:           r.Link,
			Description:    r.Description,
			Open:           r.Open,
			SubmittedCount: len(r.Submissions),
			Summary:        r.Summary,
		}
		if r.Deadline != nil {
			rv.DeadlineMs = r.Deadline.UnixMilli()
		}
		if r.Paused > 0 {
			rv.PausedMs = r.Paused.Milliseconds()
		}
		// Live group average while the round is open (revealed as it forms).
		if r.Open && len(r.Submissions) > 0 {
			rv.Average = axisAverages(shapesOf(r.Submissions), len(s.axes))
		}
		sv.Round = rv
	}
	if s.finalSummaryShown {
		sv.FinalSummary = finalSummaryOf(s.history)
	}
	for c := range s.clients {
		view := sv
		if c.organizer {
			view.History = s.history
			if sv.Round != nil && s.round.Open {
				round := *sv.Round
				round.LiveShapes = shapesOf(s.round.Previews)
				view.Round = &round
			}
		} else if sv.Round != nil && !sv.Round.Open && sv.Round.Summary != nil {
			round := *sv.Round
			round.Summary = anonymizeSummary(sv.Round.Summary)
			view.Round = &round
		}
		if !c.organizer && sv.FinalSummary != nil {
			view.FinalSummary = anonymizeFinalSummary(sv.FinalSummary)
		}
		c.trySend(mustJSON(view))
	}
}

func finalSummaryOf(history []HistoryEntry) *FinalSummary {
	issues := append([]HistoryEntry(nil), history...)
	final := &FinalSummary{Issues: issues}
	for _, issue := range issues {
		if issue.Summary != nil {
			final.TotalPoints += issue.Summary.StoryPoints
		}
	}
	return final
}

func anonymizeFinalSummary(final *FinalSummary) *FinalSummary {
	copy := *final
	copy.Issues = make([]HistoryEntry, len(final.Issues))
	for i, issue := range final.Issues {
		copy.Issues[i] = issue
		if issue.Summary != nil {
			copy.Issues[i].Summary = anonymizeSummary(issue.Summary)
		}
	}
	return &copy
}

func anonymizeSummary(summary *Summary) *Summary {
	copy := *summary
	copy.Shapes = make([]NamedShape, len(summary.Shapes))
	for i, shape := range summary.Shapes {
		copy.Shapes[i] = shape
		copy.Shapes[i].ID = ""
		copy.Shapes[i].Name = fmt.Sprintf("Anonymous response %d", i+1)
	}
	copy.Outliers = append([]Outlier(nil), summary.Outliers...)
	for i := range copy.Outliers {
		copy.Outliers[i].Name = "A teammate"
	}
	copy.Observations = append([]string(nil), summary.Observations...)
	for _, shape := range summary.Shapes {
		for j := range copy.Observations {
			copy.Observations[j] = strings.ReplaceAll(copy.Observations[j], shape.Name, "a teammate")
		}
	}
	return &copy
}

// ---------------------------------------------------------------------------
// WS handshake

func (h *Hub) HandleWS(w http.ResponseWriter, r *http.Request) {
	ip := h.clientIP(r)
	// Reserve the slot before upgrading: refusing with a plain HTTP status is
	// cheaper than completing a handshake only to close it.
	if !h.acquireConn(ip) {
		http.Error(w, "too many connections from this address", http.StatusTooManyRequests)
		return
	}
	released := false
	release := func() {
		if !released {
			released = true
			h.releaseConn(ip)
		}
	}
	defer release()

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	// This read happens before any Client exists, so it is the one an
	// unauthenticated caller reaches first — cap it before reading a byte.
	conn.SetReadLimit(maxMessageBytes)
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
		closeWith(conn, "A nickname is required to join a session.")
		return
	}
	if len(name) > maxNameLen {
		name = name[:maxNameLen]
	}

	var s *Session
	organizer := false
	switch hello.Type {
	case "create":
		s = h.create(ip)
		if s == nil {
			closeWith(conn, "This server is at capacity. Try again in a few minutes.")
			return
		}
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
		ip:        ip,
		name:      name,
		organizer: organizer,
		session:   s,
		conn:      conn,
		send:      make(chan []byte, sendBufferSize),
	}

	welcome := map[string]any{
		"type": "joined", "code": s.Code, "selfId": c.id,
		"organizer": organizer, "axes": s.axes, "axisMax": AxisMax,
		"axisMins": s.axisMins, "axisMaxes": s.axisMaxes, "pointLabels": s.pointLabels,
		"colors": ShapeColors,
	}
	if organizer {
		welcome["organizerToken"] = s.organizerToken
	}
	c.send <- mustJSON(welcome)

	go c.writePump()
	if !s.join(c) {
		closeWith(conn, "That session is full.")
		return
	}
	// readPump owns the connection from here; it releases the slot when the
	// socket drops, so the deferred release must not fire first.
	released = true
	defer h.releaseConn(ip)
	c.readPump()
}

// clientIP resolves the caller's address. Behind Fly's proxy the socket peer is
// the proxy, so the real address arrives in a header — but headers are
// caller-supplied and trivially spoofed when the app is reachable directly, so
// they are only honoured when the deployment says it sits behind a proxy.
func (h *Hub) clientIP(r *http.Request) string {
	if h.limits.TrustProxyHeaders {
		if ip := strings.TrimSpace(r.Header.Get("Fly-Client-IP")); ip != "" {
			return ip
		}
		if forwarded := r.Header.Get("X-Forwarded-For"); forwarded != "" {
			// Left-most entry is the original client; the rest are proxies.
			if ip := strings.TrimSpace(strings.Split(forwarded, ",")[0]); ip != "" {
				return ip
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
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

func defaultAxisValues(value float64) []float64 {
	values := make([]float64, len(DefaultAxes))
	for i := range values {
		values[i] = value
	}
	return values
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
