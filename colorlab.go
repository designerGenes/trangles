// Colour lab — a local-only editor for the theme tokens in static/style.css.
//
// The whole point is that it edits the deployed source rather than a runtime
// override: you tune the palette in a browser, press Save, and the change lands
// in style.css as a normal diff you can read, review and ship. Nothing about
// the palette becomes dynamic in production, and the running server keeps no
// theme state.
//
// It is off unless TRIANGULATE_DEV=1, and even then it answers loopback only.
// Both gates matter: the env var keeps the route off a Fly deploy, and the
// loopback check means an accidentally-set env var still cannot expose a file
// writer to the internet.
package main

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

const (
	tokenBlockStart = "== TRIANGULATE-TOKENS:START =="
	tokenBlockEnd   = "== TRIANGULATE-TOKENS:END =="
)

// ColorLabEnabled reports whether the lab should be mounted at all.
func ColorLabEnabled() bool { return os.Getenv("TRIANGULATE_DEV") == "1" }

func devDir() string {
	if d := os.Getenv("DEVTOOLS_DIR"); d != "" {
		return d
	}
	return "devtools"
}

func stylesheetPath() string { return filepath.Join(staticDir(), "style.css") }

// Token is one editable declaration from the block, carrying enough context for
// the lab to lay itself out without a second source of truth.
type Token struct {
	Name  string `json:"name"`
	Value string `json:"value"`
	Label string `json:"label"`
	Group string `json:"group"`
}

var (
	// A declaration line, with the optional trailing "@label" comment.
	tokenLineRe = regexp.MustCompile(`(?m)^\s*(--[A-Za-z0-9-]+):\s*([^;]+);\s*(?:/\*\s*@label\s*(.*?)\s*\*/)?\s*$`)
	// A "@group" comment opens a section. The heading may carry prose after it
	// on following lines; only the first line is the name.
	groupLineRe = regexp.MustCompile(`(?m)^\s*/\*\s*@group\s*(.*?)\s*$`)
	// Values we are willing to write back. Anything else is rejected rather
	// than escaped, because a token value lands in CSS unquoted: allowing
	// arbitrary text would let a save close the declaration and append rules.
	valueRe = regexp.MustCompile(`^(#[0-9a-fA-F]{3,8}|rgba?\([0-9.,\s%]+\)|hsla?\([0-9.,\s%deg]+\)|-?[0-9.]+deg|[a-z]+)$`)
	nameRe  = regexp.MustCompile(`^--[a-z][a-z0-9-]*$`)
)

// splitTokenBlock returns the text before the block's opening comment, the body
// between the markers, and the text after — so a rewrite can put the file back
// together without touching a byte outside the block.
func splitTokenBlock(css string) (head, body, tail string, err error) {
	start := strings.Index(css, tokenBlockStart)
	end := strings.Index(css, tokenBlockEnd)
	if start < 0 || end < 0 || end < start {
		return "", "", "", fmt.Errorf("style.css is missing the %s / %s markers", tokenBlockStart, tokenBlockEnd)
	}
	return css[:start+len(tokenBlockStart)], css[start+len(tokenBlockStart) : end], css[end:], nil
}

// ParseTokens pulls every editable declaration out of the block, in file order,
// tagged with the group heading it appeared under.
func ParseTokens(css string) ([]Token, error) {
	_, body, _, err := splitTokenBlock(css)
	if err != nil {
		return nil, err
	}

	// Walk once, tracking the most recent group heading above each declaration.
	type mark struct {
		at    int
		group string
	}
	marks := []mark{}
	for _, m := range groupLineRe.FindAllStringSubmatchIndex(body, -1) {
		heading := strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(body[m[2]:m[3]]), "*/"))
		marks = append(marks, mark{at: m[0], group: heading})
	}
	groupAt := func(pos int) string {
		group := ""
		for _, m := range marks {
			if m.at < pos {
				group = m.group
			}
		}
		return group
	}

	tokens := []Token{}
	for _, m := range tokenLineRe.FindAllStringSubmatchIndex(body, -1) {
		name := body[m[2]:m[3]]
		value := strings.TrimSpace(body[m[4]:m[5]])
		label := ""
		if m[6] >= 0 {
			label = body[m[6]:m[7]]
		}
		tokens = append(tokens, Token{Name: name, Value: value, Label: label, Group: groupAt(m[0])})
	}
	if len(tokens) == 0 {
		return nil, fmt.Errorf("no tokens found between the markers")
	}
	return tokens, nil
}

// ApplyTokens rewrites the values of existing declarations in place. It never
// adds, removes or reorders a token: the block's shape, comments and grouping
// are the hand-authored part, and the lab only supplies values. An unknown name
// is an error rather than a silent no-op, since it means the lab and the
// stylesheet have drifted.
func ApplyTokens(css string, updates map[string]string) (string, error) {
	head, body, tail, err := splitTokenBlock(css)
	if err != nil {
		return "", err
	}

	known := map[string]bool{}
	for _, t := range func() []Token { t, _ := ParseTokens(css); return t }() {
		known[t.Name] = true
	}
	unknown := []string{}
	for name, value := range updates {
		if !nameRe.MatchString(name) {
			return "", fmt.Errorf("rejected token name %q", name)
		}
		if !known[name] {
			unknown = append(unknown, name)
			continue
		}
		if !valueRe.MatchString(strings.TrimSpace(value)) {
			return "", fmt.Errorf("rejected value %q for %s", value, name)
		}
	}
	if len(unknown) > 0 {
		sort.Strings(unknown)
		return "", fmt.Errorf("unknown token(s): %s", strings.Join(unknown, ", "))
	}

	rewritten := tokenLineRe.ReplaceAllStringFunc(body, func(line string) string {
		m := tokenLineRe.FindStringSubmatch(line)
		next, ok := updates[m[1]]
		if !ok {
			return line
		}
		// Rebuild from the captured pieces so the trailing label comment and
		// the line's alignment survive a value of a different width.
		decl := fmt.Sprintf("  %s: %s;", m[1], strings.TrimSpace(next))
		if m[3] == "" {
			return decl
		}
		pad := strings.Index(line, "/*") - len(decl)
		if pad < 1 {
			pad = 1
		}
		return decl + strings.Repeat(" ", pad) + fmt.Sprintf("/* @label %s */", m[3])
	})

	return head + rewritten + tail, nil
}

// RegisterColorLab mounts the lab, or a flat 404 when it is disabled so the
// route can never fall through to the static file server.
func RegisterColorLab(mux *http.ServeMux) {
	if !ColorLabEnabled() {
		mux.HandleFunc("/dev/", func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "not found", http.StatusNotFound)
		})
		return
	}
	mux.Handle("/dev/", loopbackOnly(http.StripPrefix("/dev", colorLabMux())))
}

func colorLabMux() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/colors", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, filepath.Join(devDir(), "colors.html"))
	})
	mux.Handle("/colors/", http.StripPrefix("/colors/", http.FileServer(http.Dir(devDir()))))
	mux.HandleFunc("/colors/tokens", handleTokens)
	mux.HandleFunc("/colors/save", handleSave)
	return mux
}

// loopbackOnly refuses anything that did not come from this machine. Proxy
// headers are deliberately ignored: they are attacker-controlled, and the whole
// value of this check is that it cannot be talked out of.
func loopbackOnly(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Robots-Tag", "noindex, nofollow")
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			host = r.RemoteAddr
		}
		if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func handleTokens(w http.ResponseWriter, _ *http.Request) {
	css, err := os.ReadFile(stylesheetPath())
	if err != nil {
		writeLabError(w, http.StatusInternalServerError, err)
		return
	}
	tokens, err := ParseTokens(string(css))
	if err != nil {
		writeLabError(w, http.StatusInternalServerError, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"path": stylesheetPath(), "tokens": tokens})
}

func handleSave(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeLabError(w, http.StatusMethodNotAllowed, fmt.Errorf("use POST"))
		return
	}
	var updates map[string]string
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&updates); err != nil {
		writeLabError(w, http.StatusBadRequest, err)
		return
	}

	path := stylesheetPath()
	css, err := os.ReadFile(path)
	if err != nil {
		writeLabError(w, http.StatusInternalServerError, err)
		return
	}
	next, err := ApplyTokens(string(css), updates)
	if err != nil {
		writeLabError(w, http.StatusBadRequest, err)
		return
	}

	// Write beside the target and rename, so a failure part-way through leaves
	// the stylesheet whole rather than truncated.
	info, err := os.Stat(path)
	mode := os.FileMode(0o644)
	if err == nil {
		mode = info.Mode()
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".style.css.*")
	if err != nil {
		writeLabError(w, http.StatusInternalServerError, err)
		return
	}
	tmpName := tmp.Name()
	if _, err := tmp.WriteString(next); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
		writeLabError(w, http.StatusInternalServerError, err)
		return
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpName)
		writeLabError(w, http.StatusInternalServerError, err)
		return
	}
	if err := os.Chmod(tmpName, mode); err != nil {
		_ = os.Remove(tmpName)
		writeLabError(w, http.StatusInternalServerError, err)
		return
	}
	if err := os.Rename(tmpName, path); err != nil {
		_ = os.Remove(tmpName)
		writeLabError(w, http.StatusInternalServerError, err)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"saved": len(updates), "path": path})
}

func writeLabError(w http.ResponseWriter, code int, err error) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
}
