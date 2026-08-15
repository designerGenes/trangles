/* Triangulate client — no framework, one WebSocket, one SVG. */
"use strict";

const $ = (id) => document.getElementById(id);

/* SVGElement has no `hidden` IDL property — assigning `.hidden` on an <svg>
   silently sets a JS expando and the element stays on screen. Drive the
   attribute directly so HTML and SVG behave the same. */
function setHidden(node, hidden) {
  if (!node) return;
  if (hidden) node.setAttribute("hidden", "");
  else node.removeAttribute("hidden");
}
const SVGNS = "http://www.w3.org/2000/svg";
/* Colours live in style.css, never here. These literals are the last-resort
   copy for the case where the stylesheet has not applied yet; the real values
   come from the --axis-N tokens so the colour lab can retune charts without
   anyone remembering that JS holds a second list. */
const AXIS_FALLBACK = ["#A98CFF", "#4FC3FF", "#FFB14A", "#FF6464", "#65D69A", "#FF7AC6", "#739AFF", "#FF9D42"];
let axisCache = null;
/* "" when the stylesheet has not answered yet, so callers decide the fallback. */
function themeColor(name) {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name);
    return value ? value.trim() : "";
  } catch {
    return "";
  }
}
/* Cached because getComputedStyle on every handle of every redraw is real
   work — but only once the stylesheet has actually answered. Caching
   unconditionally would let one early call, made before the CSS applied, pin
   the fallbacks for the life of the page. */
function axisColors() {
  if (axisCache) return axisCache;
  const resolved = AXIS_FALLBACK.map((hex, i) => themeColor(`--axis-${i + 1}`) || hex);
  if (resolved.some((hex, i) => hex !== AXIS_FALLBACK[i]) || themeColor("--ink")) axisCache = resolved;
  return resolved;
}
/* Participants pick their own shape colour from this pool. The server owns the
   authoritative list and sends it on join — uniqueness is enforced there — so
   this copy is only the fallback for a boot that never reached a session. */
let SERVER_PALETTE = null;
const palette = () => SERVER_PALETTE || axisColors();
/* The real pool lives in config/app.json and arrives from /api/config, so
   adding names never means touching JS. These few keep the placeholder
   working if the fetch fails or has not landed yet. */
let SILLY_NICKNAMES = ["Cosmic Badger", "Waffle Wizard", "Laser Pigeon"];

function randomNickname() {
  return SILLY_NICKNAMES[Math.floor(Math.random() * SILLY_NICKNAMES.length)];
}

async function loadRemoteConfig() {
  try {
    const response = await fetch("/api/config");
    if (!response.ok) return;
    const config = await response.json();
    if (Array.isArray(config.nicknames) && config.nicknames.length) {
      SILLY_NICKNAMES = config.nicknames;
      // The placeholder is already on screen by now; refresh it so the wider
      // pool is visible on first load rather than only after a reload.
      const field = $("in-name");
      if (field && !field.value) field.placeholder = randomNickname();
    }
  } catch (_) {
    /* Offline or blocked — the built-in fallback above still works. */
  }
}
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

const S = {
  ws: null,
  code: null,
  selfId: null,
  organizer: false,
  orgToken: null,
  name: "",
  hadParticipants: false, // once a participant has joined, leaving them all gone keeps the organizer's view intact
  axes: ["Uncertainty", "Complexity", "Toil"],
  axisMins: [1, 1, 1],
  axisMaxes: [8, 8, 8],
  pointLabels: ["", "Light", "", "", "", "", "", "", "Heavy"],
  my: [3, 3, 3],
  submittedRound: null,   // round number my last submit belongs to
  state: null,            // latest server snapshot
  live: false,
  leftDeliberately: false,
  dispAvg: null,          // animated average currently drawn
  countdown: null,
  previewRound: null,
  previewTimer: null,
  activeRound: null,
  activeRoundOpen: false,
  nextArmed: false,
  nextResetTimer: null,
  touched: false,
  liveView: "overlay",
  color: null,            // my chosen shape colour, remembered across rounds
  hiddenLive: new Set(),
  history: [],
  historyIndex: 0,      // which completed issue the organizer is viewing
  mode: "radar",        // how I am estimating: "radar" | "simple"
  simple: 3,            // my composite score in simple mode
  drafts: [],           // issues typed on the intake screen, before they are sent
  view: "landing",      // landing | intake | settings | session
  intakeStage: "first", // first | more — which copy the intake screen wears
  reviewing: false,     // organizer stepped back from intake to read a result
  privacy: false,
  feedbackVote: null,   // my vote on the round just concluded
  settingsReturn: "intake",
  settingsEdited: false, // distinguishes default settings from deliberate removal
  demo: null,            // client-only scripted walkthrough; never reaches the server
};

/* The round on screen owns the aspect list; the session-level set is only the
   default that the next round will inherit. */
function roundAxes(state) {
  const r = state && state.round;
  if (r && Array.isArray(r.axes) && r.axes.length) {
    return { axes: r.axes, mins: r.axisMins || r.axes.map(() => 1), maxes: r.axisMaxes || r.axes.map(() => 8) };
  }
  if (!state) return null;
  return { axes: state.axes, mins: state.axisMins, maxes: state.axisMaxes };
}

/* ── plot geometry ─────────────────────────────────────────────────── */
const CX = 180, CY = 180, R = 132;
const angle = (i) => Radar.axisAngle(i, S.axes.length);
const axisColor = (i) => { const c = axisColors(); return c[i % c.length]; };
const axisMin = (i) => S.axisMins[i] ?? 0;
const axisMax = (i) => S.axisMaxes[i] ?? 10;
const axisValue = (i, fraction) => axisMin(i) + (axisMax(i) - axisMin(i)) * fraction;
const pt = (i, v) => [
  CX + Math.cos(angle(i)) * R * ((v - axisMin(i)) / (axisMax(i) - axisMin(i))),
  CY + Math.sin(angle(i)) * R * ((v - axisMin(i)) / (axisMax(i) - axisMin(i))),
];
const polyPoints = (vals) => vals.map((v, i) => pt(i, v).join(",")).join(" ");

const plot = { svg: $("plot"), avg: null, mine: null, handles: [], dragAttached: false };

function el(tag, attrs, parent) {
  const n = document.createElementNS(SVGNS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  (parent || plot.svg).appendChild(n);
  return n;
}

function buildPlot() {
  plot.svg.innerHTML = "";
  // Nested radar rings make the current value easy to read at a glance.
  for (let fraction = 0.2; fraction <= 1; fraction += 0.2) {
    el("polygon", {
      points: polyPoints(S.axes.map((_, i) => axisValue(i, fraction))),
      class: "ring" + (fraction === 1 ? " ring-outer" : ""),
    });
  }
  S.axes.forEach((name, i) => {
    const [x, y] = pt(i, axisMax(i));
    el("line", {
      x1: CX, y1: CY, x2: x, y2: y,
      class: "axis-line", stroke: axisColor(i),
    });
    // Tick labels along the axis (2..10) — enough to read values off the grid.
    for (const value of [axisMax(i)]) {
      // Anchor the tick to the ring for the value it prints — it used to be
      // pinned at 0.9 of the axis while printing the max, so the number sat
      // between two rings and named neither.
      const [tx, ty] = pt(i, value);
      const position = Radar.tickPosition(tx, ty, angle(i));
      const tick = el("text", { x: position.x, y: position.y, class: "tick-label", "text-anchor": position.anchor });
      tick.textContent = formatValue(value);
      const title = el("title", {}, tick);
      title.textContent = pointLabel(value);
    }
    const position = Radar.labelPosition(x, y, angle(i));
    const label = el("text", {
      x: position.x, y: position.y, class: "axis-label", fill: themeColor("--ink") || "#F4F1E8",
      "text-anchor": position.anchor,
    });
    label.textContent = name;
  });

  plot.avg = el("polygon", { points: polyPoints(S.axes.map((_, i) => axisMin(i))), class: "avg-shape", visibility: "hidden" });
  plot.mine = el("polygon", { points: polyPoints(S.my), class: "my-shape" });

  plot.handles = S.axes.map((name, i) => {
    const g = el("g", {
      class: "handle", tabindex: 0, role: "slider",
      "aria-label": name, "aria-valuemin": axisMin(i), "aria-valuemax": axisMax(i),
      "aria-valuenow": S.my[i],
    });
    el("circle", { class: "hit" }, g);
    const dot = el("circle", { class: "dot", stroke: axisColor(i) }, g);
    g._dot = dot;
    g._title = el("title", {}, g);
    g.addEventListener("keydown", (e) => {
      const step = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
      if (step === undefined || !inputEnabled()) return;
      e.preventDefault();
      setAxis(i, S.my[i] + step);
    });
    return g;
  });

  buildReadouts();
  drawMine();
  attachPlotDrag();
}

function attachPlotDrag() {
  if (plot.dragAttached) return;
  plot.dragAttached = true;
  plot.svg.addEventListener("pointerdown", (e) => {
    if (!inputEnabled()) return;
    const handle = e.target.closest && e.target.closest(".handle");
    const i = handle ? plot.handles.indexOf(handle) : nearestAxis(svgPoint(e));
    if (i < 0) return;
    e.preventDefault();
    plot.svg.setPointerCapture(e.pointerId);
    const move = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      const p = svgPoint(ev);
      setAxis(i, Radar.projectAxis(p, { x: CX, y: CY }, angle(i), R, axisMin(i), axisMax(i)));
    };
    const up = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      plot.svg.removeEventListener("pointermove", move);
      plot.svg.removeEventListener("pointerup", up);
      plot.svg.removeEventListener("pointercancel", up);
      if (plot.svg.hasPointerCapture(ev.pointerId)) plot.svg.releasePointerCapture(ev.pointerId);
    };
    plot.svg.addEventListener("pointermove", move);
    plot.svg.addEventListener("pointerup", up);
    plot.svg.addEventListener("pointercancel", up);
    move(e);
  });
}

function nearestAxis(point) {
  let best = 0, distance = Infinity;
  S.axes.forEach((_, i) => {
    const value = Radar.quantizeAxis(Radar.projectAxis(point, { x: CX, y: CY }, angle(i), R, axisMin(i), axisMax(i)), axisMin(i), axisMax(i));
    const [x, y] = pt(i, value);
    const candidate = Math.hypot(point.x - x, point.y - y);
    if (candidate < distance) {
      best = i;
      distance = candidate;
    }
  });
  return best;
}

function svgPoint(evt) {
  const matrix = plot.svg.getScreenCTM();
  if (!matrix) return { x: CX, y: CY };
  const p = plot.svg.createSVGPoint();
  p.x = evt.clientX;
  p.y = evt.clientY;
  return p.matrixTransform(matrix.inverse());
}

function setAxis(i, v) {
  v = Radar.quantizeAxis(v, axisMin(i), axisMax(i));
  if (v === S.my[i]) return;
  S.my[i] = v;
  S.touched = true;
  drawMine();
  schedulePreview();
}

function drawMine() {
  plot.mine.setAttribute("points", polyPoints(S.my));
  // .my-shape sets fill and stroke in the stylesheet, which outranks a
  // presentation attribute — the personal colour has to go on inline style.
  const color = selfColor();
  plot.mine.style.stroke = color || "";
  plot.mine.style.fill = color ? `${color}1A` : "";
  plot.handles.forEach((g, i) => {
    const [x, y] = pt(i, S.my[i]);
    g._dot.setAttribute("cx", x);
    g._dot.setAttribute("cy", y);
    g.querySelector(".hit").setAttribute("cx", x);
    g.querySelector(".hit").setAttribute("cy", y);
    g.setAttribute("aria-valuenow", S.my[i]);
    const ro = $("ro-" + i);
    if (ro) ro.textContent = formatValue(S.my[i]);
    g._title.textContent = pointLabel(S.my[i]);
  });
}

function buildReadouts() {
  $("readouts").innerHTML = S.axes.map((a, i) =>
    `<div class="readout"><div id="ro-${i}" class="val" style="color:${axisColor(i)}">${formatValue(S.my[i])}</div>
     <div class="lbl">${a}</div></div>`).join("");
}

/* Animate the consensus polygon toward its new target. */
function drawAverage(target) {
  if (!target) {
    plot.avg.setAttribute("visibility", "hidden");
    S.dispAvg = null;
    return;
  }
  plot.avg.setAttribute("visibility", "visible");
  if (REDUCED || !S.dispAvg) {
    S.dispAvg = target.slice();
    plot.avg.setAttribute("points", polyPoints(S.dispAvg));
    return;
  }
  const from = S.dispAvg.slice(), t0 = performance.now(), DUR = 240;
  const step = (t) => {
    const k = Math.min(1, (t - t0) / DUR), e = 1 - Math.pow(1 - k, 3);
    S.dispAvg = from.map((f, i) => f + (target[i] - f) * e);
    plot.avg.setAttribute("points", polyPoints(S.dispAvg));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function inputEnabled() {
  const r = S.state && S.state.round;
  return !!(r && r.open && !S.demo && !S.organizer && !selfSubmitted(S.state));
}

/* ── websocket ─────────────────────────────────────────────────────── */
function connect(hello) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  S.ws = ws;
  S.leftDeliberately = false;
  ws.onopen = () => ws.send(JSON.stringify(hello));
  ws.onmessage = (e) => handleMessage(JSON.parse(e.data));
  ws.onclose = () => {
    if (S.leftDeliberately) return;
    if (S.code) {
      // One quiet rejoin attempt (handles refreshes and network blips).
      const creds = { type: "join", name: S.name, code: S.code, organizerToken: S.orgToken || "" };
      setTimeout(() => { if (!S.leftDeliberately) connect(creds); }, 800);
      S.code = null; // second failure falls through to landing
    } else {
      toLanding("Connection lost. The session may have ended.");
    }
  };
}

function handleMessage(msg) {
  switch (msg.type) {
    case "joined":
      S.code = msg.code;
      S.selfId = msg.selfId;
      S.organizer = msg.organizer;
      S.axes = msg.axes;
      if (Array.isArray(msg.colors) && msg.colors.length) SERVER_PALETTE = msg.colors.slice();
      S.axisMins = msg.axisMins || S.axes.map(() => 1);
      S.axisMaxes = msg.axisMaxes || S.axes.map(() => msg.axisMax || 10);
      S.pointLabels = msg.pointLabels || defaultPointLabels(S.axisMaxes[0]);
      S.my = S.axes.map((_, i) => startingValue(i));
      if (msg.organizerToken) S.orgToken = msg.organizerToken;
      // A refresh makes a new client with a freshly assigned colour, so ask
      // for the old one back. `restore` keeps the server quiet if someone
      // else has taken it in the meantime.
      if (!S.organizer && S.color) send({ type: "set_color", color: S.color, restore: true });
      sessionStorage.setItem("tri", JSON.stringify({
        code: S.code, name: S.name, token: S.orgToken || "", color: S.color || "",
      }));
      if (S.organizer) showIntake("first", true);
      else showSession();
      break;
    case "state":
      S.state = msg;
      render();
      break;
    case "error":
      toast(msg.message);
      if (msg.fatal) toLanding();
      break;
    case "reminder":
      toast(msg.message);
      break;
    case "closed":
      S.leftDeliberately = true;
      toLanding(msg.message);
      break;
  }
}

function send(obj) {
  if (S.demo) return;
  if (S.ws && S.ws.readyState === WebSocket.OPEN) S.ws.send(JSON.stringify(obj));
}

/* ── rendering ─────────────────────────────────────────────────────── */
/* One switch owns which screen is up, so no two views can be on at once. */
function recordView(name) {
  if (!window.history || !window.history.pushState) return;
  const url = new URL(location.href);
  url.hash = name === "landing" ? "" : name;
  if (history.state && history.state.view === name) {
    history.replaceState({ view: name }, "", url);
  } else {
    history.pushState({ view: name }, "", url);
  }
}

function showView(name, record) {
  S.view = name;
  setHidden($("view-landing"), name !== "landing");
  setHidden($("view-intake"), name !== "intake");
  setHidden($("view-settings"), name !== "settings");
  setHidden($("view-session"), name !== "session");
  setHidden($("code-chip"), name === "landing" || !S.code || !!S.demo);
  if (S.code) $("code-text").textContent = S.code;
  if (record) recordView(name);
}

function showSession(record) {
  showView("session", record);
  $("organizer-shelf").hidden = !S.organizer || !!S.demo;
  buildPlot();
}

/* stage "first": nothing has been pointed yet. stage "more": the queue just
   emptied, and the organizer chooses between more work and the results. */
function showIntake(stage, record) {
  const nextStage = stage || S.intakeStage;
  // Initial drafts remain available in live settings. The post-session intake
  // is a new queue, so it always starts with a clean row.
  if (nextStage === "more" && S.intakeStage !== "more") S.drafts = [];
  S.intakeStage = nextStage;
  S.reviewing = false;
  showView("intake", record);
  $("view-intake").classList.toggle("intake-initial", nextStage === "first");
  if (S.drafts.length === 0) addDraftItem();
  renderIntake();
}

function renderIntake() {
  renderIntakeCopy();
  renderDraftRows();
}

function renderIntakeCopy() {
  const more = S.intakeStage === "more";
  $("intake-eyebrow").textContent = more ? "Every issue pointed" : "New session";
  $("intake-title").textContent = more
    ? "Point another issue, or wrap up."
    : S.drafts.length > 1 ? "Enter each issue to point." : "Enter the first issue to point.";
  setHidden($("intake-detail"), more);
  $("btn-launch").textContent = more ? "Add more issues" : "Launch pointing session";
  setHidden($("btn-intake-results"), !more);
  setHidden($("btn-intake-back"), !more || !(S.state && S.state.round));
  const done = (S.history || []).length;
  const points = (S.history || []).reduce((sum, entry) => sum + ((entry.summary && entry.summary.storyPoints) || 0), 0);
  $("intake-tally").textContent = `${done} issue${done === 1 ? "" : "s"} pointed · ${points} story points so far`;
  setHidden($("intake-tally"), !more || done === 0);
}

function showSettings(from, record) {
  S.settingsReturn = from || S.view || "intake";
  showView("settings", record);
  const liveSession = S.settingsReturn === "session";
  $("btn-settings-back").textContent = liveSession ? "Back to session" : "Back";
  setHidden($("btn-close-settings"), liveSession);
  if (!S.settingsEdited && $("draft-aspects").children.length === 0) {
    const seed = (S.state && S.state.axes) || ["Uncertainty", "Complexity", "Toil"];
    seed.forEach((aspect) => addDraftAspect(aspect, false));
  }
  renderSettingsItems();
  renderSetupRange();
}

function closeSettings(record) {
  if (S.settingsReturn === "session") showSession(record);
  else launchDrafts();
}

function backFromSettings() {
  if (S.settingsReturn === "session") showSession(true);
  else showIntake("first", true);
}

function toLanding(message) {
  clearDemo();
  S.leftDeliberately = true;
  if (S.ws) try { S.ws.close(); } catch (_) {}
  S.ws = null; S.state = null; S.code = null; S.submittedRound = null; S.live = false;
  S.previewRound = null;
  S.activeRound = null;
  S.activeRoundOpen = false;
  S.touched = false;
  resetNextConfirm();
  S.history = [];
  S.historyIndex = 0;
  setHidden($("history-card"), true);
  setHidden($("end-rail"), true);
  clearTimeout(S.previewTimer);
  S.drafts = [];
  S.mode = "radar";
  S.privacy = false;
  S.reviewing = false;
  S.feedbackVote = null;
  S.settingsEdited = false;
  $("intake-items").innerHTML = "";
  $("draft-aspects").innerHTML = "";
  $("settings-items").innerHTML = "";
  $("setup-point-labels").innerHTML = "";
  $("setup-max").value = "8";
  stopCountdown();
  setHidden($("privacy-badge"), true);
  setHidden($("btn-demo"), false);
  showView("landing");
  if (message) toast(message);
}

/* ── guided demo ───────────────────────────────────────────────────── */
/* The walkthrough sends no WebSocket messages. It feeds representative state
   snapshots through the same renderer a real session uses, so the guide stays
   useful whenever the production interface evolves. */
const DEMO_AXES = ["Uncertainty", "Complexity", "Toil"];
const DEMO_SUMMARY = {
  storyPoints: 5,
  pointsWhy: "Weighted blend of the axes scores 4.4, +0.2 because the team disagrees -> 5 points.",
  averages: [5, 4, 3],
  spread: [0.8, 0.5, 0.5],
  observations: ["Strong agreement across all aspects.", "Well understood but heavy: mostly an engineering-time problem, not a research one."],
  outliers: [],
  shapes: [
    { id: "mina", name: "Mina", values: [5, 4, 3] },
    { id: "rowan", name: "Rowan", values: [5, 4, 3] },
  ],
  scores: [],
};

function demoParticipants(role, submitted) {
  return [
    { id: "ada", name: "Ada", organizer: true, submitted: false },
    { id: "mina", name: role === "participant" ? "You" : "Mina", organizer: false, submitted: !!submitted, color: axisColor(0) },
    { id: "rowan", name: "Rowan", organizer: false, submitted: !!submitted, color: axisColor(1) },
  ];
}

function demoRound(open, submitted, summary, liveShapes) {
  return {
    number: 1,
    title: "Invite teammates to a project workspace",
    description: "Let workspace owners invite colleagues, choose a role, and resend a pending invite.",
    open,
    submittedCount: submitted ? 2 : 0,
    axes: DEMO_AXES,
    axisMins: [1, 1, 1],
    axisMaxes: [8, 8, 8],
    summary: summary || undefined,
    liveShapes: liveShapes || [],
  };
}

function demoState(role, round, submitted, history, finalSummary) {
  return {
    type: "state",
    code: "DEMO1",
    axes: DEMO_AXES,
    axisMins: [1, 1, 1],
    axisMaxes: [8, 8, 8],
    pointLabels: ["", "Light", "", "", "", "", "", "", "Heavy"],
    participants: demoParticipants(role, submitted),
    queuedItems: 0,
    round,
    history: role === "organizer" ? (history || []) : [],
    finalSummary: finalSummary || undefined,
  };
}

function demoPeerPreview(step) {
  const copy = [
    ["Participant view", "Mina receives the same issue and drags a private shape before anyone else can see a result.", [55, 45, 35]],
    ["Participant view", "Mina sees her own chart while the organizer sees only the live, unnamed aggregate.", [62, 50, 38]],
    ["Participant view", "Mina submits. Her estimate is locked while the organizer finishes the round.", [62, 50, 38]],
    ["Participant view", "Mina receives the score and group insights, with peer responses anonymized.", [62, 50, 38]],
  ][Math.min(step, 3)];
  return `<span class="eyebrow">${copy[0]}</span><h3>Invite teammates to a project workspace</h3><p>${copy[1]}</p>
    <div class="demo-peer-bars" aria-hidden="true">${copy[2].map((width) => `<i style="width:${width}%"></i>`).join("")}</div>`;
}

function setDemoGuide(step, title, copy, target, peer) {
  document.querySelectorAll(".demo-target").forEach((node) => {
    node.classList.remove("demo-target");
    node.removeAttribute("data-demo-tooltip");
    node.removeAttribute("aria-describedby");
  });
  const focus = target && document.querySelector(target);
  if (focus) {
    focus.classList.add("demo-target");
    focus.dataset.demoTooltip = title;
    focus.setAttribute("aria-describedby", "demo-guide");
  }
  $("demo-step").textContent = `${S.demo.role === "organizer" ? "Organizer" : "Participant"} demo · ${step + 1} of 4`;
  $("demo-title").textContent = title;
  $("demo-copy").textContent = copy;
  $("demo-progress").textContent = step < 3 ? "Use Next to continue." : "Walkthrough complete.";
  $("btn-demo-prev").disabled = step === 0;
  $("btn-demo-next").disabled = step === 3;
  setHidden($("demo-peer-preview"), !peer);
  $("demo-peer-preview").innerHTML = peer || "";
  setHidden($("demo-guide"), false);
}

function runDemoStep(role, step) {
  if (!S.demo || S.demo.role !== role) return;
  step = Math.max(0, Math.min(3, step));
  S.demo.step = step;
  const history = [{ number: 1, title: "Invite teammates to a project workspace", summary: DEMO_SUMMARY,
    axes: DEMO_AXES, axisMins: [1, 1, 1], axisMaxes: [8, 8, 8] }];
  const liveShapes = DEMO_SUMMARY.shapes.map((shape) => ({ ...shape }));
  if (role === "organizer") {
    if (step === 0) {
      S.state = demoState(role, demoRound(true, false), false);
      setDemoGuide(step, "Start with one issue", "Ada launches a lightweight session. Participants can join from the session code, while the organizer watches the room instead of voting.", ".round-card", demoPeerPreview(step));
    } else if (step === 1) {
      S.state = demoState(role, demoRound(true, false, null, liveShapes), false);
      setDemoGuide(step, "Watch shapes arrive", "This frame shows Mina and Rowan adjusting their charts. The organizer sees the live overlay without exposing a final score.", "#live-inputs", demoPeerPreview(step));
    } else if (step === 2) {
      S.state = demoState(role, demoRound(false, true, DEMO_SUMMARY), true, history);
      setDemoGuide(step, "Finish the round", "When everyone has submitted, Ada ends the issue. The completed-issue view keeps the score, aspect averages, and discussion prompts together.", "#history-card", demoPeerPreview(step));
    } else {
      S.state = demoState(role, demoRound(false, true, DEMO_SUMMARY), true, history, {
        totalPoints: 5,
        issues: history,
        sessionInsights: ["1 issue estimated across this session.", "Strong agreement on 1 issue."],
      });
      setDemoGuide(step, "Wrap up or keep pointing", "Ada can share the session result, then continue by adding another issue instead of creating a new room.", "#final-summary-card", demoPeerPreview(step));
    }
  } else if (step === 0) {
    S.state = demoState(role, null, false);
    setDemoGuide(step, "Join and wait", "Mina joins with a nickname and session code. The organizer starts the issue when the team is ready.", ".round-card");
  } else if (step === 1) {
    S.my = [2, 2, 2];
    S.touched = false;
    S.state = demoState(role, demoRound(true, false), false);
    setDemoGuide(step, "Make a private estimate", "The organizer has started an issue. Mina adjusts every aspect on her own chart; no team result is shown yet.", "#plot-wrap");
  } else if (step === 2) {
    S.my = [5, 4, 3];
    S.touched = true;
    S.state = demoState(role, demoRound(true, true), true);
    setDemoGuide(step, "Submission recorded", "This frame shows Mina's submitted estimate. Her chart is now read-only while the organizer waits for the room or finishes the round.", "#plot-wrap");
  } else {
    const anonymous = { ...DEMO_SUMMARY, shapes: DEMO_SUMMARY.shapes.map((shape, index) => ({ ...shape, id: "", name: `Anonymous response ${index + 1}` })) };
    S.state = demoState(role, demoRound(false, true, anonymous), true);
    setDemoGuide(step, "Read the shared outcome", "Ada closes the issue. Mina sees the story-point result and useful group insights without seeing anyone else's named estimate.", "#summary-card");
  }
  render();
}

function stepDemo(delta) {
  if (!S.demo) return;
  runDemoStep(S.demo.role, S.demo.step + delta);
}

function clearDemo() {
  S.demo = null;
  document.body.classList.remove("is-demo");
  document.querySelectorAll(".demo-target").forEach((node) => {
    node.classList.remove("demo-target");
    node.removeAttribute("data-demo-tooltip");
    node.removeAttribute("aria-describedby");
  });
  setHidden($("demo-guide"), true);
}

function startDemo(role) {
  // A demo never shares a transport with a real session. The visible launcher
  // is hidden as soon as create/join begins; this closes the remaining race for
  // programmatic starts or a connection that has not finished opening yet.
  if (S.ws) {
    S.leftDeliberately = true;
    S.ws.onopen = null;
    S.ws.onmessage = null;
    S.ws.onclose = null;
    try { S.ws.close(); } catch (_) {}
    S.ws = null;
  }
  clearDemo();
  setHidden($("demo-launcher"), true);
  S.demo = { role, step: 0 };
  document.body.classList.add("is-demo");
  S.code = "DEMO1";
  S.name = role === "organizer" ? "Ada" : "Mina";
  S.selfId = role === "organizer" ? "ada" : "mina";
  S.organizer = role === "organizer";
  S.axes = DEMO_AXES.slice();
  S.axisMins = [1, 1, 1];
  S.axisMaxes = [8, 8, 8];
  S.pointLabels = ["", "Light", "", "", "", "", "", "", "Heavy"];
  S.live = true;
  S.reviewing = true;
  S.history = [];
  S.historyIndex = 0;
  S.mode = "radar";
  S.my = [2, 2, 2];
  showSession();
  runDemoStep(role, 0);
}

function stopDemo() {
  clearDemo();
  toLanding();
}

function render() {
  const st = S.state;
  if (!st) return;
  const resolved = roundAxes(st);
  syncAxes(resolved.axes, resolved.mins, resolved.maxes);
  S.privacy = !!st.privacy;
  setHidden($("privacy-badge"), !(S.organizer && S.privacy));
  if (st.round && !S.live) {
    S.live = true;
    showSession(true);
  }
  if (S.organizer && !S.live) {
    showIntake("first");
    return;
  }
  // Once the queue is empty and the round is done, the organizer gets the same
  // one-line intake screen they started on rather than being dropped straight
  // into the final totals — pointing a few more issues is the common case.
  if (S.organizer && !st.finalSummary && st.round && !st.round.open
      && (st.queuedItems || 0) === 0 && !S.reviewing && S.view !== "settings") {
    syncHistory(st.history);
    renderConsole(st.round);
    showIntake("more", true);
    return;
  }
  // A completed session has a single destination: its results. Do not leave a
  // settings screen visible behind the capstone when the last state arrives.
  if (st.finalSummary && S.view === "settings") showSession();
  if (S.view !== "session" && S.view !== "settings") showSession();
  const concluded = !!st.finalSummary;
  // The final summary reports on the whole session, so the per-round stack —
  // round header, live inputs, that round's summary, history — is left behind
  // entirely rather than sitting underneath it.
  setHidden($("round-stage"), concluded);
  renderPeople(st);
  renderColorPicker(st);
  drawMine();
  syncHistory(st.history);
  renderFinalSummary(st.finalSummary);
  if (concluded) {
    stopCountdown();
    renderConsole(st.round);
    return;
  }
  const r = st.round;
  const title = $("round-title");
  const eyebrow = $("round-eyebrow");
  const submitBtn = $("btn-submit");
  // The organizer observes; they never contribute an estimate, so they get
  // neither their own chart nor a submit control.
  setHidden($("plot-wrap"), S.organizer || S.mode === "simple");
  setHidden($("simple-wrap"), S.organizer || S.mode !== "simple");
  setHidden($("submit-row"), S.organizer || !!S.demo);
  setHidden($("progress"), !S.organizer);

  if (!r) {
    eyebrow.textContent = "Waiting";
    title.textContent = S.organizer
      ? "Post an issue below to start the first round."
      : "Waiting for the organizer to post an issue.";
    title.classList.add("idle");
    title.removeAttribute("href");
    $("round-description").hidden = true;
    submitBtn.disabled = true;
    $("progress").textContent = "";
    $("summary-card").hidden = true;
    $("live-inputs").hidden = true;
    drawAverage(null);
    stopCountdown();
    setHidden($("mode-switch"), true);
    setHidden($("simple-wrap"), true);
    $("plot-wrap").classList.add("plot-disabled");
    renderConsole(null);
    return;
  }

  // "Finish round" ends the round; this is the transition that follows, and the
  // summary is what the room should be looking at when it lands.
  const justConcluded = S.activeRound === r.number && S.activeRoundOpen && !r.open;
  if (S.activeRound !== r.number || (r.open && !S.activeRoundOpen)) {
    S.activeRound = r.number;
    S.submittedRound = null;
    S.previewRound = null;
    S.my = S.axes.map((_, i) => startingValue(i));
    S.touched = false;
    resetNextConfirm();
    drawMine();
  }
  S.activeRoundOpen = r.open;

  title.textContent = r.title;
  const href = safeLink(r.link);
  if (href) {
    title.href = href;
    title.target = "_blank";
    title.rel = "noreferrer";
  } else {
    title.removeAttribute("href");
    title.removeAttribute("target");
    title.removeAttribute("rel");
  }
  $("round-description").textContent = r.description || "";
  $("round-description").hidden = !r.description;
  title.classList.remove("idle");
  eyebrow.textContent = `Round ${r.number} — ${r.open ? "estimating" : "concluded"}`;
  $("plot-wrap").classList.toggle("plot-disabled", !r.open);

  const mineIn = selfSubmitted(st);
  submitBtn.disabled = !!S.demo || !r.open || mineIn;
  submitBtn.textContent = mineIn ? "Estimate submitted" : "Submit estimate";
  renderModeSwitch(r, mineIn);
  // Organizers never submit, so they must not inflate the denominator —
  // "2 of 3" could otherwise never complete.
  const estimators = st.participants.filter((person) => !person.organizer).length;
  $("progress").textContent = `${r.submittedCount} of ${estimators} estimated`;

  if (r.open) {
    drawAverage(r.average || null);
    if (r.pausedMs) showPausedClock(r.pausedMs);
    else startCountdown(r.deadlineMs);
    $("summary-card").hidden = true;
    if (!S.demo && !S.organizer && S.previewRound !== r.number) {
      S.previewRound = r.number;
      schedulePreview();
    }
  } else {
    stopCountdown();
    // The organizer reads concluded rounds in the history panel, which
    // auto-selects the newest entry — no need to show the same result twice.
    setHidden($("summary-card"), S.organizer);
    if (r.summary && !S.organizer) renderSummary(r.summary);
  }
  renderConsole(r);
  if (S.organizer) {
    $("live-inputs").hidden = !r.open;
    if (r.open) {
      renderLiveInputs(r.liveShapes || [], r.liveScores || []);
      setHidden($("live-inputs").querySelector(".view-switch"), !!S.demo);
    }
  }
  if (justConcluded) revealRoundSummary();
}

// The organizer reads results in the history pager, everyone else in the
// per-round summary card.
function revealRoundSummary() {
  const card = S.organizer ? $("history-card") : $("summary-card");
  if (!card || card.hidden || typeof card.scrollIntoView !== "function") return;
  card.scrollIntoView({ behavior: REDUCED ? "auto" : "smooth", block: "start" });
}

function syncAxes(axes, minsIn, maxesIn) {
  const mins = minsIn || S.state.axisMins || axes.map(() => 1);
  const maxes = maxesIn || S.state.axisMaxes || axes.map(() => 8);
  const labels = S.state.pointLabels || defaultPointLabels(maxes[0]);
  if (!axes || (axes.length === S.axes.length && axes.every((axis, i) => axis === S.axes[i]) && mins.every((value, i) => value === S.axisMins[i]) && maxes.every((value, i) => value === S.axisMaxes[i]) && labels.every((value, i) => value === S.pointLabels[i]) && labels.length === S.pointLabels.length)) return;
  S.axes = axes.slice();
  S.axisMins = mins.slice();
  S.axisMaxes = maxes.slice();
  S.pointLabels = labels.slice();
  S.my = S.axes.map((_, i) => startingValue(i));
  S.dispAvg = null;
  buildPlot();
}

// Aspects start low so a submitted estimate reflects a deliberate choice.
// Starting mid-scale invites leaving the handle where it landed.
const START_VALUE = 2;

function startingValue(i) {
  return Math.min(axisMax(i), Math.max(axisMin(i), START_VALUE));
}

/* An issue link is free text the organizer typed. A bare word like "abcdef"
   would resolve against our own host (/abcdef), and a javascript: link would
   run in every browser in the room — so only absolute http(s) links become
   anchors, and something that merely looks like a host gets a scheme. */
function safeLink(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(text);
  const looksLikeHost = /^[^\s/:]+\.[^\s/:]+/.test(text);
  const candidate = hasScheme ? text : (looksLikeHost ? `https://${text}` : null);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch (_) {
    return null;
  }
}

/* Round lengths read better as durations than as a raw second count:
   "90", "90s", "5m", "1m30s" and "5:30" all mean what they look like. */
function parseDuration(text) {
  const raw = String(text || "").trim().toLowerCase().replace(/\s+/g, "");
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw);
  const clock = /^(\d+):([0-5]\d)$/.exec(raw);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]);
  if (!/^(\d+[hms])+$/.test(raw)) return null;
  const unit = { h: 3600, m: 60, s: 1 };
  let total = 0;
  for (const match of raw.matchAll(/(\d+)([hms])/g)) total += Number(match[1]) * unit[match[2]];
  return total;
}

function formatValue(value) {
  return String(Math.round(value));
}

function pointLabel(value) {
  const label = S.pointLabels[Math.round(value)];
  return label ? `${formatValue(value)}: ${label}` : formatValue(value);
}

function defaultPointLabels(max) {
  const labels = Array(Math.round(max) + 1).fill("");
  labels[1] = "Light";
  labels[Math.round(max)] = "Heavy";
  return labels;
}

function estimatePayload(type) {
  return S.mode === "simple"
    ? { type, mode: "simple", score: S.simple, touched: S.touched }
    : { type, mode: "radar", values: S.my, touched: S.touched };
}

function schedulePreview() {
  const r = S.state && S.state.round;
  if (!r || !r.open) return;
  clearTimeout(S.previewTimer);
  S.previewTimer = setTimeout(() => send(estimatePayload("preview")), 40);
}

function selfSubmitted(state) {
  const self = state.participants && state.participants.find((person) => person.id === S.selfId);
  return !!(self && self.submitted);
}

function renderPeople(st) {
  $("people").innerHTML = st.participants.map((p) => `
    <span class="person ${p.submitted ? "submitted" : ""}">
      <span class="check" style="color:${p.organizer || !p.color ? "" : escapeHTML(p.color)}">✓</span>${escapeHTML(p.name)}${p.id === S.selfId ? " (you)" : ""}
      ${p.organizer ? '<span class="org">org</span>' : ""}
      ${S.organizer && p.submitted && !p.responded ? '<span class="default-vote">default</span>' : ""}
    </span>`).join("");
}

/* The switch belongs to participants alone: the organizer contributes no
   estimate, so there is no mode for them to be in. */
function renderModeSwitch(round, submitted) {
  const offer = !S.demo && !S.organizer && !!round && round.open && !submitted;
  setHidden($("mode-switch"), !offer);
  $("btn-mode-shape").classList.toggle("btn-primary", S.mode === "radar");
  $("btn-mode-simple").classList.toggle("btn-primary", S.mode === "simple");
  $("btn-mode-shape").setAttribute("aria-pressed", String(S.mode === "radar"));
  $("btn-mode-simple").setAttribute("aria-pressed", String(S.mode === "simple"));
  if (S.mode !== "simple") return;
  const slider = $("simple-slider");
  const min = axisMin(0);
  const max = axisMax(0);
  slider.min = String(min);
  slider.max = String(max);
  slider.disabled = !offer;
  if (S.simple < min || S.simple > max) S.simple = Math.min(max, Math.max(min, START_VALUE));
  slider.value = String(S.simple);
  $("simple-min").textContent = formatValue(min);
  $("simple-max").textContent = formatValue(max);
  drawSimple();
}

function drawSimple() {
  $("simple-value").textContent = formatValue(S.simple);
  const label = S.pointLabels[Math.round(S.simple)];
  $("simple-label").textContent = label || "";
  const min = axisMin(0);
  const max = axisMax(0);
  const fraction = max === min ? 0 : (S.simple - min) / (max - min);
  const scoreColor = fraction <= 0.5
    ? `color-mix(in srgb, var(--score-low) ${Math.round((0.5 - fraction) * 200)}%, var(--score-mid))`
    : `color-mix(in srgb, var(--score-mid) ${Math.round((1 - fraction) * 200)}%, var(--score-high))`;
  const wrap = $("simple-wrap");
  wrap.style.setProperty("--score-color", scoreColor);
  wrap.style.setProperty("--score-percent", `${Math.round(fraction * 100)}%`);
}

function setSimple(value) {
  const next = Math.round(Math.min(axisMax(0), Math.max(axisMin(0), value)));
  if (next === S.simple) return;
  S.simple = next;
  S.touched = true;
  drawSimple();
  schedulePreview();
}

function renderConsole(round) {
  if (!S.organizer) return;
  if (S.demo) {
    setHidden($("organizer-shelf"), true);
    setHidden($("end-rail"), true);
    return;
  }
  const open = !!(round && round.open);
  const queued = S.state.queuedItems || 0;
  const final = !!S.state.finalSummary;
  const pending = (S.state.participants || []).filter((person) => !person.organizer && !person.submitted);
  const eligible = (S.state.participants || []).filter((person) => !person.organizer);
  const submitted = eligible.length - pending.length;
  const allSubmitted = eligible.length > 0 && pending.length === 0;
  // The organizer's active controls (timer, end-rail, the shelf itself) only
  // earn their place once someone is in the room. Once anyone has joined, the
  // organizer keeps their current view even if the room empties — they are
  // still present, just no longer a participating estimate.
  const hasParticipants = eligible.length > 0;
  if (hasParticipants) S.hadParticipants = true;
  const waiting = !hasParticipants && !S.hadParticipants;
  // Results are a readout, not a place to change the completed session.
  setHidden($("organizer-shelf"), final || waiting);
  setHidden($("end-rail"), final || waiting);
  if (waiting) return;
  const finished = !!round && !open && queued === 0;
  const canTime = open && !final;
  const canRestart = !!round && !open && !final;
  $("btn-timer").hidden = !canTime;
  $("in-seconds").hidden = !canTime;
  $("timer-scope").hidden = !canTime;
  // One button for the whole clock: it starts, stops, and picks back up.
  const running = canTime && !!round.deadlineMs;
  $("btn-timer").textContent = running ? "Stop timer" : "Start timer";
  setHidden($("btn-timer-remove"), !canTime || !(round.deadlineMs || round.pausedMs));
  $("btn-restart-round").hidden = !canRestart;
  // A standing length is easy to forget having set, so it says so.
  const standing = S.state.defaultSeconds || 0;
  $("timer-standing").textContent = standing
    ? `Every remaining issue starts with ${clockText(standing * 1000)} on the clock.`
    : "";
  setHidden($("timer-standing"), !standing || final);
  $("in-privacy").checked = !!S.privacy;
  // A group whose every control is hidden would otherwise leave a bare heading
  // floating in the shelf.
  setHidden($("round-group"), !canTime && !canRestart);
  // The floating action remains available after a summary while queued work
  // remains, so a closed shelf never implies the session is finished.
  setHidden($("end-rail"), !round || (!open && queued === 0 && !finished && !final));
  $("end-vote-count").textContent = open && eligible.length ? `Votes: ${submitted}/${eligible.length}` : "";
  $("btn-end").classList.toggle("is-pending", open && !allSubmitted && !S.nextArmed);
  $("btn-end").classList.toggle("is-confirm", open && !allSubmitted && S.nextArmed);
  // One action, one meaning: while a round is live the button ends that round
  // and lands on its summary; only from the summary does it advance.
  if (final) {
    resetNextConfirm();
    $("btn-end").textContent = "Restart session";
    $("end-hint").hidden = true;
  } else if (!open && queued === 0) {
    resetNextConfirm();
    // Reached only while reviewing a result after the queue emptied; the
    // intake screen is where "what next" actually gets decided.
    $("btn-end").textContent = "What's next";
    $("end-hint").hidden = true;
  } else if (!open) {
    resetNextConfirm();
    $("btn-end").textContent = "Next issue";
    $("end-hint").hidden = true;
  } else if (allSubmitted) {
    resetNextConfirm();
    $("btn-end").textContent = "Finish round";
    $("end-hint").hidden = true;
  } else if (open && S.nextArmed) {
    $("btn-end").textContent = "Confirm";
    $("end-hint").textContent = "Votes are still pending.";
    $("end-hint").hidden = false;
  } else {
    $("btn-end").textContent = "Finish round";
    $("end-hint").hidden = true;
  }
  $("pending-panel").hidden = !open;
  $("pending-people").textContent = pending.length ? pending.map((person) => person.name).join(", ") : "All votes submitted.";
  $("btn-remind").disabled = pending.length === 0;
}

function renderFinalSummary(final) {
  setHidden($("final-summary-card"), !final);
  if (!final) return;
  $("final-points").textContent = final.totalPoints;
  const count = (final.issues || []).length;
  $("final-meta").textContent = `${count} issue${count === 1 ? "" : "s"} estimated`;
  $("final-issues").innerHTML = (final.issues || []).map((issue) => `
    <div class="final-issue"><span class="title">${escapeHTML(issue.title)}</span><span class="mono">${issue.summary ? issue.summary.storyPoints : 0}</span></div>`).join("");
  const insights = final.sessionInsights || [];
  setHidden($("session-insights"), insights.length === 0);
  $("final-insights").innerHTML = insights.map((insight) => `<li>${escapeHTML(insight)}</li>`).join("");
}

function resetNextConfirm() {
  S.nextArmed = false;
  clearTimeout(S.nextResetTimer);
  S.nextResetTimer = null;
}

function armNextConfirm() {
  S.nextArmed = true;
  clearTimeout(S.nextResetTimer);
}

function setupAspectNames() {
  return Array.from($("draft-aspects").querySelectorAll("input"))
    .map((input) => input.value.trim())
    .filter(Boolean);
}

function setupMax() {
  const max = Number($("setup-max").value);
  return Number.isInteger(max) && max >= 2 && max <= 100 ? max : null;
}

function renderSetupRange() {
  renderPointLabelRows();
  renderProspectivePlot();
}

function currentPointLabels() {
  return Array.from($("setup-point-labels").querySelectorAll("input")).map((input) => input.value);
}

function normalizePointLabels(labels) {
  if (!labels[0]) labels[0] = "Light";
  if (!labels[labels.length - 1]) labels[labels.length - 1] = "Heavy";
  return labels;
}

function renderPointLabelRows(labelsIn) {
  const max = setupMax();
  const current = labelsIn || currentPointLabels();
  $("setup-point-labels").innerHTML = "";
  if (!max) return;
  const labels = current.slice(0, max);
  while (labels.length < max) labels.push("");
  normalizePointLabels(labels);
  for (let index = 0; index < max; index++) {
    const row = document.createElement("div");
    row.className = "point-label-row";
    const number = document.createElement("span");
    number.textContent = String(index + 1);
    const input = document.createElement("input");
    input.maxLength = 24;
    input.placeholder = index === 0 ? "Light" : index === max - 1 ? "Heavy" : "Optional label";
    input.value = labels[index];
    row.append(number, input);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn row-minus";
    remove.textContent = "-";
    remove.disabled = max <= 2;
    remove.setAttribute("aria-label", `Remove point ${index + 1}`);
    remove.onclick = () => removePointLabel(index);
    row.appendChild(remove);
    if (index === max - 1) {
      const plus = document.createElement("button");
      plus.type = "button";
      plus.className = "btn row-plus";
      plus.textContent = "+";
      plus.disabled = max >= 100;
      plus.setAttribute("aria-label", "Add point");
      plus.onclick = appendPointLabel;
      row.appendChild(plus);
    }
    $("setup-point-labels").appendChild(row);
  }
}

function appendPointLabel() {
  const labels = currentPointLabels();
  if (labels.length >= 100) return;
  if (labels[labels.length - 1] === "Heavy") labels[labels.length - 1] = "";
  labels.push("Heavy");
  $("setup-max").value = String(labels.length);
  renderPointLabelRows(labels);
  renderProspectivePlot();
}

function removePointLabel(index) {
  const labels = currentPointLabels();
  if (labels.length <= 2) return;
  labels.splice(index, 1);
  normalizePointLabels(labels);
  $("setup-max").value = String(labels.length);
  renderPointLabelRows(labels);
  renderProspectivePlot();
}

function setupPointLabels() {
  const max = setupMax();
  if (!max) return [];
  const labels = Array(max + 1).fill("");
  Array.from($("setup-point-labels").querySelectorAll("input")).forEach((input, i) => { labels[i + 1] = input.value.trim(); });
  if (!labels[1]) labels[1] = "Light";
  if (!labels[max]) labels[max] = "Heavy";
  return labels;
}

/* The prospective chart lives on the settings screen only. It answers "what
   will they be dragging", which is a setup question, not something to carry
   through a live session. */
function renderProspectivePlot() {
  const aspects = setupAspectNames();
  const max = setupMax();
  const validAspects = aspects.length >= 2 && aspects.length <= 12;
  $("setup-aspect-warning").hidden = validAspects;
  setHidden($("setup-full-chart"), !validAspects || !max);
  if (!validAspects || !max) {
    $("setup-full-plot").innerHTML = "";
    return;
  }
  const mins = aspects.map(() => 1);
  const maxes = aspects.map(() => max);
  const values = aspects.map(() => Math.min(max, START_VALUE));
  drawStaticRadar($("setup-full-plot"), aspects, mins, maxes, [{ name: "Starting values", values, color: themeColor("--ink") || "#F4F1E8" }]);
}

function renderLiveInputs(shapes, scores = []) {
  const section = $("live-inputs");
  section.hidden = false;
  const active = shapes.map((shape) => ({
    ...shape,
    color: participantColor(shape.id),
  }));
  const activeScores = scores.map((score) => ({
    ...score,
    color: participantColor(score.id),
  }));
  const empty = active.length === 0 && activeScores.length === 0;
  const estimators = ((S.state && S.state.participants) || []).filter((person) => !person.organizer);
  // A room with estimators but no previews still benefits from the normal
  // chart surface. Only a genuinely empty room, or a private screen before any
  // anonymized estimates arrive, uses the centered explanation.
  const emptyStage = empty && (S.privacy || estimators.length === 0);
  $("btn-live-overlay").classList.toggle("btn-primary", S.liveView === "overlay");
  $("btn-live-grid").classList.toggle("btn-primary", S.liveView === "grid");
  // The active view is conveyed by colour alone otherwise.
  $("btn-live-overlay").setAttribute("aria-pressed", String(S.liveView === "overlay"));
  $("btn-live-grid").setAttribute("aria-pressed", String(S.liveView === "grid"));
  setHidden($("live-toggles"), emptyStage || S.liveView !== "overlay");
  // An empty SVG is still a flex item. Hide both views for the empty state so
  // the explanatory message owns the entire stage in Sum and Individual.
  setHidden($("live-overlay"), emptyStage || S.liveView !== "overlay");
  setHidden($("live-grid"), emptyStage || S.liveView !== "grid");
  setHidden($("live-scores"), emptyStage || S.liveView !== "overlay" || activeScores.length === 0);
  setHidden($("live-empty"), !emptyStage);
  $("live-stage").classList.toggle("has-empty", emptyStage);
  if (emptyStage) {
    // Avoid implying who has or has not supplied a private estimate.
    $("live-empty").textContent = S.privacy
      ? "No live estimates are available yet."
      : "No participants are here to estimate yet.";
  }
  $("live-toggles").innerHTML = "";
  active.forEach((shape) => {
    const label = document.createElement("label");
    label.className = "live-toggle";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = !S.hiddenLive.has(shape.id);
    checkbox.onchange = () => {
      if (checkbox.checked) S.hiddenLive.delete(shape.id);
      else S.hiddenLive.add(shape.id);
      renderLiveInputs(shapes, scores);
    };
    const swatch = document.createElement("i");
    swatch.style.background = shape.color;
    label.append(checkbox, swatch, document.createTextNode(shape.name));
    $("live-toggles").appendChild(label);
  });
  if (!empty) {
    drawStaticRadar($("live-overlay"), S.axes, S.axisMins, S.axisMaxes,
      active.filter((shape) => !S.hiddenLive.has(shape.id)));
  } else {
    $("live-overlay").innerHTML = "";
  }
  renderLiveScores(activeScores);
  $("live-grid").innerHTML = "";
  active.forEach((shape) => {
    const card = document.createElement("div");
    card.className = "live-mini";
    const svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("viewBox", "-70 -45 500 434");
    drawStaticRadar(svg, S.axes, S.axisMins, S.axisMaxes, [shape]);
    const name = document.createElement("span");
    name.textContent = shape.name;
    name.style.color = shape.color;
    card.append(svg, name);
    $("live-grid").appendChild(card);
  });
  activeScores.forEach((score) => $("live-grid").appendChild(liveScoreCard(score)));
}

function scorePercent(score) {
  const min = axisMin(0), max = axisMax(0);
  return Math.max(0, Math.min(100, ((score - min) / (max - min)) * 100));
}

function scoreLine(score, label) {
  const row = document.createElement("div");
  row.className = "live-score-row";
  const name = document.createElement("span");
  name.className = "live-score-name";
  name.textContent = label || score.name;
  name.style.color = score.color;
  const track = document.createElement("span");
  track.className = "live-score-track";
  const fill = document.createElement("i");
  fill.style.width = `${scorePercent(score.score)}%`;
  fill.style.background = score.color;
  track.appendChild(fill);
  const value = document.createElement("strong");
  value.className = "mono";
  value.textContent = formatValue(score.score);
  row.append(name, track, value);
  return row;
}

function renderLiveScores(scores) {
  const host = $("live-scores");
  host.innerHTML = "";
  if (scores.length === 0) return;
  const heading = document.createElement("div");
  heading.className = "live-scores-head";
  const label = document.createElement("span");
  label.textContent = "Single-score inputs";
  const average = scores.reduce((total, score) => total + score.score, 0) / scores.length;
  const total = document.createElement("strong");
  total.className = "mono";
  total.textContent = `average ${formatValue(average)}`;
  heading.append(label, total);
  host.appendChild(heading);
  scores.forEach((score) => host.appendChild(scoreLine(score)));
}

function liveScoreCard(score) {
  const card = document.createElement("div");
  card.className = "live-mini live-score-card";
  card.appendChild(scoreLine(score));
  return card;
}

function participantColor(id) {
  const people = (S.state && S.state.participants) || [];
  const index = people.findIndex((person) => person.id === id);
  if (index >= 0 && people[index].color) return people[index].color;
  const pool = palette();
  return pool[(index < 0 ? 0 : index) % pool.length];
}

// My own colour, or null before the server has assigned one.
function selfColor() {
  const people = (S.state && S.state.participants) || [];
  const self = people.find((person) => person.id === S.selfId);
  return (self && self.color) || null;
}

// History outlives the people in it, so a shape whose author has left falls
// back to a stable palette slot rather than borrowing whoever holds that id now.
function knownColor(id) {
  if (!id) return null;
  const people = (S.state && S.state.participants) || [];
  const person = people.find((candidate) => candidate.id === id);
  return (person && person.color) || null;
}

function renderColorPicker(st) {
  // The organizer never submits a shape, so they have no colour to pick.
  setHidden($("color-picker"), S.organizer || !!S.demo);
  if (S.organizer || S.demo) return;
  const mine = selfColor();
  if (mine) S.color = mine;
  $("btn-color").style.background = mine || "var(--ink)";
  const taken = new Set((st.participants || [])
    .filter((person) => person.id !== S.selfId && person.color)
    .map((person) => person.color.toLowerCase()));
  const box = $("color-options");
  box.innerHTML = "";
  palette().forEach((color) => {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "color-option";
    option.style.background = color;
    const isMine = !!mine && color.toLowerCase() === mine.toLowerCase();
    // A colour in use elsewhere stays visible but unpickable — two identical
    // polygons on the overlay would be unreadable.
    option.disabled = taken.has(color.toLowerCase());
    option.classList.toggle("is-mine", isMine);
    option.setAttribute("aria-label", option.disabled ? `${color} — already taken` : color);
    option.setAttribute("aria-pressed", String(isMine));
    option.onclick = () => {
      S.color = color;
      send({ type: "set_color", color });
      openColorPicker(false);
    };
    box.appendChild(option);
  });
}

function openColorPicker(open) {
  setHidden($("color-options"), !open);
  $("btn-color").setAttribute("aria-expanded", String(open));
}

function drawStaticRadar(svg, axes, mins, maxes, shapes) {
  const cx = 180, cy = 180, radius = 132;
  const staticAngle = (i) => Radar.axisAngle(i, axes.length);
  const point = (i, value) => [
    cx + Math.cos(staticAngle(i)) * radius * ((value - mins[i]) / (maxes[i] - mins[i])),
    cy + Math.sin(staticAngle(i)) * radius * ((value - mins[i]) / (maxes[i] - mins[i])),
  ];
  const points = (values) => values.map((value, i) => point(i, value).join(",")).join(" ");
  svg.innerHTML = "";
  for (const fraction of [0.2, 0.4, 0.6, 0.8, 1]) {
    const ring = document.createElementNS(SVGNS, "polygon");
    ring.setAttribute("points", points(axes.map((_, i) => mins[i] + (maxes[i] - mins[i]) * fraction)));
    ring.setAttribute("class", fraction === 1 ? "ring ring-outer" : "ring");
    svg.appendChild(ring);
  }
  axes.forEach((axis, i) => {
    const [x, y] = point(i, maxes[i]);
    const line = document.createElementNS(SVGNS, "line");
    line.setAttribute("x1", cx); line.setAttribute("y1", cy); line.setAttribute("x2", x); line.setAttribute("y2", y);
    line.setAttribute("class", "axis-line");
    svg.appendChild(line);
    for (const value of [maxes[i]]) {
      const [tx, ty] = point(i, value);
      const position = Radar.tickPosition(tx, ty, staticAngle(i));
      const tick = document.createElementNS(SVGNS, "text");
      tick.setAttribute("x", position.x);
      tick.setAttribute("y", position.y);
      tick.setAttribute("text-anchor", position.anchor);
      tick.setAttribute("class", "tick-label");
      tick.textContent = formatValue(value);
      svg.appendChild(tick);
    }
    const label = document.createElementNS(SVGNS, "text");
    const position = Radar.labelPosition(x, y, staticAngle(i));
    label.setAttribute("x", position.x);
    label.setAttribute("y", position.y);
    label.setAttribute("class", "axis-label");
    label.setAttribute("fill", themeColor("--ink") || "#F4F1E8");
    label.setAttribute("text-anchor", position.anchor);
    label.textContent = axis;
    svg.appendChild(label);
  });
  shapes.forEach((shape) => {
    const polygon = document.createElementNS(SVGNS, "polygon");
    polygon.setAttribute("points", points(shape.values));
    polygon.setAttribute("class", "live-shape");
    polygon.setAttribute("fill", `${shape.color}22`);
    polygon.setAttribute("stroke", shape.color);
    const title = document.createElementNS(SVGNS, "title");
    title.textContent = shape.name;
    polygon.appendChild(title);
    svg.appendChild(polygon);
  });
}

/* ── organizer history ─────────────────────────────────────────────── */
function syncHistory(entries) {
  const next = entries || [];
  const grew = next.length > S.history.length;
  S.history = next;
  // Land on the newest issue as each round concludes; otherwise hold the
  // organizer's place so a routine state broadcast doesn't yank the view.
  if (grew) S.historyIndex = next.length - 1;
  S.historyIndex = Math.min(Math.max(S.historyIndex, 0), Math.max(next.length - 1, 0));
  renderHistory();
}

function renderHistory() {
  // Nothing has been completed yet — there is no history to offer.
  const has = S.organizer && S.history.length > 0;
  setHidden($("history-card"), !has);
  if (!has) return;

  const entry = S.history[S.historyIndex];
  const summary = entry.summary || {};
  // An issue keeps the aspects it was estimated against, which may not be the
  // ones the session is using now.
  const axes = (entry.axes && entry.axes.length) ? entry.axes : S.axes;
  const mins = entry.axisMins || axes.map((_, i) => axisMin(i));
  const maxes = entry.axisMaxes || axes.map((_, i) => axisMax(i));
  $("history-title").textContent = entry.title;
  $("history-position").textContent = `${S.historyIndex + 1} of ${S.history.length}`;
  $("btn-history-prev").disabled = S.historyIndex === 0;
  $("btn-history-next").disabled = S.historyIndex === S.history.length - 1;
  $("history-points").textContent = summary.storyPoints ?? "—";

  const averages = summary.averages || [];
  $("history-stats").innerHTML = averages.length === 0
    ? `<p class="hint">Answered with single scores only.</p>`
    : axes.map((axis, i) => `
    <div class="axis-row">
      <span class="lbl" style="color:${axisColor(i)}">${escapeHTML(axis)}</span>
      <span class="axis-bar"><i style="width:${averages[i] === undefined ? 0 : ((averages[i] - mins[i]) / (maxes[i] - mins[i])) * 100}%;background:${axisColor(i)}"></i></span>
      <span class="num mono">${averages[i] === undefined ? "—" : formatValue(averages[i])}</span>
    </div>`).join("");

  $("history-observations").innerHTML = (summary.observations || [])
    .map((observation) => `<li>${escapeHTML(observation)}</li>`).join("");
  setHidden($("history-insights-title"), !(summary.observations || []).length);

  // Every individual shape plus the group consensus, so the organizer can
  // still see who diverged on an issue they have already moved past.
  const shapes = (summary.shapes || []).map((shape, i) => ({
    id: `history-${i}`, name: shape.name, values: shape.values,
    color: knownColor(shape.id) || palette()[i % palette().length],
  }));
  if (averages.length) {
    shapes.push({ id: "history-avg", name: "Group", values: averages, color: "var(--pencil)" });
  }
  drawStaticRadar($("history-chart"), axes, mins, maxes, shapes);
}

function stepHistory(delta) {
  if (!S.organizer || S.history.length === 0) return;
  const next = Math.min(Math.max(S.historyIndex + delta, 0), S.history.length - 1);
  if (next === S.historyIndex) return;
  S.historyIndex = next;
  renderHistory();
}

function renderSummary(sum) {
  $("summary-card").hidden = false;
  $("points-num").textContent = sum.storyPoints;
  $("points-why").textContent = sum.pointsWhy;

  const averages = sum.averages || [];
  const spread = sum.spread || [];
  $("axis-stats").innerHTML = averages.length === 0
    ? `<p class="hint">Everyone answered with a single score, so there is nothing to break down per aspect.</p>`
    : S.axes.map((a, i) => `
    <div class="axis-row">
      <span class="lbl" style="color:${axisColor(i)}">${escapeHTML(a)}</span>
      <span class="axis-bar"><i style="width:${((averages[i] - axisMin(i)) / (axisMax(i) - axisMin(i))) * 100}%;background:${axisColor(i)}"></i></span>
      <span class="num mono">${formatValue(averages[i])} +/- ${formatValue(spread[i])}</span>
    </div>`).join("");

  $("observations").innerHTML = (sum.observations || [])
    .map((o) => `<li>${escapeHTML(o)}</li>`).join("");
  setHidden($("summary-insights-title"), !(sum.observations || []).length);

  const outlierNames = new Set((sum.outliers || []).map((o) => o.name));
  $("minis").innerHTML = (sum.shapes || []).map((sh) => miniSVG(sh, outlierNames.has(sh.name))).join("");
  // Redraw the big plot's red polygon as the final consensus.
  drawAverage(averages.length ? averages : null);
}

function miniSVG(shape, isOutlier) {
  const cx = 42, cy = 40, r = 30;
  const p = (i, v) => [
    cx + Math.cos(angle(i)) * r * ((v - axisMin(i)) / (axisMax(i) - axisMin(i))),
    cy + Math.sin(angle(i)) * r * ((v - axisMin(i)) / (axisMax(i) - axisMin(i))),
  ].join(",");
  const ring = S.axes.map((_, i) => p(i, axisMax(i))).join(" ");
  const poly = shape.values.map((v, i) => p(i, v)).join(" ");
  return `<div class="mini ${isOutlier ? "is-outlier" : ""}">
    <svg viewBox="0 0 84 78"><polygon points="${ring}" class="ring"/>
    <polygon points="${poly}" class="mini-shape"/></svg>
    <div class="name">${escapeHTML(shape.name)}</div></div>`;
}

/* ── countdown ─────────────────────────────────────────────────────── */
function clockText(ms) {
  const s = Math.ceil(Math.max(0, ms) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// A stopped clock keeps its reading but drops the running colour, so nobody
// watches a red number that is never going to move.
function showPausedClock(remainingMs) {
  stopCountdown();
  const elT = $("round-timer");
  elT.classList.add("is-paused");
  elT.textContent = clockText(remainingMs);
  showTimerFloat(true, false);
}

function startCountdown(deadlineMs) {
  stopCountdown();
  const elT = $("round-timer");
  elT.classList.remove("is-paused");
  if (!deadlineMs) { showTimerFloat(false); return; }
  showTimerFloat(true, true);
  const tick = () => { elT.textContent = clockText(deadlineMs - Date.now()); };
  tick();
  S.countdown = setInterval(tick, 250);
}
function stopCountdown() {
  if (S.countdown) clearInterval(S.countdown);
  S.countdown = null;
  showTimerFloat(false);
}

/* The clock is the one thing everyone in the room needs at a glance, so it
   floats clear of the content rather than living inside the issue card. */
function showTimerFloat(visible, running) {
  setHidden($("timer-float"), !visible);
  setHidden($("timer-controls"), !visible || !S.organizer);
  if (visible) $("btn-timer-toggle").textContent = running ? "Pause" : "Resume";
}

/* ── misc ──────────────────────────────────────────────────────────── */
let toastTimer = null;
function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/* ── wiring ────────────────────────────────────────────────────────── */
$("btn-create").onclick = () => {
  S.name = requiredNickname();
  if (!S.name) return;
  setHidden($("btn-demo"), true);
  S.live = false;
  S.drafts = [];
  S.settingsEdited = false;
  $("intake-items").innerHTML = "";
  $("draft-aspects").innerHTML = "";
  $("settings-items").innerHTML = "";
  $("setup-point-labels").innerHTML = "";
  $("setup-max").value = "8";
  connect({ type: "create", name: S.name });
};
$("btn-demo").onclick = () => setHidden($("demo-launcher"), false);
$("btn-demo-close").onclick = () => setHidden($("demo-launcher"), true);
$("btn-demo-organizer").onclick = () => startDemo("organizer");
$("btn-demo-participant").onclick = () => startDemo("participant");
$("btn-demo-prev").onclick = () => stepDemo(-1);
$("btn-demo-next").onclick = () => stepDemo(1);
$("btn-demo-exit").onclick = stopDemo;
$("in-name").oninput = updateEntryActions;
$("in-code").oninput = updateEntryActions;
$("btn-join").onclick = () => {
  const name = requiredNickname();
  if (!name) return;
  const code = $("in-code").value.trim().toUpperCase();
  if (code.length < 4) { toast("Enter the 5-character session code."); return; }
  setHidden($("btn-demo"), true);
  S.name = name;
  const saved = savedCreds();
  connect({
    type: "join", name: S.name, code,
    organizerToken: saved && saved.code === code ? saved.token : "",
  });
};
$("btn-submit").onclick = () => {
  send(estimatePayload("submit"));
  const r = S.state && S.state.round;
  if (r) S.submittedRound = r.number;
   render();
};
$("btn-timer").onclick = () => {
  const round = S.state && S.state.round;
  if (round && round.deadlineMs) {
    send({ type: "pause_timer" });
    return;
  }
  const typed = $("in-seconds").value.trim();
  // Nothing typed on a stopped clock means "carry on from where we were".
  if (!typed && round && round.pausedMs) {
    send({ type: "set_timer", seconds: 0 });
    return;
  }
  const secs = parseDuration(typed);
  if (secs === null) {
    toast("Enter a round length like 90s, 5m or 1m30s.");
    return;
  }
  if (secs <= 0) {
    toast("The round length has to be more than zero.");
    return;
  }
  send({ type: "set_timer", seconds: secs, scope: $("timer-scope").value });
};
$("btn-timer-remove").onclick = () => send({ type: "clear_timer", scope: $("timer-scope").value });
$("btn-timer-clear").onclick = () => send({ type: "clear_timer", scope: "issue" });
$("btn-timer-toggle").onclick = () => {
  const round = S.state && S.state.round;
  if (round && round.deadlineMs) send({ type: "pause_timer" });
  else send({ type: "set_timer", seconds: 0, scope: "issue" });
};
$("in-privacy").onchange = () => send({ type: "set_privacy", on: $("in-privacy").checked });
$("btn-mode-shape").onclick = () => { S.mode = "radar"; S.touched = true; render(); schedulePreview(); };
$("btn-mode-simple").onclick = () => { S.mode = "simple"; S.touched = true; render(); schedulePreview(); };
$("simple-slider").oninput = () => setSimple(Number($("simple-slider").value));
$("btn-end").onclick = () => {
  advanceIssue();
};
$("btn-end").onmouseenter = () => clearTimeout(S.nextResetTimer);
$("btn-end").onmouseleave = () => {
  const round = S.state && S.state.round;
  const pending = (S.state.participants || []).some((person) => !person.organizer && !person.submitted);
  if (!S.nextArmed || !round || !round.open || !pending) return;
  S.nextResetTimer = setTimeout(() => {
    resetNextConfirm();
    renderConsole(S.state.round);
  }, 2500);
};

function advanceIssue() {
  const round = S.state && S.state.round;
  if (S.state && S.state.finalSummary) {
    send({ type: "restart_session" });
    return;
  }
  if (!round || !round.open) {
    if (S.state && S.state.queuedItems === 0) {
      showIntake("more");
      return;
    }
    send({ type: "start_round", seconds: 0 });
    return;
  }
  const pending = (S.state.participants || []).filter((person) => !person.organizer && !person.submitted);
  if (pending.length && !S.nextArmed) {
    armNextConfirm();
    renderConsole(round);
    return;
  }
  resetNextConfirm();
  send({ type: "end_round" });
}
$("btn-color").onclick = () => {
  openColorPicker($("color-options").hasAttribute("hidden"));
};
// A palette floating over the chart has to get out of the way on the next
// click or key, or it sits on top of the handles the person came to drag.
document.addEventListener("pointerdown", (event) => {
  if (!$("color-picker").contains(event.target)) openColorPicker(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") openColorPicker(false);
});
$("btn-remind").onclick = () => send({ type: "remind" });
$("btn-restart-round").onclick = () => send({ type: "restart_round" });
$("btn-history-prev").onclick = () => stepHistory(-1);
$("btn-history-next").onclick = () => stepHistory(1);

// Arrow keys page through completed issues. Participants use the same keys to
// nudge their chart handles, so this only binds for the organizer and steps
// aside whenever a field or a focusable control has the keystroke.
document.addEventListener("keydown", (event) => {
  if (!S.organizer || S.history.length === 0) return;
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target;
  if (target && target.closest && target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']")) return;
  event.preventDefault();
  stepHistory(event.key === "ArrowLeft" ? -1 : 1);
});
$("btn-close").onclick = () => {
  if (confirm("Close the session for everyone? All rounds are erased.")) {
    send({ type: "close_session" });
  }
};
$("code-chip").onclick = () => {
  const link = `${location.origin}/?code=${S.code}`;
  navigator.clipboard.writeText(link)
    .then(() => toast("Invite link copied"))
    .catch(() => toast(`Invite link: ${link}`));
};

function confirmSessionDeparture() {
  return !!S.demo || !S.code || confirm("Leave this session? You can rejoin with the saved session code while it remains active.");
}

$("home-link").onclick = (event) => {
  if (S.demo) {
    event.preventDefault();
    stopDemo();
    return;
  }
  if (!S.code) return;
  if (!confirmSessionDeparture()) {
    event.preventDefault();
    return;
  }
  S.leftDeliberately = true;
  if (S.ws) try { S.ws.close(); } catch (_) {}
};

window.addEventListener("popstate", (event) => {
  const requested = event.state && event.state.view ? event.state.view : "landing";
  if (requested === "landing") {
    if (S.demo) {
      stopDemo();
      return;
    }
    if (S.code && !confirmSessionDeparture()) {
      recordView(S.view);
      return;
    }
    if (S.code) toLanding("Left session. Rejoin with the saved session code while it remains active.");
    else showView("landing");
    return;
  }
  if (requested === "settings" && S.organizer) {
    if (S.state && S.state.finalSummary) {
      showSession(false);
      if (S.state) render();
      return;
    }
    showSettings(S.settingsReturn, false);
    return;
  }
  if (requested === "intake" && S.organizer) {
    const round = S.state && S.state.round;
    // The initial intake entry predates a live round. Reopening it would offer
    // a launch that the server correctly rejects, so Back either leaves the
    // session deliberately or returns to the current round.
    if (round && round.open) {
      if (!confirmSessionDeparture()) {
        recordView(S.view);
        return;
      }
      toLanding("Left session. Rejoin with the saved session code while it remains active.");
      recordView("landing");
      return;
    }
    showIntake(S.intakeStage, false);
    return;
  }
  showSession(false);
  if (S.state) render();
});

window.addEventListener("beforeunload", (event) => {
  if (!S.code || S.demo) return;
  event.preventDefault();
  event.returnValue = "";
});

$("btn-open-settings").onclick = () => showSettings("intake", true);
$("btn-settings-back").onclick = backFromSettings;
$("btn-close-settings").onclick = () => closeSettings(true);
$("btn-intake-results").onclick = () => send({ type: "show_final_summary" });
$("btn-intake-back").onclick = () => {
  // Stepping back to read the last result must not bounce straight back to
  // intake on the next broadcast.
  S.reviewing = true;
  showSession(true);
  render();
};
function launchDrafts() {
  const items = draftItemValues();
  if (items.length === 0) {
    if (S.view === "settings") {
      $("settings-items-warning").textContent = "Session requires at least one issue.";
      setHidden($("settings-items-warning"), false);
      return;
    }
    $("intake-warning").textContent = "Enter an issue before launching.";
    setHidden($("intake-warning"), false);
    return;
  }
  const aspects = setupAspectNames();
  const max = setupMax();
  // Until someone edits the settings, omission means the server's standard
  // aspects. Once they have edited it, an incomplete custom set is intentional
  // enough to deserve a clear launch error rather than a silent reset.
  if ((S.settingsEdited && (aspects.length < 2 || aspects.length > 12)) || !max) {
    $("intake-warning").textContent = "Check the aspects in session settings — two to twelve are needed.";
    setHidden($("intake-warning"), false);
    showSettings("intake", true);
    renderProspectivePlot();
    return;
  }
  setHidden($("settings-items-warning"), true);
  setHidden($("intake-warning"), true);
  if (S.intakeStage === "more") {
    // The session is already configured; these issues join the queue behind it.
    send({ type: "append_items", items });
  } else {
    send({ type: "load_items", items, aspects: S.settingsEdited ? aspects : [], max, pointLabels: setupPointLabels() });
  }
  if (S.intakeStage === "more") S.drafts = [];
  S.reviewing = false;
  send({ type: "start_round" });
}
$("btn-launch").onclick = launchDrafts;
$("setup-max").oninput = renderSetupRange;
$("btn-live-overlay").onclick = () => {
  S.liveView = "overlay";
  const round = S.state && S.state.round;
  renderLiveInputs((round && round.liveShapes) || [], (round && round.liveScores) || []);
};
$("btn-live-grid").onclick = () => {
  S.liveView = "grid";
  const round = S.state && S.state.round;
  renderLiveInputs((round && round.liveShapes) || [], (round && round.liveScores) || []);
};

/* Every <details> in the app signals itself with this caret rather than the
   native triangle, which style.css suppresses globally. Built here so the
   JS-created drawers cannot drift from the ones written in index.html. */
function caretSpan() {
  const caret = document.createElement("span");
  caret.className = "caret";
  caret.setAttribute("aria-hidden", "true");
  return caret;
}

/* Issues typed on the intake screen live in one array, not in the DOM. Both
   intake and settings draw the same expandable row against that source so a
   title, description, and URL stay in step wherever they are edited. */
function addDraftItem(item = {}, focusIn = "intake") {
  S.drafts.push({
    id: item.id || itemID(),
    title: item.title || "",
    link: item.link || "",
    description: item.description || "",
    fieldMode: item.fieldMode || "raw",
  });
  renderDraftRows();
  if (S.view === "intake") renderIntakeCopy();
  if (S.view === "settings" || focusIn === "settings") renderSettingsItems();
  const host = focusIn === "settings" ? $("settings-items") : $("intake-items");
  const inputs = host.querySelectorAll(".intake-title-input");
  const last = inputs[inputs.length - 1];
  if (last) last.focus();
}

const ISSUE_FIELD_MODES = [
  { id: "raw", key: "title", label: "Issue title", next: "URL", icon: '<path d="M5 5h14M12 5v14M8 19h8"/>' },
  { id: "link", key: "link", label: "Issue URL", next: "description", icon: '<path d="M9.5 14.5l5-5M8 17H6.5a3.5 3.5 0 010-7h3M16 7h1.5a3.5 3.5 0 010 7h-3"/>' },
  { id: "description", key: "description", label: "Issue description", next: "title", icon: '<path d="M5 7h14M5 12h14M5 17h9"/>' },
];

function issueFieldMode(draft) {
  return ISSUE_FIELD_MODES.find((mode) => mode.id === draft.fieldMode) || ISSUE_FIELD_MODES[0];
}

function cycleDraftField(draft, context) {
  const current = ISSUE_FIELD_MODES.findIndex((mode) => mode.id === issueFieldMode(draft).id);
  draft.fieldMode = ISSUE_FIELD_MODES[(current + 1) % ISSUE_FIELD_MODES.length].id;
  renderDraftRows();
  if (S.view === "settings" || context === "settings") renderSettingsItems();
  const host = context === "settings" ? $("settings-items") : $("intake-items");
  const input = host.querySelector(`[data-draft-id="${draft.id}"] .issue-mode-input`);
  if (input) input.focus();
}

function issueModeIcon(mode) {
  const icon = document.createElementNS(SVGNS, "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = mode.icon;
  return icon;
}

function draftRow(draft, index, context) {
  const row = document.createElement("div");
  row.className = context === "settings" ? "draft-item-entry intake-row" : "intake-row";
  row.dataset.draftId = draft.id;
  const mode = issueFieldMode(draft);
  const field = document.createElement("div");
  field.className = `issue-mode-field field-mode-${mode.id}`;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "intake-title-input issue-mode-input";
  input.maxLength = mode.id === "description" ? 2000 : 200;
  input.placeholder = mode.label;
  input.setAttribute("aria-label", mode.label);
  input.value = draft[mode.key];
  input.oninput = () => {
    draft[mode.key] = input.value;
    if (mode.key === "title" && input.value.trim()) setHidden($("settings-items-warning"), true);
  };
  const modeButton = document.createElement("button");
  modeButton.type = "button";
  modeButton.className = "field-mode-toggle";
  modeButton.setAttribute("aria-label", `Switch field to ${mode.next}`);
  modeButton.title = `Switch to ${mode.next}`;
  modeButton.appendChild(issueModeIcon(mode));
  modeButton.onclick = () => cycleDraftField(draft, context);
  field.append(input, modeButton);
  row.append(field);
  if (index === S.drafts.length - 1) {
    const plus = document.createElement("button");
    plus.type = "button";
    plus.className = "btn row-plus";
    plus.textContent = "+";
    plus.setAttribute("aria-label", "Add issue");
    plus.onclick = () => addDraftItem({}, context);
    row.appendChild(plus);
  }
  // Keep one input available, but let every additional row be removed from
  // either screen without its metadata becoming orphaned.
  if (S.drafts.length > 1) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn row-minus";
    remove.textContent = "-";
    remove.setAttribute("aria-label", "Remove issue");
    remove.onclick = () => {
      S.drafts = S.drafts.filter((candidate) => candidate.id !== draft.id);
      renderDraftRows();
      if (S.view === "intake") renderIntakeCopy();
      if (S.view === "settings") renderSettingsItems();
    };
    row.appendChild(remove);
  }
  return row;
}

function renderDraftRows() {
  const host = $("intake-items");
  if (!host) return;
  host.innerHTML = "";
  S.drafts.forEach((draft, index) => host.appendChild(draftRow(draft, index, "intake")));
}

function renderSettingsItems() {
  const host = $("settings-items");
  if (!host) return;
  host.innerHTML = "";
  setHidden($("settings-items-empty"), S.drafts.length > 0);
  S.drafts.forEach((draft, index) => host.appendChild(draftRow(draft, index, "settings")));
}

function draftItemValues() {
  return S.drafts
    .map((draft) => ({
      id: draft.id,
      title: draft.title.trim(),
      link: draft.link.trim(),
      description: draft.description.trim(),
    }))
    .filter((item) => item.title);
}

function itemID() {
  if (globalThis.crypto && globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
  return `item-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function addDraftAspect(value = "", edited = true) {
  if (edited) S.settingsEdited = true;
  const row = document.createElement("div");
  row.className = "draft-item";
  const input = document.createElement("input");
  input.type = "text";
  input.maxLength = 24;
  input.placeholder = "Aspect name";
  input.value = value;
  input.oninput = () => {
    S.settingsEdited = true;
    refreshAspectControls();
    renderProspectivePlot();
  };
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "btn row-minus";
  remove.textContent = "-";
  remove.setAttribute("aria-label", "Remove aspect");
  remove.onclick = () => {
    S.settingsEdited = true;
    const rows = Array.from($("draft-aspects").children);
    // Leave one blank row behind so a deliberately empty schema still has a
    // right-edge plus affordance instead of stranding the organizer.
    if (rows.length === 1) input.value = "";
    else row.remove();
    refreshAspectControls();
    renderProspectivePlot();
  };
  row.append(input, remove);
  $("draft-aspects").appendChild(row);
  refreshAspectControls();
  input.focus();
  renderProspectivePlot();
}

function refreshAspectControls() {
  const rows = Array.from($("draft-aspects").children);
  rows.forEach((row) => row.querySelector(".row-plus")?.remove());
  const last = rows[rows.length - 1];
  if (!last) return;
  const plus = document.createElement("button");
  plus.type = "button";
  plus.className = "btn row-plus";
  plus.textContent = "+";
  plus.disabled = setupAspectNames().length >= 12;
  plus.setAttribute("aria-label", "Add aspect");
  plus.onclick = () => addDraftAspect();
  last.appendChild(plus);
}

function requiredNickname() {
  const name = $("in-name").value.trim();
  setHidden($("entry-warning"), !!name);
  if (!name) $("in-name").focus();
  return name;
}

function updateEntryActions() {
  // Both actions stay live; the nickname is only demanded at the moment
  // someone actually tries to enter a session.
  if ($("in-name").value.trim()) setHidden($("entry-warning"), true);
}

function savedCreds() {
  try { return JSON.parse(sessionStorage.getItem("tri")); } catch (_) { return null; }
}

/* Prefill from invite link or a refresh. */
(function init() {
  const urlCode = new URLSearchParams(location.search).get("code");
  const saved = savedCreds();
  if (urlCode) $("in-code").value = urlCode.toUpperCase();
  else if (saved && saved.code) $("in-code").value = saved.code;
  if (saved && saved.name) $("in-name").value = saved.name;
  if (saved && saved.color) S.color = saved.color;
  $("in-name").placeholder = randomNickname();
  updateEntryActions();
  if (history.replaceState) history.replaceState({ view: "landing" }, "", location.pathname + location.search);
  loadRemoteConfig();
})();

/* Test hook. Module-scope `const S` and the function declarations above are
   lexical bindings, so a headless harness cannot reach them off `window`.
   Scoped to local hosts so the deployed app exposes no internals — jsdom runs
   at http://localhost/, so the UI suite still tests shipped code. */
if (["localhost", "127.0.0.1", "[::1]", ""].includes(location.hostname)) {
  window.__test = {
    S, render, showSession, showIntake, showSettings, closeSettings, renderHistory, stepHistory,
    setHidden, addDraftItem, renderSettingsItems, safeLink, parseDuration, setSimple, roundAxes,
    startDemo, stopDemo, runDemoStep, stepDemo,
  };
}
