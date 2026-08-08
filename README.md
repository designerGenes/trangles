# Triangulate

Estimate the *shape* of the work, not a number to defend.

Instead of a single story-point vote that averages into a sea of 3s, each
participant stretches the aspects of the work on a radar plot. Organizers can
use the default **Uncertainty**, **Complexity**, and **Toil** set, or attach a
shared custom set of **2–8** aspects to a queue of issues. Two aspects render
as a horizontal line; three or more render as a radar shape. The live group
consensus is drawn in red pencil as estimates arrive. When the organizer ends
the round, the server produces:

- per-axis averages and spread,
- named outliers with *why* they diverge ("driven by higher Uncertainty"),
- plain-language observations ("well understood but heavy", "consider a spike"),
- a derived story-point score: a weighted blend of the axes (Uncertainty 40%,
  Complexity 35%, Toil 25%) nudged upward by disagreement, snapped to the
  Fibonacci scale.

Sessions are held in memory and are erased the moment the last participant
disconnects. With `REDIS_URL` set, each session mutation is also mirrored to
Redis and removed there at the same time. No accounts are required.

## Run locally

```sh
go run .
# open http://localhost:8080
```

`PORT` and `STATIC_DIR` env vars override defaults (8080, ./static).
Set `REDIS_URL` to a `redis://...` URL to enable the optional cache.

## Install

```sh
./install.sh
```

This builds the `triangulate` binary into `~/.local/bin`. Use
`./install.sh --bump-version` or `./install.sh --set-version X.Y.Z` to update
the project version before installing.

## Test

```sh
go test ./...
node static/radar.test.js
```

The Go suite covers issue loading, default and custom aspect validation,
submissions, scoring, organizer permissions, WebSocket session lifecycle, and
Redis cache cleanup. The Node test covers the pointer-to-axis calculation used
by the draggable radar handles.

## Deploy (single instance required)

All state is in RAM, so run exactly **one** instance. That constraint is also
what makes hosting nearly free.

**Fly.io** (~free hobby usage):

```sh
fly launch --no-deploy     # accept defaults; it detects the Dockerfile
fly scale count 1
fly deploy
```

**Any $4–6/mo VPS** (Hetzner CX22, DO droplet, etc.):

```sh
CGO_ENABLED=0 GOOS=linux go build -o triangulate .
scp triangulate static/ user@host:/opt/triangulate/
```

systemd unit:

```ini
[Unit]
Description=Triangulate
After=network.target

[Service]
WorkingDirectory=/opt/triangulate
ExecStart=/opt/triangulate/triangulate
Environment=PORT=8080
Restart=on-failure
DynamicUser=yes

[Install]
WantedBy=multi-user.target
```

Put Caddy or the platform's proxy in front for TLS — WebSockets upgrade
through both without extra config.

## Notes

- **No auth by design.** Codes are 5 chars from a 31-symbol alphabet
  (~28.6M combinations) and sessions die on abandonment; treat codes like
  meeting links. `CheckOrigin` is permissive for the same reason — tighten
  it in `session.go` if you ever put this on a hostile network.
- **Organizer identity** is a token issued at session creation and cached in
  `sessionStorage`, so an organizer refresh/rejoin restores their controls.
- **Aspects are data, not code**: the session starts with `DefaultAxes` in
  `session.go`, while an organizer can replace that schema when loading an
  issue set. Default aspects use the intentional 40/35/25 score weights;
  custom sets use equal weights.
- **Timer or manual cutoff**: the organizer may set an optional per-round
  timer; the server enforces the deadline and auto-concludes the round.

## Protocol (JSON over `/ws`)

Client → server: `create {name}` · `join {name, code, organizerToken?}` ·
`load_items {items, aspects?}` · `start_round {seconds}` ·
`submit {values}` (resubmit replaces) · `end_round` · `close_session`.

Server → client: `joined` (identity + axis config) · `state` (full snapshot
on every change: participants, round, live average, summary) · `error` ·
`closed`.
