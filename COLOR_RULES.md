# Triangulate Color Rules

**Status:** Current palette, tokenised.
**Source of truth:** the `TRIANGULATE-TOKENS` block at the top of `static/style.css`. This document explains that block; it does not duplicate its authority.
**Use:** change a value in the colour lab (below) or in the token block directly. Never write a colour anywhere else — `static/ui.test.js` fails the build if a hex or `rgba()` appears outside the block.

## How the palette is organised

Colour used to be scattered across `style.css`, `app.js` and `session.go`, with the doc as the only thing tying them together. It is now one block of named tokens that everything else reads:

- **`static/style.css`** declares every token and is the only file that names a colour.
- **`static/app.js`** reads `--axis-1` … `--axis-8` at runtime instead of holding its own copy. `AXIS_FALLBACK` exists solely for the case where the stylesheet has not applied yet, and is never the value in a rendered page.
- **`session.go`**'s `ShapeColors` mirrors the same eight, because the server hands the palette out on join and enforces uniqueness. `TestShapeColorsMirrorTheAxisTokens` pins the two lists together.

### Two tiers, and why

The interface separates **things the organizer operates** from **things the room produced**, and the palette carries that distinction:

| Tier | Surfaces | Treatment | Text |
| --- | --- | --- | --- |
| Control panel | `.issues-box`, `.aspects-box`, `.point-labels-box` | Bright, saturated ramp on the diagonal with a sheen across it and a light-over-dark bevel — raised plastic | Dark (`--panel-ink`) |
| Result | `.chart-box`, `.summary-card`, `.history-card`, `.final-summary-card` | The same construction at lower intensity, on deep violet | Light (`--ink`) |

Control panels **invert**. This is forced, not stylistic: a genuinely bright honey gives off-white text roughly 1.9:1, so a bright panel and light text cannot coexist. Results stay deep because the radar draws light strokes on them, and because a result is read rather than operated.

An active round (`.round-card .chart-box`, `.live-inputs`) is deliberately neutral `--card`. Several participant colours share that surface and a tint would bias how they read against each other.

### The raised-plastic construction

A panel is two stacked gradients in one `background-image`, not a pseudo-element — so nothing competes with the panel's children for stacking order:

1. the family ramp at `--panel-angle` (145°), from `*-lit` to `*-deep`;
2. a sheen at `--panel-sheen-angle` (160°), from `--panel-gloss` through `--panel-shade-deep`.

Then `inset 0 1px 0 var(--panel-bevel)` over `inset 0 -1px 0 var(--panel-bevel-dark)` for the moulded edge, and two drop shadows for lift. Rows inside a panel **darken** (`--panel-slot`) rather than lighten: a light overlay is invisible on a bright surface.

Fields stay dark and recessed inside a bright panel. That keeps every light-on-dark rule inside a field working unchanged, and it is why focus takes an accent border (visible against the dark field) *and* a dark outline (visible against the bright panel) — neither alone covers both.

## The legibility floor

Bright surfaces are where contrast quietly breaks, so it is enforced rather than eyeballed. `static/ui.test.js` recomputes these on every run, and the colour lab shows the same table live.

Ratios are measured on the **composited** surface — sheen over ramp, and the recessed-row overlay over that — not on the raw token, because that composite is what text actually sits on.

| Pairing | Floor | Worst measured |
| --- | --- | --- |
| Panel text on a shaded panel corner | 4.5 | 5.91 |
| Panel text inside a recessed row | 4.5 | 5.55 |
| Quiet panel copy inside a recessed row | 4.5 | 4.91 |
| Panel warning copy | 4.5 | 5.70 |
| Light text on the lit corner of a result surface | 4.5 | 8.65 |
| Secondary text on the lit corner of a result surface | 4.5 | 4.84 |
| Primary action label | 4.5 | 4.86 |
| Every participant colour on the round surface | 4.5 | 5.28 |
| Score numeral / accents (large text) | 3.0 | 3.38 |

Two of these were failing before this pass and are fixed by it: the participant palette reached only 2.7:1 (it colours participant *names*, not just strokes), and the primary action label sat at 4.42.

## The colour lab

A local-only page that renders a specimen of every element below, lets you edit any token with live preview, and writes the result back into `static/style.css` as a normal one-line-per-change diff you can review and ship.

```
TRIANGULATE_DEV=1 go run .    # then open http://localhost:8080/dev/colors
```

It is gated three ways, deliberately independently:

1. the route is a flat 404 unless `TRIANGULATE_DEV=1`, so a deploy never mounts it;
2. even mounted, it answers loopback only, ignoring proxy headers — an env var set by accident still does not expose a file writer;
3. `devtools/` is not copied into the Docker image at all.

It refuses to write anything that is not a colour or an angle, because a token value lands in CSS unquoted. It rewrites values in place and never adds, removes or reorders a declaration: the block's comments and grouping are hand-authored, and the lab only supplies values. Saving a palette that breaks the floor above is possible but requires confirming a warning — and the test suite will still fail on it.

Editing the block by hand is equally fine. Keep the markers, one declaration per line, and the `@group` / `@label` comments — those are what the lab lays itself out from, and `TestParseTokensReadsTheWholeBlock` fails if a token loses either.

## Token reference

Generated from `static/style.css`. If this table and the stylesheet disagree, the stylesheet is right.

### Base surfaces

| Token | Value | Role |
| --- | --- | --- |
| `--paper` | `#161922` | Page background. |
| `--paper-lift` | `#242B3B` | Page top glow. |
| `--card` | `#202534` | Neutral card (active round). |
| `--card-raised` | `#282E40` | Raised card / controls. |
| `--surface-input` | `#151A25` | Recessed field. |
| `--surface-hover` | `#343D53` | Neutral hover lift. |
| `--grid` | `#2A3040` | Structural hairline. |
| `--border` | `#3A4358` | Default border. |

### Text

| Token | Value | Role |
| --- | --- | --- |
| `--ink` | `#F4F1E8` | Primary text (on dark). |
| `--muted` | `#AEB7C8` | Secondary text (on dark). |
| `--on-primary` | `#FFFFFF` | Text on primary action. |
| `--on-pencil` | `#22161B` | Text on coral controls. |
| `--on-pending` | `#241A22` | Text on pending control. |

### Control panels — shared plastic

| Token | Value | Role |
| --- | --- | --- |
| `--panel-ink` | `#1C1710` | Panel text. |
| `--panel-ink-soft` | `rgba(28, 23, 16, 0.90)` | Panel secondary text. |
| `--panel-warn` | `#4A0B02` | Panel warning text. |
| `--panel-slot` | `rgba(28, 23, 16, 0.09)` | Recessed row on a panel. |
| `--panel-slot-edge` | `rgba(28, 23, 16, 0.24)` | Recessed row edge. |
| `--panel-gloss` | `rgba(255, 255, 255, 0.28)` | Panel sheen, lit corner. |
| `--panel-gloss-fade` | `rgba(255, 255, 255, 0.02)` | Panel sheen, fade-out. |
| `--panel-shade` | `rgba(0, 0, 0, 0.02)` | Panel sheen, turn. |
| `--panel-shade-deep` | `rgba(0, 0, 0, 0.06)` | Panel sheen, shaded corner. |
| `--panel-bevel` | `rgba(255, 255, 255, 0.55)` | Panel top bevel. |
| `--panel-bevel-dark` | `rgba(0, 0, 0, 0.22)` | Panel bottom bevel. |
| `--panel-cast-tight` | `rgba(4, 6, 13, 0.30)` | Panel contact shadow. |
| `--panel-cast` | `rgba(4, 6, 13, 0.38)` | Panel drop shadow. |

### Control panels — issue family (honey)

| Token | Value | Role |
| --- | --- | --- |
| `--honey` | `#FFD166` | Honey accent. |
| `--honey-lit` | `#FFCB55` | Issue panel, lit corner. |
| `--honey-deep` | `#F7B32B` | Issue panel, shaded corner. |
| `--honey-rim` | `#C98A12` | Issue panel rim. |
| `--honey-halo` | `rgba(255, 209, 102, 0.16)` | Honey focus halo. |

### Control panels — aspect family (orange)

| Token | Value | Role |
| --- | --- | --- |
| `--orange` | `#FF9D42` | Orange accent. |
| `--orange-lit` | `#FFA463` | Aspect panel, lit corner. |
| `--orange-deep` | `#FB8942` | Aspect panel, shaded corner. |
| `--orange-rim` | `#C75A16` | Aspect panel rim. |
| `--orange-halo` | `rgba(255, 157, 66, 0.16)` | Orange focus halo. |

### Control panels — point-label family (blue)

| Token | Value | Role |
| --- | --- | --- |
| `--blue` | `#55C9FF` | Blue accent. |
| `--blue-lit` | `#63CFF9` | Point-label panel, lit corner. |
| `--blue-deep` | `#3BB0F0` | Point-label panel, shaded corner. |
| `--blue-rim` | `#1177B4` | Point-label panel rim. |
| `--blue-halo` | `rgba(85, 201, 255, 0.16)` | Blue focus halo. |

### Result surfaces (violet)

| Token | Value | Role |
| --- | --- | --- |
| `--violet` | `#A98CFF` | Violet accent. |
| `--violet-lit` | `#372A76` | Result surface, lit corner. |
| `--violet-deep` | `#1E1652` | Result surface, shaded corner. |
| `--violet-rim` | `#6152B8` | Result surface rim. |
| `--violet-halo` | `rgba(169, 140, 255, 0.16)` | Violet hover halo. |
| `--violet-glow` | `rgba(169, 140, 255, 0.12)` | Setup chart halo. |
| `--violet-veil` | `rgba(169, 140, 255, 0.07)` | Live score card fill. |
| `--violet-veil-edge` | `rgba(169, 140, 255, 0.28)` | Live score card edge. |
| `--deep-gloss` | `rgba(255, 255, 255, 0.07)` | Result sheen, lit corner. |
| `--deep-gloss-fade` | `rgba(255, 255, 255, 0.01)` | Result sheen, fade-out. |
| `--deep-shade` | `rgba(0, 0, 0, 0.06)` | Result sheen, turn. |
| `--deep-shade-deep` | `rgba(0, 0, 0, 0.14)` | Result sheen, shaded corner. |
| `--deep-bevel` | `rgba(255, 255, 255, 0.11)` | Result top bevel. |
| `--ring` | `#3B345D` | Radar grid ring. |

### Actions and status

| Token | Value | Role |
| --- | --- | --- |
| `--primary-action` | `#6C5CE7` | Primary action. |
| `--primary-edge` | `#8E83F2` | Primary action edge / hover. |
| `--primary-edge-hot` | `#B0A8FF` | Primary action hover edge. |
| `--primary-glow` | `rgba(108, 92, 231, 0.30)` | Primary action glow. |
| `--pencil` | `#FF6464` | Consensus coral. |
| `--pencil-hot` | `#FF8585` | Consensus coral hover. |
| `--pencil-fill` | `rgba(255, 100, 100, 0.13)` | Average shape fill. |
| `--pencil-cast` | `rgba(255, 100, 100, 0.26)` | Coral action shadow. |
| `--pencil-glow` | `rgba(255, 100, 100, 0.36)` | Timer glow. |
| `--pencil-glow-max` | `rgba(255, 100, 100, 0.55)` | Wordmark glow. |
| `--pending` | `#C97586` | Pending end-round action. |

### Overlays and depth

| Token | Value | Role |
| --- | --- | --- |
| `--shadow-light` | `rgba(4, 6, 13, 0.20)` | Card shadow. |
| `--shadow-medium` | `rgba(4, 6, 13, 0.36)` | Timer shadow. |
| `--shadow-strong` | `rgba(4, 6, 13, 0.42)` | Colour picker shadow. |
| `--shadow-modal` | `rgba(4, 6, 13, 0.50)` | Demo guide shadow. |
| `--ink-veil` | `rgba(244, 241, 232, 0.08)` | Light overlay tint. |
| `--ink-line` | `rgba(244, 241, 232, 0.14)` | Light hairline. |
| `--ink-edge` | `rgba(244, 241, 232, 0.16)` | Light overlay edge. |
| `--ink-rule` | `rgba(244, 241, 232, 0.18)` | Light section rule. |
| `--ink-quiet` | `rgba(244, 241, 232, 0.50)` | Light text, quietest. |
| `--ink-soft` | `rgba(244, 241, 232, 0.58)` | Light text, soft. |
| `--ink-mid` | `rgba(244, 241, 232, 0.66)` | Light text, mid. |
| `--ink-loud` | `rgba(244, 241, 232, 0.78)` | Light text, loud. |
| `--ink-control` | `rgba(244, 241, 232, 0.65)` | Light control border. |
| `--shape-fill` | `rgba(244, 241, 232, 0.10)` | Personal shape fill. |
| `--demo-halo` | `rgba(255, 209, 102, 0.25)` | Demo target halo. |

### Chart axes and participant shapes

| Token | Value | Role |
| --- | --- | --- |
| `--axis-1` | `#A98CFF` | Axis 1 / participant 1. |
| `--axis-2` | `#4FC3FF` | Axis 2 / participant 2. |
| `--axis-3` | `#FFB14A` | Axis 3 / participant 3. |
| `--axis-4` | `#FF6464` | Axis 4 / participant 4. |
| `--axis-5` | `#65D69A` | Axis 5 / participant 5. |
| `--axis-6` | `#FF7AC6` | Axis 6 / participant 6. |
| `--axis-7` | `#739AFF` | Axis 7 / participant 7. |
| `--axis-8` | `#FF9D42` | Axis 8 / participant 8. |

### Look

| Token | Value | Role |
| --- | --- | --- |
| `--panel-angle` | `145deg` | Panel ramp angle. |
| `--panel-sheen-angle` | `160deg` | Panel sheen angle. |

## Notes

- `--paper` is the dark background token despite its legacy name, and `--ink` is the light text token. Preserve those semantic roles or rename both references together.
- `--panel-angle` and `--panel-sheen-angle` are not colours, but they are what makes a panel read as raised, so the lab tunes them alongside the ramps.
- The favicon in `static/index.html` inlines `--card` and `--pencil`. It is a data URI and cannot read tokens; update it by hand if either changes.
- The result family — per-round summary, completed-issue history, and the session capstone — is intentionally one look. Splitting them would imply a distinction the session does not have.
- Adding a colour means adding a token, with an `@group` and an `@label`. There is no other supported way, and the suite enforces it.
