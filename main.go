// Triangulate — shape-based issue estimation.
// Single binary, in-memory sessions, no database, no auth.
package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"time"
)

var version = "dev"

func main() {
	cfg := LoadConfig()

	var store SessionStore
	if redisURL := os.Getenv("REDIS_URL"); redisURL != "" {
		redisStore, err := NewRedisSessionStore(redisURL)
		if err != nil {
			log.Printf("Redis cache disabled: %v", err)
		} else {
			store = redisStore
			log.Printf("Redis session cache enabled")
		}
	}
	hub := NewHubWithLimits(store, cfg.Limits)

	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.Dir(staticDir())))
	mux.Handle("/resources/", http.StripPrefix("/resources/", http.FileServer(http.Dir(resourcesDir()))))
	mux.HandleFunc("/ws", hub.HandleWS)
	// Client-facing slice of the config only — the limits stay server-side.
	mux.HandleFunc("/api/config", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "public, max-age=300")
		_ = json.NewEncoder(w).Encode(map[string]any{"nicknames": cfg.Nicknames})
	})
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	// http.ListenAndServe uses a zero-value Server: no timeouts at all, so a
	// handful of slow clients can hold connections open indefinitely. WriteTimeout
	// stays unset because WebSocket connections are long-lived by design; the
	// per-connection write deadline in session.go covers those instead.
	server := &http.Server{
		Addr:              ":" + port,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	log.Printf("triangulate %s listening on :%s", version, port)
	log.Fatal(server.ListenAndServe())
}

func staticDir() string {
	if d := os.Getenv("STATIC_DIR"); d != "" {
		return d
	}
	return "static"
}

func resourcesDir() string {
	if d := os.Getenv("RESOURCES_DIR"); d != "" {
		return d
	}
	return "resources"
}
