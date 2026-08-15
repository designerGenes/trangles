package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

func readStylesheet(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile("static/style.css")
	if err != nil {
		t.Fatalf("read stylesheet: %v", err)
	}
	return string(data)
}

func TestParseTokensReadsTheWholeBlock(t *testing.T) {
	tokens, err := ParseTokens(readStylesheet(t))
	if err != nil {
		t.Fatalf("ParseTokens: %v", err)
	}
	if len(tokens) < 50 {
		t.Fatalf("parsed %d tokens, expected the full palette", len(tokens))
	}
	// A token with no label or group cannot be laid out by the lab, so the
	// block having drifted out of shape should fail here rather than showing
	// up as an unlabelled swatch in a browser.
	for _, token := range tokens {
		if token.Label == "" {
			t.Errorf("%s has no @label", token.Name)
		}
		if token.Group == "" {
			t.Errorf("%s sits outside any @group", token.Name)
		}
		if !nameRe.MatchString(token.Name) {
			t.Errorf("unexpected token name %q", token.Name)
		}
		if !valueRe.MatchString(token.Value) {
			t.Errorf("%s holds a value the lab could not write back: %q", token.Name, token.Value)
		}
	}
}

// Writing every token back at its current value must reproduce the file byte
// for byte. That is what makes a real edit a one-line diff instead of a
// reformat of the whole block.
func TestApplyTokensIsIdempotent(t *testing.T) {
	css := readStylesheet(t)
	tokens, err := ParseTokens(css)
	if err != nil {
		t.Fatalf("ParseTokens: %v", err)
	}
	updates := map[string]string{}
	for _, token := range tokens {
		updates[token.Name] = token.Value
	}
	next, err := ApplyTokens(css, updates)
	if err != nil {
		t.Fatalf("ApplyTokens: %v", err)
	}
	if next != css {
		t.Fatal("re-writing every token at its current value changed the file")
	}
}

func TestApplyTokensTouchesOnlyTheEditedLine(t *testing.T) {
	css := readStylesheet(t)
	next, err := ApplyTokens(css, map[string]string{"--honey-lit": "#FF0000"})
	if err != nil {
		t.Fatalf("ApplyTokens: %v", err)
	}
	before, after := strings.Split(css, "\n"), strings.Split(next, "\n")
	if len(before) != len(after) {
		t.Fatalf("line count changed: %d -> %d", len(before), len(after))
	}
	changed := []string{}
	for i := range before {
		if before[i] != after[i] {
			changed = append(changed, after[i])
		}
	}
	if len(changed) != 1 {
		t.Fatalf("expected 1 changed line, got %d: %v", len(changed), changed)
	}
	if !strings.Contains(changed[0], "--honey-lit: #FF0000;") {
		t.Errorf("unexpected rewrite: %q", changed[0])
	}
	// The trailing label comment is what makes the block self-describing;
	// losing it on save would quietly degrade the file over time.
	if !strings.Contains(changed[0], "@label") {
		t.Errorf("rewrite dropped the label comment: %q", changed[0])
	}
}

// A token value is interpolated into CSS unquoted, so anything that could close
// the declaration has to be refused rather than escaped.
func TestApplyTokensRefusesUnsafeInput(t *testing.T) {
	css := readStylesheet(t)
	cases := map[string]map[string]string{
		"unknown token":     {"--not-a-real-token": "#FFFFFF"},
		"rule injection":    {"--paper": "#fff; } body { display: none"},
		"url value":         {"--paper": "url(http://example.com/x.png)"},
		"expression value":  {"--paper": "var(--ink)"},
		"malformed name":    {"--Paper; x": "#FFFFFF"},
		"semicolon in name": {"--paper;--ink": "#FFFFFF"},
	}
	for name, updates := range cases {
		if _, err := ApplyTokens(css, updates); err == nil {
			t.Errorf("%s: expected rejection, got none", name)
		}
	}
}

func TestColorLabIsAbsentUnlessDevModeIsOn(t *testing.T) {
	t.Setenv("TRIANGULATE_DEV", "")
	mux := http.NewServeMux()
	RegisterColorLab(mux)

	for _, path := range []string{"/dev/colors", "/dev/colors/tokens", "/dev/colors/save"} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.RemoteAddr = "127.0.0.1:54321"
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s with dev mode off = %d, want 404", path, rec.Code)
		}
	}
}

// The env var keeps the lab off a deploy; this check means an env var set by
// accident still does not expose a file writer. Proxy headers are ignored on
// purpose, so spoofing one must not help.
func TestColorLabRefusesNonLoopbackCallers(t *testing.T) {
	t.Setenv("TRIANGULATE_DEV", "1")
	mux := http.NewServeMux()
	RegisterColorLab(mux)

	for _, remote := range []string{"203.0.113.9:40000", "[2001:db8::1]:40000", "10.1.2.3:40000"} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/dev/colors/tokens", nil)
		req.RemoteAddr = remote
		req.Header.Set("X-Forwarded-For", "127.0.0.1")
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusNotFound {
			t.Errorf("caller %s = %d, want 404", remote, rec.Code)
		}
	}
}

func TestColorLabServesTokensToLoopback(t *testing.T) {
	t.Setenv("TRIANGULATE_DEV", "1")
	mux := http.NewServeMux()
	RegisterColorLab(mux)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/dev/colors/tokens", nil)
	req.RemoteAddr = "127.0.0.1:54321"
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("tokens = %d, want 200 (body %q)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "--panel-ink") {
		t.Errorf("token payload missing the panel ink: %q", rec.Body.String())
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", got)
	}
}

func TestColorLabSaveRejectsGet(t *testing.T) {
	t.Setenv("TRIANGULATE_DEV", "1")
	mux := http.NewServeMux()
	RegisterColorLab(mux)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/dev/colors/save", nil)
	req.RemoteAddr = "127.0.0.1:54321"
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET /dev/colors/save = %d, want 405", rec.Code)
	}
}

// The participant palette used to exist twice — muted colours here, bright ones
// in the client — and the two drifted apart. They are now one list mirrored in
// two languages, so pin them together.
func TestShapeColorsMirrorTheAxisTokens(t *testing.T) {
	css := readStylesheet(t)
	tokens, err := ParseTokens(css)
	if err != nil {
		t.Fatalf("ParseTokens: %v", err)
	}
	axis := regexp.MustCompile(`^--axis-(\d+)$`)
	byIndex := map[string]string{}
	for _, token := range tokens {
		if m := axis.FindStringSubmatch(token.Name); m != nil {
			byIndex[m[1]] = strings.ToUpper(token.Value)
		}
	}
	if len(byIndex) != len(ShapeColors) {
		t.Fatalf("%d --axis-N tokens for %d ShapeColors", len(byIndex), len(ShapeColors))
	}
	for i, want := range ShapeColors {
		got := byIndex[strconv.Itoa(i+1)]
		if got != strings.ToUpper(want) {
			t.Errorf("ShapeColors[%d] = %s, but --axis-%d = %s", i, want, i+1, got)
		}
	}
}
