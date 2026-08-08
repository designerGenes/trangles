package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

const redisKeyPrefix = "triangulate:session:"

// SessionStore mirrors a session outside the process. The in-memory session
// remains the source of truth for connected WebSocket clients.
type SessionStore interface {
	Save(SessionSnapshot) error
	Delete(code string) error
}

type SessionSnapshot struct {
	Code              string         `json:"code"`
	OrganizerToken    string         `json:"organizerToken"`
	Items             []Item         `json:"items"`
	NextItem          int            `json:"nextItem"`
	Axes              []string       `json:"axes"`
	AxisMins          []float64      `json:"axisMins"`
	AxisMaxes         []float64      `json:"axisMaxes"`
	PointLabels       []string       `json:"pointLabels"`
	History           []HistoryEntry `json:"history,omitempty"`
	FinalSummaryShown bool           `json:"finalSummaryShown"`
	Round             *RoundSnapshot `json:"round,omitempty"`
}

type RoundSnapshot struct {
	Number      int                    `json:"number"`
	Title       string                 `json:"title"`
	Link        string                 `json:"link,omitempty"`
	Description string                 `json:"description,omitempty"`
	Open        bool                   `json:"open"`
	Deadline    *time.Time             `json:"deadline,omitempty"`
	Submissions map[string]*Submission `json:"submissions"`
	Previews    map[string]*Submission `json:"previews"`
	Summary     *Summary               `json:"summary,omitempty"`
}

type RedisSessionStore struct {
	client redis.UniversalClient
}

func NewRedisSessionStore(redisURL string) (*RedisSessionStore, error) {
	opts, err := redis.ParseURL(redisURL)
	if err != nil {
		return nil, fmt.Errorf("parse REDIS_URL: %w", err)
	}
	return &RedisSessionStore{client: redis.NewClient(opts)}, nil
}

func (s *RedisSessionStore) Save(snapshot SessionSnapshot) error {
	b, err := json.Marshal(snapshot)
	if err != nil {
		return err
	}
	return s.client.Set(context.Background(), redisKeyPrefix+snapshot.Code, b, 0).Err()
}

func (s *RedisSessionStore) Delete(code string) error {
	return s.client.Del(context.Background(), redisKeyPrefix+code).Err()
}

func (s *Session) persistLocked() {
	if s.hub.store == nil {
		return
	}
	if err := s.hub.store.Save(s.snapshotLocked()); err != nil {
		log.Printf("cache session %s: %v", s.Code, err)
	}
}

func (s *Session) snapshotLocked() SessionSnapshot {
	snapshot := SessionSnapshot{
		Code:              s.Code,
		OrganizerToken:    s.organizerToken,
		Items:             append([]Item(nil), s.items...),
		NextItem:          s.nextItem,
		Axes:              append([]string(nil), s.axes...),
		AxisMins:          append([]float64(nil), s.axisMins...),
		AxisMaxes:         append([]float64(nil), s.axisMaxes...),
		PointLabels:       append([]string(nil), s.pointLabels...),
		History:           append([]HistoryEntry(nil), s.history...),
		FinalSummaryShown: s.finalSummaryShown,
	}
	if s.round != nil {
		snapshot.Round = &RoundSnapshot{
			Number:      s.round.Number,
			Title:       s.round.Title,
			Link:        s.round.Link,
			Description: s.round.Description,
			Open:        s.round.Open,
			Deadline:    s.round.Deadline,
			Submissions: s.round.Submissions,
			Previews:    s.round.Previews,
			Summary:     s.round.Summary,
		}
	}
	return snapshot
}

func (h *Hub) deleteCached(code string) {
	if h.store == nil {
		return
	}
	if err := h.store.Delete(code); err != nil {
		log.Printf("delete cached session %s: %v", code, err)
	}
}

func cleanItems(items []Item) []Item {
	const maxItems = 100
	clean := make([]Item, 0, len(items))
	for _, item := range items {
		item.ID = strings.TrimSpace(item.ID)
		if item.ID == "" {
			item.ID = randCode(12)
		}
		item.Title = strings.TrimSpace(item.Title)
		if item.Title == "" {
			continue
		}
		if len(item.Title) > maxTitleLen {
			item.Title = item.Title[:maxTitleLen]
		}
		item.Link = strings.TrimSpace(item.Link)
		item.Description = strings.TrimSpace(item.Description)
		if len(item.Description) > 2000 {
			item.Description = item.Description[:2000]
		}
		clean = append(clean, item)
		if len(clean) == maxItems {
			break
		}
	}
	return clean
}

func cleanAspects(aspects []string) ([]string, error) {
	if len(aspects) == 0 {
		return append([]string(nil), DefaultAxes...), nil
	}
	clean := make([]string, 0, len(aspects))
	seen := make(map[string]bool)
	for _, aspect := range aspects {
		aspect = strings.TrimSpace(aspect)
		if aspect == "" {
			continue
		}
		if len(aspect) > maxNameLen {
			aspect = aspect[:maxNameLen]
		}
		key := strings.ToLower(aspect)
		if seen[key] {
			continue
		}
		seen[key] = true
		clean = append(clean, aspect)
	}
	if len(clean) < 2 || len(clean) > 12 {
		return nil, fmt.Errorf("Custom aspects must include 2 to 12 unique names")
	}
	return clean, nil
}

func cleanBounds(max float64, count int) ([]float64, []float64, error) {
	if max == 0 {
		max = AxisMax
	}
	if max < 2 || max != math.Trunc(max) {
		return nil, nil, fmt.Errorf("Point maximum must be a whole number of at least 2")
	}
	mins := make([]float64, count)
	maxes := make([]float64, count)
	for i := range mins {
		mins[i] = AxisMin
		maxes[i] = max
	}
	return mins, maxes, nil
}

func cleanPointLabels(labels []string, max int) []string {
	clean := make([]string, max+1)
	for i, label := range labels {
		if i > max {
			break
		}
		label = strings.TrimSpace(label)
		if len(label) > maxNameLen {
			label = label[:maxNameLen]
		}
		clean[i] = label
	}
	if clean[1] == "" {
		clean[1] = "Light"
	}
	if clean[max] == "" {
		clean[max] = "Heavy"
	}
	return clean
}
