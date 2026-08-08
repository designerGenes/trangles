package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/gorilla/websocket"
)

type recordingStore struct {
	mu        sync.Mutex
	snapshots []SessionSnapshot
	deleted   []string
}

func (s *recordingStore) Save(snapshot SessionSnapshot) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.snapshots = append(s.snapshots, snapshot)
	return nil
}

func (s *recordingStore) Delete(code string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.deleted = append(s.deleted, code)
	return nil
}

func newTestSession(t *testing.T, store SessionStore) (*Hub, *Session, *Client, *Client) {
	t.Helper()
	hub := NewHubWithStore(store)
	session := hub.create()
	organizer := &Client{id: "organizer", name: "Ada", organizer: true, session: session, send: make(chan []byte, 64)}
	guest := &Client{id: "guest", name: "Lin", session: session, send: make(chan []byte, 64)}
	session.join(organizer)
	session.join(guest)
	drain(organizer)
	drain(guest)
	return hub, session, organizer, guest
}

func drain(client *Client) {
	for {
		select {
		case <-client.send:
		default:
			return
		}
	}
}

func expectError(t *testing.T, client *Client) {
	t.Helper()
	select {
	case data := <-client.send:
		var msg map[string]any
		if err := json.Unmarshal(data, &msg); err != nil {
			t.Fatal(err)
		}
		if msg["type"] != "error" {
			t.Fatalf("expected error, got %v", msg)
		}
	default:
		t.Fatal("expected an error response")
	}
}

func TestLoadIssuesConfiguresDefaultAndCustomAspects(t *testing.T) {
	_, session, organizer, guest := newTestSession(t, nil)

	session.handle(guest, &inboundMsg{Type: "load_items", Items: []string{"PROJ-1"}})
	expectError(t, guest)

	session.handle(organizer, &inboundMsg{Type: "load_items", Items: []string{"  PROJ-1 first  ", "", "PROJ-2 second"}})
	if got, want := session.items, []string{"PROJ-1 first", "PROJ-2 second"}; !sameStrings(got, want) {
		t.Fatalf("items = %#v, want %#v", got, want)
	}
	if !sameStrings(session.axes, DefaultAxes) {
		t.Fatalf("default aspects = %#v", session.axes)
	}

	session.handle(organizer, &inboundMsg{
		Type: "load_items", Items: []string{"PROJ-3"}, Aspects: []string{"Risk", "Impact", "Effort", "Reach"},
	})
	if got, want := session.axes, []string{"Risk", "Impact", "Effort", "Reach"}; !sameStrings(got, want) {
		t.Fatalf("custom aspects = %#v, want %#v", got, want)
	}

	drain(organizer)
	session.handle(organizer, &inboundMsg{Type: "load_items", Items: []string{"PROJ-4"}, Aspects: []string{"Only one"}})
	expectError(t, organizer)
	if len(session.axes) != 4 {
		t.Fatalf("invalid custom aspects changed the schema: %#v", session.axes)
	}
	if aspects, err := cleanAspects([]string{"A", "B", "C", "D", "E", "F", "G", "H"}); err != nil || len(aspects) != 8 {
		t.Fatalf("eight custom aspects should be accepted: %#v, %v", aspects, err)
	}
	if _, err := cleanAspects([]string{"A", "B", "C", "D", "E", "F", "G", "H", "I"}); err == nil {
		t.Fatal("more than eight custom aspects should be rejected")
	}
}

func TestPointingRoundClampsSubmissionsAndCalculatesSummary(t *testing.T) {
	_, session, organizer, guest := newTestSession(t, nil)
	session.handle(organizer, &inboundMsg{Type: "load_items", Items: []string{"PROJ-1", "PROJ-2"}})
	session.handle(organizer, &inboundMsg{Type: "start_round"})
	if session.round == nil || session.round.Title != "PROJ-1" || session.nextItem != 1 {
		t.Fatalf("first queued round was not started: %#v", session.round)
	}

	session.handle(guest, &inboundMsg{Type: "submit", Values: []float64{-4, 5, 20}})
	session.handle(organizer, &inboundMsg{Type: "submit", Values: []float64{4, 7, 2}})
	if got := session.round.Submissions[guest.id].Values; !sameValues(got, []float64{0, 5, 10}) {
		t.Fatalf("submission was not clamped: %#v", got)
	}

	session.handle(organizer, &inboundMsg{Type: "end_round"})
	if session.round.Open || session.round.Summary == nil {
		t.Fatal("round did not conclude with a summary")
	}
	if got := session.round.Summary.Averages; !sameValues(got, []float64{2, 6, 6}) {
		t.Fatalf("averages = %#v", got)
	}
	if session.round.Summary.StoryPoints < 1 || session.round.Summary.StoryPoints > 13 {
		t.Fatalf("invalid story-point score: %d", session.round.Summary.StoryPoints)
	}

	session.handle(organizer, &inboundMsg{Type: "start_round"})
	if session.round.Title != "PROJ-2" || session.round.Number != 2 {
		t.Fatalf("second queued round was not started: %#v", session.round)
	}
}

func TestAspectBoundsClampLivePreviewsAndStayOrganizerOnly(t *testing.T) {
	_, session, organizer, guest := newTestSession(t, nil)
	session.handle(organizer, &inboundMsg{
		Type: "load_items", Items: []string{"PROJ-1"}, Aspects: []string{"Risk", "Reach"},
		Mins: []float64{2, 10}, Maxes: []float64{6, 20},
	})
	if !sameValues(session.axisMins, []float64{2, 10}) || !sameValues(session.axisMaxes, []float64{6, 20}) {
		t.Fatalf("aspect bounds = %#v / %#v", session.axisMins, session.axisMaxes)
	}
	session.handle(organizer, &inboundMsg{Type: "start_round"})
	drain(organizer)
	drain(guest)
	session.handle(guest, &inboundMsg{Type: "preview", Values: []float64{-1, 30}})
	if got := session.round.Previews[guest.id].Values; !sameValues(got, []float64{2, 20}) {
		t.Fatalf("preview was not clamped: %#v", got)
	}

	organizerState := readState(t, organizer)
	guestState := readState(t, guest)
	if len(organizerState.Round.LiveShapes) != 1 || organizerState.Round.LiveShapes[0].ID != guest.id {
		t.Fatalf("organizer live shapes = %#v", organizerState.Round.LiveShapes)
	}
	if len(guestState.Round.LiveShapes) != 0 {
		t.Fatalf("guest received organizer-only previews: %#v", guestState.Round.LiveShapes)
	}
}

func TestWebSocketRequiresNickname(t *testing.T) {
	hub := NewHub()
	server := httptest.NewServer(http.HandlerFunc(hub.HandleWS))
	defer server.Close()
	url := "ws" + strings.TrimPrefix(server.URL, "http")
	conn := dialSession(t, url, map[string]any{"type": "create", "name": "  "})
	defer conn.Close()
	msg := readUntil(t, conn, func(msg map[string]any) bool { return msg["type"] == "error" })
	if msg["fatal"] != "true" || !strings.Contains(msg["message"].(string), "nickname") {
		t.Fatalf("unexpected missing-name response: %#v", msg)
	}
}

func TestOrganizerOnlyActions(t *testing.T) {
	_, session, organizer, guest := newTestSession(t, nil)
	session.handle(guest, &inboundMsg{Type: "start_round", Title: "PROJ-1"})
	expectError(t, guest)
	session.handle(organizer, &inboundMsg{Type: "start_round", Title: "PROJ-1"})
	drain(guest)
	session.handle(guest, &inboundMsg{Type: "end_round"})
	expectError(t, guest)
	session.handle(guest, &inboundMsg{Type: "close_session"})
	expectError(t, guest)
}

func TestLastLeaveRemovesCachedSession(t *testing.T) {
	store := &recordingStore{}
	hub, session, organizer, _ := newTestSession(t, store)
	session.leave(organizer)
	if hub.get(session.Code) == nil {
		t.Fatal("session was removed while another participant remained")
	}
	guest := &Client{id: "last", name: "Last", session: session, send: make(chan []byte, 1)}
	session.join(guest)
	session.leave(guest)
	// The original guest is still connected, so leave it last.
	for client := range session.clients {
		session.leave(client)
	}
	if hub.get(session.Code) != nil {
		t.Fatal("empty session was not removed from the hub")
	}
	store.mu.Lock()
	deletes := append([]string(nil), store.deleted...)
	store.mu.Unlock()
	if len(deletes) != 1 || deletes[0] != session.Code {
		t.Fatalf("cache deletes = %#v, want %q", deletes, session.Code)
	}
}

func TestRedisSessionStoreSavesAndDeletesSnapshots(t *testing.T) {
	server, err := miniredis.Run()
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	store, err := NewRedisSessionStore("redis://" + server.Addr())
	if err != nil {
		t.Fatal(err)
	}
	snapshot := SessionSnapshot{Code: "ABCDE", Items: []string{"PROJ-1"}, Axes: []string{"Risk", "Impact"}}
	if err := store.Save(snapshot); err != nil {
		t.Fatal(err)
	}
	raw, err := server.Get(redisKeyPrefix + snapshot.Code)
	if err != nil {
		t.Fatal(err)
	}
	var cached SessionSnapshot
	if err := json.Unmarshal([]byte(raw), &cached); err != nil {
		t.Fatal(err)
	}
	if !sameStrings(cached.Axes, snapshot.Axes) || !sameStrings(cached.Items, snapshot.Items) {
		t.Fatalf("cached snapshot = %#v", cached)
	}
	if err := store.Delete(snapshot.Code); err != nil {
		t.Fatal(err)
	}
	if server.Exists(redisKeyPrefix + snapshot.Code) {
		t.Fatal("Redis key remains after session deletion")
	}
}

func TestWebSocketPointingSession(t *testing.T) {
	hub := NewHub()
	server := httptest.NewServer(http.HandlerFunc(hub.HandleWS))
	defer server.Close()
	url := "ws" + strings.TrimPrefix(server.URL, "http")

	organizer := dialSession(t, url, map[string]any{"type": "create", "name": "Ada"})
	defer organizer.Close()
	joined := readUntil(t, organizer, func(msg map[string]any) bool { return msg["type"] == "joined" })
	code := joined["code"].(string)
	guest := dialSession(t, url, map[string]any{"type": "join", "name": "Lin", "code": code})
	defer guest.Close()
	readUntil(t, guest, func(msg map[string]any) bool { return msg["type"] == "joined" })

	writeWS(t, organizer, map[string]any{"type": "load_items", "items": []string{"PROJ-1"}, "aspects": []string{"Risk", "Impact"}})
	readUntil(t, organizer, func(msg map[string]any) bool {
		return msg["type"] == "state" && len(msg["axes"].([]any)) == 2
	})
	writeWS(t, organizer, map[string]any{"type": "start_round"})
	readUntil(t, organizer, func(msg map[string]any) bool {
		round, ok := msg["round"].(map[string]any)
		return msg["type"] == "state" && ok && round["title"] == "PROJ-1"
	})
	writeWS(t, guest, map[string]any{"type": "submit", "values": []float64{3, 7}})
	writeWS(t, organizer, map[string]any{"type": "submit", "values": []float64{5, 5}})
	writeWS(t, organizer, map[string]any{"type": "end_round"})
	readUntil(t, organizer, func(msg map[string]any) bool {
		round, ok := msg["round"].(map[string]any)
		if !ok || msg["type"] != "state" || round["open"] != false {
			return false
		}
		_, hasSummary := round["summary"]
		return hasSummary
	})
	writeWS(t, organizer, map[string]any{"type": "close_session"})
	readUntil(t, organizer, func(msg map[string]any) bool { return msg["type"] == "closed" })
	deadline := time.Now().Add(time.Second)
	for hub.get(code) != nil && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if hub.get(code) != nil {
		t.Fatal("closed WebSocket session remains in the hub")
	}
}

func dialSession(t *testing.T, url string, hello map[string]any) *websocket.Conn {
	t.Helper()
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatal(err)
	}
	writeWS(t, conn, hello)
	return conn
}

func writeWS(t *testing.T, conn *websocket.Conn, value any) {
	t.Helper()
	if err := conn.WriteJSON(value); err != nil {
		t.Fatal(err)
	}
}

func readUntil(t *testing.T, conn *websocket.Conn, match func(map[string]any) bool) map[string]any {
	t.Helper()
	for range 20 {
		_ = conn.SetReadDeadline(time.Now().Add(time.Second))
		_, data, err := conn.ReadMessage()
		if err != nil {
			t.Fatal(err)
		}
		var msg map[string]any
		if err := json.Unmarshal(data, &msg); err != nil {
			t.Fatal(err)
		}
		if match(msg) {
			return msg
		}
	}
	t.Fatal("did not receive the expected WebSocket message")
	return nil
}

func readState(t *testing.T, client *Client) StateView {
	t.Helper()
	select {
	case data := <-client.send:
		var state StateView
		if err := json.Unmarshal(data, &state); err != nil {
			t.Fatal(err)
		}
		if state.Type != "state" {
			t.Fatalf("expected state, got %#v", state)
		}
		return state
	default:
		t.Fatal("expected a state broadcast")
		return StateView{}
	}
}

func sameStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func sameValues(a, b []float64) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
