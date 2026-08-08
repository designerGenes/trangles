package main

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Config is the deployment's tunables. It is read once at startup from
// config/app.json. The file is optional: if it is missing or unparseable the
// built-in defaults below apply, so a bad edit degrades to "still serving"
// rather than "will not boot".
type Config struct {
	Limits    Limits   `json:"limits"`
	Nicknames []string `json:"nicknames"`
}

// Limits bound how much memory an anonymous caller can cause the process to
// allocate. Sessions live in RAM, so each of these is a memory ceiling as much
// as an abuse control.
type Limits struct {
	MaxSessions          int  `json:"maxSessions"`
	MaxClientsPerSession int  `json:"maxClientsPerSession"`
	MaxConnectionsPerIP  int  `json:"maxConnectionsPerIP"`
	MaxSessionsPerIP     int  `json:"maxSessionsPerIP"`
	TrustProxyHeaders    bool `json:"trustProxyHeaders"`
}

// DefaultLimits apply when config/app.json is absent — chosen to be safe on the
// smallest Fly machine rather than permissive.
var DefaultLimits = Limits{
	MaxSessions:          500,
	MaxClientsPerSession: 60,
	MaxConnectionsPerIP:  25,
	MaxSessionsPerIP:     10,
	TrustProxyHeaders:    true,
}

// FallbackNicknames keep the placeholder working if the config file is missing.
var FallbackNicknames = []string{"Cosmic Badger", "Waffle Wizard", "Laser Pigeon"}

func configPath() string {
	if p := os.Getenv("CONFIG_PATH"); p != "" {
		return p
	}
	return filepath.Join("config", "app.json")
}

// LoadConfig reads config/app.json, then lets environment variables override
// individual limits so a Fly deploy can be retuned with `fly secrets set`
// instead of a rebuild.
func LoadConfig() Config {
	cfg := Config{Limits: DefaultLimits, Nicknames: FallbackNicknames}

	path := configPath()
	data, err := os.ReadFile(path)
	if err != nil {
		log.Printf("config: %v — using built-in defaults", err)
		return applyEnvOverrides(cfg)
	}

	var parsed Config
	if err := json.Unmarshal(data, &parsed); err != nil {
		// Keep serving on a malformed edit rather than crash-looping on boot.
		log.Printf("config %s: %v — using built-in defaults", path, err)
		return applyEnvOverrides(cfg)
	}

	// Zero means "absent from the file", so fall back per-field instead of
	// letting a partial config silently disable a limit.
	if parsed.Limits.MaxSessions > 0 {
		cfg.Limits.MaxSessions = parsed.Limits.MaxSessions
	}
	if parsed.Limits.MaxClientsPerSession > 0 {
		cfg.Limits.MaxClientsPerSession = parsed.Limits.MaxClientsPerSession
	}
	if parsed.Limits.MaxConnectionsPerIP > 0 {
		cfg.Limits.MaxConnectionsPerIP = parsed.Limits.MaxConnectionsPerIP
	}
	if parsed.Limits.MaxSessionsPerIP > 0 {
		cfg.Limits.MaxSessionsPerIP = parsed.Limits.MaxSessionsPerIP
	}
	cfg.Limits.TrustProxyHeaders = parsed.Limits.TrustProxyHeaders
	if names := cleanNicknames(parsed.Nicknames); len(names) > 0 {
		cfg.Nicknames = names
	}

	log.Printf("config %s: %d nicknames, %d max sessions", path, len(cfg.Nicknames), cfg.Limits.MaxSessions)
	return applyEnvOverrides(cfg)
}

func applyEnvOverrides(cfg Config) Config {
	cfg.Limits.MaxSessions = envInt("MAX_SESSIONS", cfg.Limits.MaxSessions)
	cfg.Limits.MaxClientsPerSession = envInt("MAX_CLIENTS_PER_SESSION", cfg.Limits.MaxClientsPerSession)
	cfg.Limits.MaxConnectionsPerIP = envInt("MAX_CONNECTIONS_PER_IP", cfg.Limits.MaxConnectionsPerIP)
	cfg.Limits.MaxSessionsPerIP = envInt("MAX_SESSIONS_PER_IP", cfg.Limits.MaxSessionsPerIP)
	if raw := os.Getenv("TRUST_PROXY_HEADERS"); raw != "" {
		if parsed, err := strconv.ParseBool(raw); err == nil {
			cfg.Limits.TrustProxyHeaders = parsed
		}
	}
	return cfg
}

func envInt(key string, fallback int) int {
	raw := os.Getenv(key)
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value <= 0 {
		log.Printf("config: %s=%q is not a positive integer — keeping %d", key, raw, fallback)
		return fallback
	}
	return value
}

func cleanNicknames(names []string) []string {
	clean := make([]string, 0, len(names))
	seen := make(map[string]bool)
	for _, name := range names {
		name = strings.TrimSpace(name)
		if name == "" || len(name) > maxNameLen {
			continue
		}
		key := strings.ToLower(name)
		if seen[key] {
			continue
		}
		seen[key] = true
		clean = append(clean, name)
	}
	return clean
}
