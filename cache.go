package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
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
	Code           string         `json:"code"`
	OrganizerToken string         `json:"organizerToken"`
	Items          []string       `json:"items"`
	NextItem       int            `json:"nextItem"`
	Axes           []string       `json:"axes"`
	AxisMins       []float64      `json:"axisMins"`
	AxisMaxes      []float64      `json:"axisMaxes"`
	Round          *RoundSnapshot `json:"round,omitempty"`
}

type RoundSnapshot struct {
	Number      int                    `json:"number"`
	Title       string                 `json:"title"`
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
		Code:           s.Code,
		OrganizerToken: s.organizerToken,
		Items:          append([]string(nil), s.items...),
		NextItem:       s.nextItem,
		Axes:           append([]string(nil), s.axes...),
		AxisMins:       append([]float64(nil), s.axisMins...),
		AxisMaxes:      append([]float64(nil), s.axisMaxes...),
	}
	if s.round != nil {
		snapshot.Round = &RoundSnapshot{
			Number:      s.round.Number,
			Title:       s.round.Title,
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

func cleanItems(items []string) []string {
	const maxItems = 100
	clean := make([]string, 0, len(items))
	for _, item := range items {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		if len(item) > maxTitleLen {
			item = item[:maxTitleLen]
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
	if len(clean) < 2 || len(clean) > 8 {
		return nil, fmt.Errorf("Custom aspects must include 2 to 8 unique names")
	}
	return clean, nil
}

func cleanBounds(mins, maxes []float64, count int) ([]float64, []float64, error) {
	if len(mins) == 0 && len(maxes) == 0 {
		outMins := make([]float64, count)
		outMaxes := make([]float64, count)
		for i := range outMaxes {
			outMaxes[i] = AxisMax
		}
		return outMins, outMaxes, nil
	}
	if len(mins) != count || len(maxes) != count {
		return nil, nil, fmt.Errorf("Each aspect needs a minimum and maximum")
	}
	outMins := append([]float64(nil), mins...)
	outMaxes := append([]float64(nil), maxes...)
	for i := range outMins {
		if outMins[i] >= outMaxes[i] {
			return nil, nil, fmt.Errorf("Each aspect maximum must exceed its minimum")
		}
	}
	return outMins, outMaxes, nil
}
