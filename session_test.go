package main

import (
	"encoding/json"
	"fmt"
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
	session := hub.create("test")
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

	session.handle(guest, &inboundMsg{Type: "load_items", Items: testItems("PROJ-1")})
	expectError(t, guest)

	session.handle(organizer, &inboundMsg{Type: "load_items", Items: testItems("  PROJ-1 first  ", "", "PROJ-2 second")})
	if got, want := itemTitles(session.items), []string{"PROJ-1 first", "PROJ-2 second"}; !sameStrings(got, want) {
		t.Fatalf("items = %#v, want %#v", got, want)
	}
	if !sameStrings(session.axes, DefaultAxes) {
		t.Fatalf("default aspects = %#v", session.axes)
	}

	session.handle(organizer, &inboundMsg{
		Type: "load_items", Items: testItems("PROJ-3"), Aspects: []string{"Risk", "Impact", "Effort", "Reach"},
	})
	if got, want := session.axes, []string{"Risk", "Impact", "Effort", "Reach"}; !sameStrings(got, want) {
		t.Fatalf("custom aspects = %#v, want %#v", got, want)
	}

	drain(organizer)
	session.handle(organizer, &inboundMsg{Type: "load_items", Items: testItems("PROJ-4"), Aspects: []string{"Only one"}})
	expectError(t, organizer)
	if len(session.axes) != 4 {
		t.Fatalf("invalid custom aspects changed the schema: %#v", session.axes)
	}
	if aspects, err := cleanAspects([]string{"A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"}); err != nil || len(aspects) != 12 {
		t.Fatalf("twelve custom aspects should be accepted: %#v, %v", aspects, err)
	}
	if _, err := cleanAspects([]string{"A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M"}); err == nil {
		t.Fatal("more than twelve custom aspects should be rejected")
	}
}

func TestPointingRoundClampsSubmissionsAndCalculatesSummary(t *testing.T) {
	_, session, organizer, guest := newTestSession(t, nil)
	session.handle(organizer, &inboundMsg{Type: "load_items", Items: testItems("PROJ-1", "PROJ-2")})
	session.handle(organizer, &inboundMsg{Type: "start_round"})
	if session.round == nil || session.round.Title != "PROJ-1" || session.nextItem != 1 {
		t.Fatalf("first queued round was not started: %#v", session.round)
	}

	session.handle(guest, &inboundMsg{Type: "submit", Values: []float64{-4, 5, 20}})
	session.handle(organizer, &inboundMsg{Type: "submit", Values: []float64{4, 7, 2}})
	if got := session.round.Submissions[guest.id].Values; !sameValues(got, []float64{1, 5, 8}) {
		t.Fatalf("submission was not clamped: %#v", got)
	}

	session.handle(organizer, &inboundMsg{Type: "end_round"})
	if session.round.Open || session.round.Summary == nil {
		t.Fatal("round did not conclude with a summary")
	}
	if got := session.round.Summary.Averages; !sameValues(got, []float64{2.5, 6, 5}) {
		t.Fatalf("averages = %#v", got)
	}
	if session.round.Summary.StoryPoints < 1 || session.round.Summary.StoryPoints > 13 {
		t.Fatalf("invalid story-point score: %d", session.round.Summary.StoryPoints)
	}

	session.handle(organizer, &inboundMsg{Type: "start_round"})
	if session.round.Title != "PROJ-2" || session.round.Number != 2 {
		t.Fatalf("second queued round was not started: %#v", session.round)
	}
	if len(session.round.Submissions) != 0 || len(session.round.Previews) != 0 {
		t.Fatalf("second round inherited estimates: %#v / %#v", session.round.Submissions, session.round.Previews)
	}
}

func TestOrganizerCanStartTimerDuringOpenRound(t *testing.T) {
	_, session, organizer, _ := newTestSession(t, nil)
	session.handle(organizer, &inboundMsg{Type: "load_items", Items: testItems("PROJ-1")})
	session.handle(organizer, &inboundMsg{Type: "start_round"})
	session.handle(organizer, &inboundMsg{Type: "set_timer", Seconds: 30})
	if session.round.Deadline == nil || session.round.timer == nil {
		t.Fatal("open round did not receive a timer")
	}
	session.round.timer.Stop()
}

func TestTimerExpirySubmitsCurrentOrDefaultChartsWithoutAdvancing(t *testing.T) {
	_, session, organizer, guest := newTestSession(t, nil)
	session.handle(organizer, &inboundMsg{Type: "load_items", Items: testItems("PROJ-1", "PROJ-2")})
	session.handle(organizer, &inboundMsg{Type: "start_round"})
	session.handle(guest, &inboundMsg{Type: "preview", Values: []float64{4, 3, 2}, Touched: true})
	session.timerFired(session.round)
	if session.round.Open || session.nextItem != 1 {
		t.Fatalf("timer advanced the queue: round=%#v next=%d", session.round, session.nextItem)
	}
	submission := session.round.Submissions[guest.id]
	if !sameValues(submission.Values, []float64{4, 3, 2}) || !submission.Touched {
		t.Fatalf("timer did not preserve preview: %#v", submission)
	}

	_, secondSession, secondOrganizer, secondGuest := newTestSession(t, nil)
	secondSession.handle(secondOrganizer, &inboundMsg{Type: "load_items", Items: testItems("PROJ-1")})
	secondSession.handle(secondOrganizer, &inboundMsg{Type: "start_round"})
	secondSession.timerFired(secondSession.round)
	defaultSubmission := secondSession.round.Submissions[secondGuest.id]
	if !sameValues(defaultSubmission.Values, []float64{3, 3, 3}) || defaultSubmission.Touched {
		t.Fatalf("timer default submission = %#v", defaultSubmission)
	}
}

func TestRestartRoundAndSessionLifecycle(t *testing.T) {
	hub, session, organizer, guest := newTestSession(t, nil)
	code := session.Code
	session.handle(organizer, &inboundMsg{Type: "load_items", Items: testItems("PROJ-1", "PROJ-2")})
	session.handle(organizer, &inboundMsg{Type: "start_round"})
	session.handle(guest, &inboundMsg{Type: "submit", Values: []float64{3, 3, 3}})
	session.handle(organizer, &inboundMsg{Type: "end_round"})
	session.handle(organizer, &inboundMsg{Type: "restart_round"})
	if !session.round.Open || len(session.round.Submissions) != 0 || len(session.history) != 0 {
		t.Fatalf("round restart state = %#v / %#v", session.round, session.history)
	}
	session.handle(organizer, &inboundMsg{Type: "end_round"})
	session.handle(organizer, &inboundMsg{Type: "start_round"})
	session.handle(organizer, &inboundMsg{Type: "end_round"})
	session.handle(organizer, &inboundMsg{Type: "show_final_summary"})
	drain(organizer)
	drain(guest)
	session.broadcastStateLocked()
	organizerState := readState(t, organizer)
	guestState := readState(t, guest)
	if organizerState.FinalSummary == nil || guestState.FinalSummary == nil {
		t.Fatal("final summary was not broadcast")
	}
	session.handle(organizer, &inboundMsg{Type: "restart_session"})
	if session.round == nil || !session.round.Open || session.round.Title != "PROJ-1" || len(session.history) != 0 {
		t.Fatalf("session restart state = %#v / %#v", session.round, session.history)
	}
	if session.Code != code || hub.get(code) != session {
		t.Fatal("session restart changed the session code")
	}

	session.handle(organizer, &inboundMsg{Type: "end_round"})
	session.handle(organizer, &inboundMsg{Type: "start_round"})
	session.handle(organizer, &inboundMsg{Type: "end_round"})
	session.handle(organizer, &inboundMsg{Type: "show_final_summary"})
	session.leave(guest)
	if hub.get(code) == nil {
		t.Fatal("session was removed while organizer remained in final summary")
	}
	returning := &Client{id: "returning", name: "Lin", session: session, send: make(chan []byte, 8)}
	session.join(returning)
	if !session.clients[returning] {
		t.Fatal("participant could not rejoin final summary session")
	}
}

func TestIssueMetadataAndSubmittedEstimatesAreImmutable(t *testing.T) {
	_, session, organizer, guest := newTestSession(t, nil)
	item := Item{Title: "PROJ-1", Link: "https://example.test/PROJ-1", Description: "Investigate the migration path."}
	session.handle(organizer, &inboundMsg{Type: "load_items", Items: []Item{item}})
	session.handle(organizer, &inboundMsg{Type: "start_round"})
	if session.round.Link != item.Link || session.round.Description != item.Description {
		t.Fatalf("round metadata = %#v", session.round)
	}
	drain(guest)
	session.handle(guest, &inboundMsg{Type: "submit", Values: []float64{2, 3, 4}})
	drain(guest)
	session.handle(guest, &inboundMsg{Type: "submit", Values: []float64{8, 8, 8}})
	expectError(t, guest)
	if got := session.round.Submissions[guest.id].Values; !sameValues(got, []float64{2, 3, 4}) {
		t.Fatalf("submitted estimate changed: %#v", got)
	}
}

func TestReminderTargetsOnlyUnsubmittedParticipants(t *testing.T) {
	_, session, organizer, guest := newTestSession(t, nil)
	session.handle(organizer, &inboundMsg{Type: "load_items", Items: testItems("PROJ-1")})
	session.handle(organizer, &inboundMsg{Type: "start_round"})
	drain(organizer)
	drain(guest)
	session.handle(organizer, &inboundMsg{Type: "remind"})
	select {
	case data := <-guest.send:
		var msg map[string]string
		if err := json.Unmarshal(data, &msg); err != nil {
			t.Fatal(err)
		}
		if msg["type"] != "reminder" {
			t.Fatalf("reminder = %#v", msg)
		}
	default:
		t.Fatal("unsubmitted participant did not receive a reminder")
	}
}

func TestParticipantSummaryAnonymizesPeerSubmissions(t *testing.T) {
	_, session, organizer, guest := newTestSession(t, nil)
	session.handle(organizer, &inboundMsg{Type: "load_items", Items: testItems("PROJ-1")})
	session.handle(organizer, &inboundMsg{Type: "start_round"})
	drain(organizer)
	drain(guest)
	session.handle(guest, &inboundMsg{Type: "submit", Values: []float64{2, 3, 4}})
	session.handle(organizer, &inboundMsg{Type: "submit", Values: []float64{4, 5, 6}})
	drain(organizer)
	drain(guest)
	session.handle(organizer, &inboundMsg{Type: "end_round"})
	organizerState := readState(t, organizer)
	guestState := readState(t, guest)
	if organizerState.Round.Summary.Shapes[0].Name == "Anonymous response 1" {
		t.Fatal("organizer summary was anonymized")
	}
	for _, shape := range guestState.Round.Summary.Shapes {
		if !strings.HasPrefix(shape.Name, "Anonymous response") || shape.ID != "" {
			t.Fatalf("participant shape is identifiable: %#v", shape)
		}
	}
}

func TestSharedWholePointRangeClampsLivePreviewsAndStaysOrganizerOnly(t *testing.T) {
	_, session, organizer, guest := newTestSession(t, nil)
	session.handle(organizer, &inboundMsg{
		Type: "load_items", Items: testItems("PROJ-1"), Aspects: []string{"Risk", "Reach"},
		Max: 20, PointLabels: []string{"", "Light", "", "Heavy"},
	})
	if !sameValues(session.axisMins, []float64{1, 1}) || !sameValues(session.axisMaxes, []float64{20, 20}) {
		t.Fatalf("point range = %#v / %#v", session.axisMins, session.axisMaxes)
	}
	if session.pointLabels[1] != "Light" || session.pointLabels[20] != "Heavy" {
		t.Fatalf("point labels = %#v", session.pointLabels)
	}
	session.handle(organizer, &inboundMsg{Type: "start_round"})
	drain(organizer)
	drain(guest)
	session.handle(guest, &inboundMsg{Type: "preview", Values: []float64{-1, 7.6}})
	if got := session.round.Previews[guest.id].Values; !sameValues(got, []float64{1, 8}) {
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

func TestPointMaximumMustBeWholeNumber(t *testing.T) {
	_, session, organizer, _ := newTestSession(t, nil)
	session.handle(organizer, &inboundMsg{Type: "load_items", Items: testItems("PROJ-1"), Max: 4.5})
	expectError(t, organizer)
	if !sameValues(session.axisMins, []float64{1, 1, 1}) || !sameValues(session.axisMaxes, []float64{8, 8, 8}) {
		t.Fatalf("invalid max changed range: %#v / %#v", session.axisMins, session.axisMaxes)
	}
}

func TestReplacingQueuePreservesAspectConfiguration(t *testing.T) {
	_, session, organizer, _ := newTestSession(t, nil)
	session.handle(organizer, &inboundMsg{
		Type: "load_items", Items: testItems("PROJ-1"), Aspects: []string{"Risk", "Reach"}, Max: 7,
	})
	session.handle(organizer, &inboundMsg{Type: "replace_items", Items: testItems("PROJ-2", "PROJ-3")})
	if got, want := itemTitles(session.items), []string{"PROJ-2", "PROJ-3"}; !sameStrings(got, want) {
		t.Fatalf("replacement items = %#v, want %#v", got, want)
	}
	if !sameStrings(session.axes, []string{"Risk", "Reach"}) || !sameValues(session.axisMaxes, []float64{7, 7}) {
		t.Fatalf("queue replacement changed aspect configuration: %#v / %#v", session.axes, session.axisMaxes)
	}
}

func TestAppendingQueuePreservesCurrentAndQueuedIssues(t *testing.T) {
	_, session, organizer, _ := newTestSession(t, nil)
	session.handle(organizer, &inboundMsg{Type: "load_items", Items: testItems("PROJ-1", "PROJ-2")})
	session.handle(organizer, &inboundMsg{Type: "start_round"})
	session.handle(organizer, &inboundMsg{Type: "append_items", Items: testItems("PROJ-3", "PROJ-4")})
	if got, want := itemTitles(session.items), []string{"PROJ-1", "PROJ-2", "PROJ-3", "PROJ-4"}; !sameStrings(got, want) {
		t.Fatalf("appended queue = %#v, want %#v", got, want)
	}
	if session.round.Title != "PROJ-1" || session.nextItem != 1 {
		t.Fatalf("append changed current issue: %#v / next=%d", session.round, session.nextItem)
	}
	queuedID := session.items[2].ID
	session.handle(organizer, &inboundMsg{Type: "delete_queued_item", ItemID: queuedID})
	if got, want := itemTitles(session.items), []string{"PROJ-1", "PROJ-2", "PROJ-4"}; !sameStrings(got, want) {
		t.Fatalf("queued deletion = %#v, want %#v", got, want)
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
	snapshot := SessionSnapshot{Code: "ABCDE", Items: testItems("PROJ-1"), Axes: []string{"Risk", "Impact"}}
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
	if !sameStrings(cached.Axes, snapshot.Axes) || !sameStrings(itemTitles(cached.Items), itemTitles(snapshot.Items)) {
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

	writeWS(t, organizer, map[string]any{"type": "load_items", "items": []Item{{Title: "PROJ-1"}}, "aspects": []string{"Risk", "Impact"}})
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

func testItems(titles ...string) []Item {
	items := make([]Item, len(titles))
	for i, title := range titles {
		items[i] = Item{Title: title}
	}
	return items
}

func itemTitles(items []Item) []string {
	titles := make([]string, len(items))
	for i, item := range items {
		titles[i] = item.Title
	}
	return titles
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

func lastState(t *testing.T, client *Client) StateView {
	t.Helper()
	var view StateView
	found := false
	for {
		select {
		case data := <-client.send:
			var probe map[string]any
			if err := json.Unmarshal(data, &probe); err != nil {
				t.Fatal(err)
			}
			if probe["type"] != "state" {
				continue
			}
			if err := json.Unmarshal(data, &view); err != nil {
				t.Fatal(err)
			}
			found = true
		default:
			if !found {
				t.Fatal("expected a state broadcast")
			}
			return view
		}
	}
}

func TestConcludedRoundsBuildOrganizerOnlyHistory(t *testing.T) {
	store := &recordingStore{}
	_, session, organizer, guest := newTestSession(t, store)

	session.handle(organizer, &inboundMsg{Type: "load_items", Items: testItems("PROJ-1 first", "PROJ-2 second")})

	// Nothing has concluded yet, so there is no history to page through.
	drain(organizer)
	session.handle(organizer, &inboundMsg{Type: "start_round"})
	if view := lastState(t, organizer); len(view.History) != 0 {
		t.Fatalf("history before any round concluded = %#v", view.History)
	}

	session.handle(guest, &inboundMsg{Type: "submit", Values: []float64{5, 4, 3}})
	session.handle(organizer, &inboundMsg{Type: "end_round"})

	view := lastState(t, organizer)
	if len(view.History) != 1 {
		t.Fatalf("history after one concluded round = %d entries", len(view.History))
	}
	entry := view.History[0]
	if entry.Title != "PROJ-1 first" || entry.Number != 1 {
		t.Fatalf("history entry = %+v", entry)
	}
	if entry.Summary == nil || len(entry.Summary.Shapes) != 1 {
		t.Fatalf("history entry lost its summary: %+v", entry.Summary)
	}

	// Participants must not receive it — past results would anchor them.
	if guestView := lastState(t, guest); len(guestView.History) != 0 {
		t.Fatalf("guest received history: %#v", guestView.History)
	}

	// A second round appends rather than replacing, oldest first.
	session.handle(organizer, &inboundMsg{Type: "start_round"})
	session.handle(guest, &inboundMsg{Type: "submit", Values: []float64{2, 2, 2}})
	session.handle(organizer, &inboundMsg{Type: "end_round"})
	view = lastState(t, organizer)
	if len(view.History) != 2 || view.History[0].Number != 1 || view.History[1].Number != 2 {
		t.Fatalf("history order = %#v", view.History)
	}

	store.mu.Lock()
	defer store.mu.Unlock()
	last := store.snapshots[len(store.snapshots)-1]
	if len(last.History) != 2 {
		t.Fatalf("snapshot history = %#v", last.History)
	}
}

func TestOversizedMessagesAreRejectedNotBuffered(t *testing.T) {
	hub := NewHub()
	server := httptest.NewServer(http.HandlerFunc(hub.HandleWS))
	defer server.Close()
	url := "ws" + strings.TrimPrefix(server.URL, "http")

	// An oversized frame on the pre-auth handshake must close the connection
	// rather than being read into memory.
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	huge := make([]byte, maxMessageBytes+1024)
	for i := range huge {
		huge[i] = 'a'
	}
	if err := conn.WriteMessage(websocket.TextMessage, huge); err != nil {
		t.Fatalf("write: %v", err)
	}
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, _, err := conn.ReadMessage(); err == nil {
		t.Fatal("expected the server to drop an oversized handshake")
	}

	// A normal-sized message on the same endpoint still works.
	good, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer good.Close()
	if err := good.WriteJSON(map[string]string{"type": "create", "name": "Ada"}); err != nil {
		t.Fatal(err)
	}
	good.SetReadDeadline(time.Now().Add(2 * time.Second))
	var welcome map[string]any
	if err := good.ReadJSON(&welcome); err != nil {
		t.Fatalf("normal handshake rejected: %v", err)
	}
	if welcome["type"] != "joined" {
		t.Fatalf("welcome = %v", welcome)
	}
}

// dialN opens n websockets against server and returns them plus the first
// non-nil dial error, so a test can assert exactly where the ceiling bites.
func dialN(t *testing.T, url string, n int, hello map[string]string) ([]*websocket.Conn, error) {
	t.Helper()
	conns := make([]*websocket.Conn, 0, n)
	for i := 0; i < n; i++ {
		conn, _, err := websocket.DefaultDialer.Dial(url, nil)
		if err != nil {
			return conns, err
		}
		if hello != nil {
			if err := conn.WriteJSON(hello); err != nil {
				return conns, err
			}
			var reply map[string]any
			conn.SetReadDeadline(time.Now().Add(2 * time.Second))
			if err := conn.ReadJSON(&reply); err != nil {
				return conns, err
			}
			if reply["type"] == "error" {
				return conns, fmt.Errorf("refused: %v", reply["message"])
			}
		}
		conns = append(conns, conn)
	}
	return conns, nil
}

func closeAll(conns []*websocket.Conn) {
	for _, c := range conns {
		_ = c.Close()
	}
}

func TestConnectionsPerIPAreCapped(t *testing.T) {
	limits := DefaultLimits
	limits.MaxConnectionsPerIP = 3
	limits.TrustProxyHeaders = false
	hub := NewHubWithLimits(nil, limits)
	server := httptest.NewServer(http.HandlerFunc(hub.HandleWS))
	defer server.Close()
	url := "ws" + strings.TrimPrefix(server.URL, "http")

	conns, err := dialN(t, url, 3, nil)
	defer closeAll(conns)
	if err != nil {
		t.Fatalf("first %d connections should be accepted: %v", limits.MaxConnectionsPerIP, err)
	}

	// The next one is refused at the HTTP layer, before any upgrade.
	if _, resp, err := websocket.DefaultDialer.Dial(url, nil); err == nil {
		t.Fatal("expected the connection over the cap to be refused")
	} else if resp == nil || resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("expected 429, got %v (%v)", resp, err)
	}

	// Slots are returned when a connection drops, not leaked.
	conns[0].Close()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if extra, _, err := websocket.DefaultDialer.Dial(url, nil); err == nil {
			extra.Close()
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("a released connection slot was never reusable")
}

func TestSessionCeilingsRefuseGracefully(t *testing.T) {
	limits := DefaultLimits
	limits.MaxSessions = 2
	limits.MaxSessionsPerIP = 5
	hub := NewHubWithLimits(nil, limits)

	first := hub.create("1.2.3.4")
	second := hub.create("1.2.3.4")
	if first == nil || second == nil {
		t.Fatal("sessions under the ceiling should be created")
	}
	if third := hub.create("1.2.3.4"); third != nil {
		t.Fatal("expected the global session ceiling to refuse a third session")
	}

	// Removing one frees global capacity again.
	hub.remove(first.Code)
	if again := hub.create("1.2.3.4"); again == nil {
		t.Fatal("capacity should be reusable after a session is removed")
	}
}

func TestSessionsPerIPAreCapped(t *testing.T) {
	limits := DefaultLimits
	limits.MaxSessionsPerIP = 2
	hub := NewHubWithLimits(nil, limits)

	if hub.create("9.9.9.9") == nil || hub.create("9.9.9.9") == nil {
		t.Fatal("sessions under the per-IP ceiling should be created")
	}
	if hub.create("9.9.9.9") != nil {
		t.Fatal("expected the per-IP session ceiling to refuse")
	}
	// A different caller is unaffected by that IP's usage.
	other := hub.create("8.8.8.8")
	if other == nil {
		t.Fatal("one noisy IP must not block everyone else")
	}
	// Freeing one of the first IP's sessions lets it create again.
	for code, s := range hub.sessions {
		if s.creatorIP == "9.9.9.9" {
			hub.remove(code)
			break
		}
	}
	if hub.create("9.9.9.9") == nil {
		t.Fatal("per-IP slot should be released when the session ends")
	}
}

func TestSessionRefusesClientsOverCapacity(t *testing.T) {
	limits := DefaultLimits
	limits.MaxClientsPerSession = 2
	hub := NewHubWithLimits(nil, limits)
	session := hub.create("test")

	a := &Client{id: "a", name: "Ada", session: session, send: make(chan []byte, 8)}
	b := &Client{id: "b", name: "Bo", session: session, send: make(chan []byte, 8)}
	c := &Client{id: "c", name: "Cy", session: session, send: make(chan []byte, 8)}
	if !session.join(a) || !session.join(b) {
		t.Fatal("clients under the ceiling should join")
	}
	if session.join(c) {
		t.Fatal("expected the session to refuse a client over capacity")
	}
	// Leaving frees a seat.
	session.leave(b)
	if !session.join(c) {
		t.Fatal("a seat should be reusable after someone leaves")
	}
}

func TestClientIPPrefersProxyHeaderOnlyWhenTrusted(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/ws", nil)
	request.RemoteAddr = "10.0.0.1:5555"
	request.Header.Set("Fly-Client-IP", "203.0.113.7")
	request.Header.Set("X-Forwarded-For", "198.51.100.9, 10.0.0.2")

	trusting := NewHubWithLimits(nil, Limits{TrustProxyHeaders: true})
	if got := trusting.clientIP(request); got != "203.0.113.7" {
		t.Fatalf("behind a proxy the real client IP should win, got %q", got)
	}

	// Reachable directly, the headers are attacker-controlled and must be
	// ignored or the per-IP caps are trivially bypassed.
	direct := NewHubWithLimits(nil, Limits{TrustProxyHeaders: false})
	if got := direct.clientIP(request); got != "10.0.0.1" {
		t.Fatalf("untrusted headers must be ignored, got %q", got)
	}

	noFly := httptest.NewRequest(http.MethodGet, "/ws", nil)
	noFly.RemoteAddr = "10.0.0.1:5555"
	noFly.Header.Set("X-Forwarded-For", "198.51.100.9, 10.0.0.2")
	if got := trusting.clientIP(noFly); got != "198.51.100.9" {
		t.Fatalf("left-most XFF entry is the client, got %q", got)
	}
}

// concludeSession runs a one-issue session to its final summary.
func concludeSession(t *testing.T, session *Session, organizer, guest *Client) {
	t.Helper()
	session.handle(organizer, &inboundMsg{Type: "load_items", Items: []Item{{Title: "PROJ-1"}}})
	session.handle(organizer, &inboundMsg{Type: "start_round"})
	session.handle(guest, &inboundMsg{Type: "submit", Values: []float64{2, 2, 2}})
	session.handle(organizer, &inboundMsg{Type: "end_round"})
	session.handle(organizer, &inboundMsg{Type: "show_final_summary"})
	if !session.finalSummaryShown {
		t.Fatal("session should have reached its final summary")
	}
}

func TestConcludedSessionRejectsQueueAndTimerChanges(t *testing.T) {
	_, session, organizer, guest := newTestSession(t, nil)
	concludeSession(t, session, organizer, guest)

	// The final total reports on a fixed set of rounds; nothing may change it.
	before := len(session.items)
	for _, msg := range []*inboundMsg{
		{Type: "append_items", Items: []Item{{Title: "PROJ-9 sneaked in"}}},
		{Type: "replace_items", Items: []Item{{Title: "PROJ-9 replacement"}}},
		{Type: "load_items", Items: []Item{{Title: "PROJ-9 reload"}}},
		{Type: "set_timer", Seconds: 60},
	} {
		drain(organizer)
		session.handle(organizer, msg)
		expectError(t, organizer)
	}
	if len(session.items) != before {
		t.Fatalf("queue changed after the session concluded: %d -> %d", before, len(session.items))
	}
	if session.round != nil && session.round.Deadline != nil {
		t.Fatal("a timer was started on a concluded session")
	}

	// Restarting reopens the session, and the same actions are allowed again.
	drain(organizer)
	session.handle(organizer, &inboundMsg{Type: "restart_session"})
	if session.finalSummaryShown {
		t.Fatal("restart should clear the final summary")
	}
	session.handle(organizer, &inboundMsg{Type: "append_items", Items: []Item{{Title: "PROJ-9 now allowed"}}})
	if len(session.items) != before+1 {
		t.Fatalf("queue should be editable again after restart: %d", len(session.items))
	}
	drain(organizer)
	session.handle(organizer, &inboundMsg{Type: "set_timer", Seconds: 60})
	if session.round == nil || session.round.Deadline == nil {
		t.Fatal("a timer should be startable again after restart")
	}
}
