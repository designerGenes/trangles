package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeConfig(t *testing.T, body string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "app.json")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CONFIG_PATH", path)
}

func TestLoadConfigReadsLimitsAndNicknames(t *testing.T) {
	writeConfig(t, `{
		"limits": {"maxSessions": 7, "maxClientsPerSession": 8, "maxConnectionsPerIP": 9, "maxSessionsPerIP": 3, "trustProxyHeaders": false},
		"nicknames": ["Alpha Otter", "Beta Badger"]
	}`)
	cfg := LoadConfig()
	if cfg.Limits.MaxSessions != 7 || cfg.Limits.MaxClientsPerSession != 8 ||
		cfg.Limits.MaxConnectionsPerIP != 9 || cfg.Limits.MaxSessionsPerIP != 3 {
		t.Fatalf("limits = %+v", cfg.Limits)
	}
	if cfg.Limits.TrustProxyHeaders {
		t.Fatal("trustProxyHeaders: false should be honoured")
	}
	if len(cfg.Nicknames) != 2 {
		t.Fatalf("nicknames = %v", cfg.Nicknames)
	}
}

func TestLoadConfigDegradesInsteadOfCrashing(t *testing.T) {
	// A missing file must not stop the server from booting.
	t.Setenv("CONFIG_PATH", filepath.Join(t.TempDir(), "does-not-exist.json"))
	if cfg := LoadConfig(); cfg.Limits != DefaultLimits || len(cfg.Nicknames) == 0 {
		t.Fatalf("missing config should fall back cleanly: %+v", cfg)
	}

	// Neither should a malformed one — a bad edit shouldn't crash-loop a deploy.
	writeConfig(t, `{"limits": {"maxSessions": `)
	if cfg := LoadConfig(); cfg.Limits != DefaultLimits {
		t.Fatalf("malformed config should fall back: %+v", cfg.Limits)
	}

	// A partial file must not silently zero out the limits it omits.
	writeConfig(t, `{"limits": {"maxSessions": 42}, "nicknames": ["Solo Sparrow"]}`)
	cfg := LoadConfig()
	if cfg.Limits.MaxSessions != 42 {
		t.Fatalf("stated limit ignored: %+v", cfg.Limits)
	}
	if cfg.Limits.MaxClientsPerSession != DefaultLimits.MaxClientsPerSession ||
		cfg.Limits.MaxConnectionsPerIP != DefaultLimits.MaxConnectionsPerIP {
		t.Fatalf("omitted limits should keep defaults, not become zero: %+v", cfg.Limits)
	}
}

func TestEnvOverridesBeatTheFile(t *testing.T) {
	writeConfig(t, `{"limits": {"maxSessions": 7}, "nicknames": ["Alpha Otter"]}`)
	t.Setenv("MAX_SESSIONS", "99")
	t.Setenv("MAX_CONNECTIONS_PER_IP", "4")
	cfg := LoadConfig()
	if cfg.Limits.MaxSessions != 99 || cfg.Limits.MaxConnectionsPerIP != 4 {
		t.Fatalf("env override ignored: %+v", cfg.Limits)
	}

	// A nonsense value keeps the previous setting rather than disabling a limit.
	t.Setenv("MAX_SESSIONS", "not-a-number")
	if got := LoadConfig().Limits.MaxSessions; got != 7 {
		t.Fatalf("invalid override should be discarded, got %d", got)
	}
	t.Setenv("MAX_SESSIONS", "0")
	if got := LoadConfig().Limits.MaxSessions; got != 7 {
		t.Fatalf("zero must not disable the ceiling, got %d", got)
	}
}

func TestNicknamesAreDeduplicatedAndLengthChecked(t *testing.T) {
	long := strings.Repeat("x", maxNameLen+1)
	writeConfig(t, `{"nicknames": ["Alpha Otter", "  Alpha Otter  ", "alpha otter", "", "`+long+`", "Beta Badger"]}`)
	names := LoadConfig().Nicknames
	if len(names) != 2 || names[0] != "Alpha Otter" || names[1] != "Beta Badger" {
		t.Fatalf("nicknames = %v", names)
	}
}

// The shipped file is the one users actually get; a typo there is a real bug.
func TestShippedConfigIsValid(t *testing.T) {
	t.Setenv("CONFIG_PATH", filepath.Join("config", "app.json"))
	cfg := LoadConfig()
	if len(cfg.Nicknames) < 100 {
		t.Fatalf("shipped nickname pool is only %d entries", len(cfg.Nicknames))
	}
	for _, name := range cfg.Nicknames {
		if len(name) > maxNameLen {
			t.Fatalf("%q exceeds maxNameLen and would be truncated on join", name)
		}
	}
	// The curated list is finite; the generated pairs are what make the pool
	// deep enough that a room rarely sees the same suggestion twice.
	if pairs := len(cfg.Parts.Adjectives) * len(cfg.Parts.Nouns); pairs < 1000 {
		t.Fatalf("shipped nickname parts yield only %d pairs", pairs)
	}
	for _, word := range append(append([]string{}, cfg.Parts.Adjectives...), cfg.Parts.Nouns...) {
		if len(word) > maxNamePartLen {
			t.Fatalf("%q exceeds maxNamePartLen and would be dropped", word)
		}
	}
	if cfg.Limits.MaxSessions <= 0 || cfg.Limits.MaxClientsPerSession <= 0 ||
		cfg.Limits.MaxConnectionsPerIP <= 0 || cfg.Limits.MaxSessionsPerIP <= 0 {
		t.Fatalf("shipped limits must all be positive: %+v", cfg.Limits)
	}
}

// A generated name is joined with a space, so both halves have to fit inside
// the same budget a typed nickname does.
func TestNicknamePartsFitTheJoinBudget(t *testing.T) {
	if maxNamePartLen*2+1 > maxNameLen {
		t.Fatalf("maxNamePartLen %d cannot pair within maxNameLen %d", maxNamePartLen, maxNameLen)
	}
	long := strings.Repeat("x", maxNamePartLen+1)
	writeConfig(t, `{"nicknameParts": {"adjectives": ["Turbo", " Turbo ", "turbo", "", "`+long+`", "Two Words"], "nouns": ["Otter"]}}`)
	parts := LoadConfig().Parts
	if len(parts.Adjectives) != 1 || parts.Adjectives[0] != "Turbo" {
		t.Fatalf("adjectives = %v", parts.Adjectives)
	}
}

// One empty bank means no pairs at all, so a half-configured pool must not
// silently replace the built-in one.
func TestOneEmptyNicknameBankKeepsTheDefaults(t *testing.T) {
	writeConfig(t, `{"nicknameParts": {"adjectives": ["Turbo"], "nouns": []}}`)
	parts := LoadConfig().Parts
	if len(parts.Adjectives) != len(FallbackNicknameParts.Adjectives) ||
		len(parts.Nouns) != len(FallbackNicknameParts.Nouns) {
		t.Fatalf("a half-configured pool replaced the defaults: %+v", parts)
	}
}
