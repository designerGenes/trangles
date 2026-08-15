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
const AXIS_COLORS = ["#6D57B8", "#2A6F8E", "#A87428", "#C03B2D", "#43775C", "#9A4E86", "#536B9B", "#875E3A"];
/* Participants pick their own shape colour from this pool. The server owns the
   authoritative list and sends it on join — uniqueness is enforced there — so
   this copy is only the fallback for a boot that never reached a session. */
let PALETTE = AXIS_COLORS.slice();
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
const axisColor = (i) => AXIS_COLORS[i % AXIS_COLORS.length];
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
      x: position.x, y: position.y, class: "axis-label", fill: axisColor(i),
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
  return !!(r && r.open && !S.organizer && !selfSubmitted(S.state));
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
      if (Array.isArray(msg.colors) && msg.colors.length) PALETTE = msg.colors.slice();
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
  setHidden($("code-chip"), name === "landing" || !S.code);
  if (S.code) $("code-text").textContent = S.code;
  if (record) recordView(name);
}

function showSession(record) {
  showView("session", record);
  $("organizer-shelf").hidden = !S.organizer;
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
  if (S.drafts.length === 0) addDraftItem();
  renderIntake();
}

function renderIntake() {
  const more = S.intakeStage === "more";
  $("intake-eyebrow").textContent = more ? "Every issue pointed" : "New session";
  $("intake-title").textContent = more
    ? "Point another issue, or wrap up."
    : "Enter the first issue to point.";
  $("btn-launch").textContent = more ? "Add more issues" : "Launch pointing session";
  setHidden($("btn-intake-results"), !more);
  setHidden($("btn-intake-back"), !more || !(S.state && S.state.round));
  const done = (S.history || []).length;
  const points = (S.history || []).reduce((sum, entry) => sum + ((entry.summary && entry.summary.storyPoints) || 0), 0);
  $("intake-tally").textContent = `${done} issue${done === 1 ? "" : "s"} pointed · ${points} story points so far`;
  setHidden($("intake-tally"), !more || done === 0);
  renderDraftRows();
}

function showSettings(from, record) {
  S.settingsReturn = from || S.view || "intake";
  showView("settings", record);
  $("btn-close-settings").textContent = S.settingsReturn === "session"
    ? "Back to session"
    : "Launch pointing session";
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

function toLanding(message) {
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
  showView("landing");
  if (message) toast(message);
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
  setHidden($("submit-row"), S.organizer);

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
    setHidden($("feedback-card"), true);
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
  submitBtn.disabled = !r.open || mineIn;
  submitBtn.textContent = mineIn ? "Estimate submitted" : "Submit estimate";
  renderModeSwitch(r, mineIn);
  renderFeedback(r);
  // Organizers never submit, so they must not inflate the denominator —
  // "2 of 3" could otherwise never complete.
  const estimators = st.participants.filter((person) => !person.organizer).length;
  $("progress").textContent = `${r.submittedCount} of ${estimators} estimated`;

  if (r.open) {
    drawAverage(r.average || null);
    if (r.pausedMs) showPausedClock(r.pausedMs);
    else startCountdown(r.deadlineMs);
    $("summary-card").hidden = true;
    if (!S.organizer && S.previewRound !== r.number) {
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
    if (r.open) renderLiveInputs(r.liveShapes || []);
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
  const offer = !S.organizer && !!round && round.open && !submitted;
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
}

function setSimple(value) {
  const next = Math.round(Math.min(axisMax(0), Math.max(axisMin(0), value)));
  if (next === S.simple) return;
  S.simple = next;
  S.touched = true;
  drawSimple();
  schedulePreview();
}

/* Feedback is on the process, so it is asked once the issue is behind us and
   retired the moment it is answered. */
function renderFeedback(round) {
  const ask = !S.organizer && !!round && !round.open && !round.selfFeedback;
  setHidden($("feedback-card"), !ask);
  setHidden($("feedback-thanks"), !(round && round.selfFeedback));
  if (!ask) return;
  $("btn-feedback-up").setAttribute("aria-pressed", String(S.feedbackVote === "up"));
  $("btn-feedback-down").setAttribute("aria-pressed", String(S.feedbackVote === "down"));
  $("btn-feedback-up").classList.toggle("btn-primary", S.feedbackVote === "up");
  $("btn-feedback-down").classList.toggle("btn-primary", S.feedbackVote === "down");
}

function renderConsole(round) {
  if (!S.organizer) return;
  const open = !!(round && round.open);
  const queued = S.state.queuedItems || 0;
  const final = !!S.state.finalSummary;
  const finished = !!round && !open && queued === 0;
  const pending = (S.state.participants || []).filter((person) => !person.organizer && !person.submitted);
  const eligible = (S.state.participants || []).filter((person) => !person.organizer);
  const submitted = eligible.length - pending.length;
  const allSubmitted = eligible.length > 0 && pending.length === 0;
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
  // Aspects can only be added while there is a session to add them to.
  setHidden($("aspect-group"), final);
  $("aspect-scope").querySelector('option[value="issue"]').disabled = !open;
  if (!open && $("aspect-scope").value === "issue") $("aspect-scope").value = "remaining";
  $("in-privacy").checked = !!S.privacy;
  // Feedback only exists once an issue has actually been pointed.
  const feedback = (round && round.feedback) || null;
  setHidden($("feedback-group"), !feedback);
  if (feedback) {
    $("feedback-tally").textContent = `${feedback.up || 0} worked well · ${feedback.down || 0} felt off`;
    $("feedback-comments").innerHTML = (feedback.comments || [])
      .map((comment) => `<li>${escapeHTML(comment)}</li>`).join("");
  }
  // A group whose every control is hidden would otherwise leave a bare heading
  // floating in the shelf.
  setHidden($("round-group"), !canTime && !canRestart);
  // Adding work after the totals are published would change what the final
  // summary covers, so the queue editor goes away until restart.
  setHidden($("queue-editor"), final);
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

function renderPointLabelRows() {
  const max = setupMax();
  const current = Array.from($("setup-point-labels").querySelectorAll("input")).map((input) => input.value);
  $("setup-point-labels").innerHTML = "";
  if (!max) return;
  for (let value = 1; value <= max; value++) {
    const row = document.createElement("label");
    row.className = "point-label-row";
    const number = document.createElement("span");
    number.textContent = String(value);
    const input = document.createElement("input");
    input.maxLength = 24;
    input.placeholder = value === 1 ? "Light" : value === max ? "Heavy" : "Optional label";
    input.value = current[value - 1] ?? (value === 1 ? "Light" : value === max ? "Heavy" : "");
    row.append(number, input);
    $("setup-point-labels").appendChild(row);
  }
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
  drawStaticRadar($("setup-full-plot"), aspects, mins, maxes, [{ name: "Starting values", values, color: "#1E2B2F" }]);
}

function renderLiveInputs(shapes) {
  const section = $("live-inputs");
  section.hidden = false;
  const active = shapes.map((shape) => ({
    ...shape,
    color: participantColor(shape.id),
  }));
  $("btn-live-overlay").classList.toggle("btn-primary", S.liveView === "overlay");
  $("btn-live-grid").classList.toggle("btn-primary", S.liveView === "grid");
  // The active view is conveyed by colour alone otherwise.
  $("btn-live-overlay").setAttribute("aria-pressed", String(S.liveView === "overlay"));
  $("btn-live-grid").setAttribute("aria-pressed", String(S.liveView === "grid"));
  setHidden($("live-toggles"), S.liveView !== "overlay");
  setHidden($("live-overlay"), S.liveView !== "overlay");
  setHidden($("live-grid"), S.liveView !== "grid");
  const estimators = ((S.state && S.state.participants) || []).filter((person) => !person.organizer);
  const empty = active.length === 0;
  setHidden($("live-empty"), !empty);
  $("live-stage").classList.toggle("has-empty", empty);
  if (empty) {
    // Privacy already withholds previews; do not turn that into a roster leak.
    $("live-empty").textContent = S.privacy
      ? "Live charts are hidden while privacy mode is on."
      : estimators.length === 0
        ? "No participants are here to estimate yet."
        : "Waiting for participants to adjust a chart.";
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
      renderLiveInputs(shapes);
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
}

function participantColor(id) {
  const people = (S.state && S.state.participants) || [];
  const index = people.findIndex((person) => person.id === id);
  if (index >= 0 && people[index].color) return people[index].color;
  return PALETTE[(index < 0 ? 0 : index) % PALETTE.length];
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
  setHidden($("color-picker"), S.organizer);
  if (S.organizer) return;
  const mine = selfColor();
  if (mine) S.color = mine;
  $("btn-color").style.background = mine || "var(--ink)";
  const taken = new Set((st.participants || [])
    .filter((person) => person.id !== S.selfId && person.color)
    .map((person) => person.color.toLowerCase()));
  const box = $("color-options");
  box.innerHTML = "";
  PALETTE.forEach((color) => {
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
    color: knownColor(shape.id) || PALETTE[i % PALETTE.length],
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
$("in-name").oninput = updateEntryActions;
$("in-code").oninput = updateEntryActions;
$("btn-join").onclick = () => {
  const name = requiredNickname();
  if (!name) return;
  const code = $("in-code").value.trim().toUpperCase();
  if (code.length < 4) { toast("Enter the 5-character session code."); return; }
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
$("btn-add-queue-item").onclick = () => addQueueItem();
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
$("btn-apply-aspect").onclick = () => {
  const aspect = $("in-aspect").value.trim();
  if (!aspect) {
    toast("Name the aspect first.");
    return;
  }
  send({ type: "add_aspect", aspect, scope: $("aspect-scope").value });
  $("in-aspect").value = "";
};
$("btn-mode-shape").onclick = () => { S.mode = "radar"; S.touched = true; render(); schedulePreview(); };
$("btn-mode-simple").onclick = () => { S.mode = "simple"; S.touched = true; render(); schedulePreview(); };
$("simple-slider").oninput = () => setSimple(Number($("simple-slider").value));
$("btn-feedback-up").onclick = () => sendFeedback("up");
$("btn-feedback-down").onclick = () => sendFeedback("down");

function sendFeedback(vote) {
  S.feedbackVote = vote;
  send({ type: "submit_feedback", vote, comment: $("feedback-comment").value.trim() });
  $("feedback-comment").value = "";
}
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
  return !S.code || confirm("Leave this session? You can rejoin with the saved session code while it remains active.");
}

$("home-link").onclick = (event) => {
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
    if (S.code && !confirmSessionDeparture()) {
      recordView(S.view);
      return;
    }
    if (S.code) toLanding("Left session. Rejoin with the saved session code while it remains active.");
    else showView("landing");
    return;
  }
  if (requested === "settings" && S.organizer) {
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
  if (!S.code) return;
  event.preventDefault();
  event.returnValue = "";
});

$("btn-add-aspect").onclick = () => addDraftAspect();
$("btn-open-settings").onclick = () => showSettings("intake", true);
$("btn-session-settings").onclick = () => showSettings("session", true);
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
$("btn-live-overlay").onclick = () => { S.liveView = "overlay"; renderLiveInputs((S.state.round && S.state.round.liveShapes) || []); };
$("btn-live-grid").onclick = () => { S.liveView = "grid"; renderLiveInputs((S.state.round && S.state.round.liveShapes) || []); };

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
  });
  renderDraftRows();
  if (S.view === "settings" || focusIn === "settings") renderSettingsItems();
  const host = focusIn === "settings" ? $("settings-items") : $("intake-items");
  const inputs = host.querySelectorAll(".intake-title-input");
  const last = inputs[inputs.length - 1];
  if (last) last.focus();
}

function draftDetails(draft) {
  const details = document.createElement("details");
  details.className = "draft-details";
  const summary = document.createElement("summary");
  summary.append(document.createTextNode("Add description or link"), caretSpan());
  const fields = document.createElement("div");
  fields.className = "draft-meta-fields";
  const description = document.createElement("textarea");
  description.className = "item-description";
  description.maxLength = 2000;
  description.placeholder = "Optional issue description";
  description.value = draft.description;
  description.oninput = () => { draft.description = description.value; };
  const link = document.createElement("input");
  link.type = "url";
  link.className = "item-link";
  link.placeholder = "Optional issue URL";
  link.value = draft.link;
  link.oninput = () => { draft.link = link.value; };
  fields.append(description, link);
  details.append(summary, fields);
  return details;
}

function draftRow(draft, index, context) {
  const row = document.createElement("div");
  row.className = context === "settings" ? "draft-item-entry intake-row" : "intake-row";
  row.dataset.draftId = draft.id;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "intake-title-input";
  input.maxLength = 200;
  input.placeholder = "Issue title";
  input.value = draft.title;
  input.oninput = () => { draft.title = input.value; };
  row.append(input);
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
    remove.className = "btn btn-quiet";
    remove.textContent = "Remove";
    remove.onclick = () => {
      S.drafts = S.drafts.filter((candidate) => candidate.id !== draft.id);
      renderDraftRows();
      if (S.view === "settings") renderSettingsItems();
    };
    row.appendChild(remove);
  }
  row.appendChild(draftDetails(draft));
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

/* The shelf's queue rows keep their own collapsed link/description fields:
   mid-session an organizer is adding one issue in place, not visiting a
   settings screen to finish it. */
function itemMeta(item) {
  const meta = document.createElement("details");
  meta.className = "draft-item-meta";
  const summary = document.createElement("summary");
  summary.append(document.createTextNode("Add link or description"), caretSpan());
  const fields = document.createElement("div");
  fields.className = "draft-meta-fields";
  const link = document.createElement("input");
  link.type = "url";
  link.className = "item-link";
  link.placeholder = "Optional issue link";
  link.value = item.link || "";
  const description = document.createElement("textarea");
  description.className = "item-description";
  description.maxLength = 2000;
  description.placeholder = "Optional issue description";
  description.value = item.description || "";
  fields.append(link, description);
  meta.append(summary, fields);
  return meta;
}

function addQueueItem(item = {}) {
  const entry = document.createElement("div");
  entry.className = "queue-item";
  entry.dataset.itemId = item.id || itemID();
  const row = document.createElement("div");
  row.className = "draft-item";
  const title = document.createElement("input");
  title.type = "text";
  title.maxLength = 200;
  title.placeholder = "Issue title";
  title.value = item.title || "";
  const confirmButton = document.createElement("button");
  confirmButton.type = "button";
  confirmButton.className = "btn btn-primary queue-confirm";
  confirmButton.textContent = "Confirm";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "btn btn-quiet";
  remove.textContent = "Delete";
  remove.hidden = true;
  row.append(title, confirmButton, remove);
  const meta = itemMeta(item);
  const link = meta.querySelector(".item-link");
  const description = meta.querySelector(".item-description");
  entry.append(row, meta);

  confirmButton.onclick = () => {
    const queued = {
      id: entry.dataset.itemId,
      title: title.value.trim(),
      link: link.value.trim(),
      description: description.value.trim(),
    };
    if (!queued.title) {
      toast("Give the issue a title before confirming it.");
      title.focus();
      return;
    }
    send({ type: "append_items", items: [queued] });
    entry.classList.add("confirmed");
    title.disabled = true;
    link.disabled = true;
    description.disabled = true;
    confirmButton.hidden = true;
    remove.hidden = false;
  };
  remove.onclick = () => {
    if (entry.classList.contains("confirmed")) {
      send({ type: "delete_queued_item", itemId: entry.dataset.itemId });
    }
    entry.remove();
  };
  $("queue-items").appendChild(entry);
  title.focus();
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
  input.oninput = () => { S.settingsEdited = true; renderProspectivePlot(); };
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "btn btn-quiet";
  remove.textContent = "Remove";
  remove.onclick = () => { S.settingsEdited = true; row.remove(); renderProspectivePlot(); };
  row.append(input, remove);
  $("draft-aspects").appendChild(row);
  input.focus();
  renderProspectivePlot();
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
  };
}
