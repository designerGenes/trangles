// Triangulate — shape-based issue estimation.
// Single binary, in-memory sessions, no database, no auth.
package main

import (
	"log"
	"net/http"
	"os"
)

var version = "dev"

func main() {
	hub := NewHub()
	if redisURL := os.Getenv("REDIS_URL"); redisURL != "" {
		store, err := NewRedisSessionStore(redisURL)
		if err != nil {
			log.Printf("Redis cache disabled: %v", err)
		} else {
			hub = NewHubWithStore(store)
			log.Printf("Redis session cache enabled")
		}
	}

	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.Dir(staticDir())))
	mux.HandleFunc("/ws", hub.HandleWS)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	log.Printf("triangulate %s listening on :%s", version, port)
	log.Fatal(http.ListenAndServe(":"+port, mux))
}

func staticDir() string {
	if d := os.Getenv("STATIC_DIR"); d != "" {
		return d
	}
	return "static"
}
