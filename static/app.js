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
const SILLY_NICKNAMES = ["Cosmic Badger", "Waffle Wizard", "Laser Pigeon", "Mango Comet", "Noodle Knight", "Pixel Yak"];
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
  hiddenLive: new Set(),
  history: [],
  historyIndex: 0,      // which completed issue the organizer is viewing
};

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
      S.axisMins = msg.axisMins || S.axes.map(() => 1);
      S.axisMaxes = msg.axisMaxes || S.axes.map(() => msg.axisMax || 10);
      S.pointLabels = msg.pointLabels || defaultPointLabels(S.axisMaxes[0]);
      S.my = S.axes.map((_, i) => startingValue(i));
      if (msg.organizerToken) S.orgToken = msg.organizerToken;
      sessionStorage.setItem("tri", JSON.stringify({
        code: S.code, name: S.name, token: S.orgToken || "",
      }));
      if (S.organizer) showSetup();
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
function showSession() {
  $("view-landing").hidden = true;
  $("view-setup").hidden = true;
  $("view-session").hidden = false;
  $("code-chip").hidden = false;
  $("code-text").textContent = S.code;
  $("organizer-shelf").hidden = !S.organizer;
  buildPlot();
}

function showSetup() {
  $("view-landing").hidden = true;
  $("view-session").hidden = true;
  $("view-setup").hidden = false;
  $("code-chip").hidden = true;
  if ($("draft-items").children.length === 0) addDraftItem();
  if ($("draft-aspects").children.length === 0) {
    ["Uncertainty", "Complexity", "Toil"].forEach((aspect) => addDraftAspect(aspect));
  }
  renderSetupRange();
  observeFullSetupChart();
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
  $("draft-items").innerHTML = "";
  $("draft-aspects").innerHTML = "";
  $("setup-point-labels").innerHTML = "";
  $("setup-max").value = "8";
  stopCountdown();
  $("view-session").hidden = true;
  $("view-setup").hidden = true;
  $("view-landing").hidden = false;
  $("code-chip").hidden = true;
  if (message) toast(message);
}

function render() {
  const st = S.state;
  if (!st) return;
  syncAxes(st.axes);
  if (st.round && !S.live) {
    S.live = true;
    showSession();
  }
  if (S.organizer && !S.live) {
    showSetup();
    return;
  }
  renderPeople(st);
  syncHistory(st.history);
  renderFinalSummary(st.finalSummary);
  const r = st.round;
  const title = $("round-title");
  const eyebrow = $("round-eyebrow");
  const submitBtn = $("btn-submit");
  // The organizer observes; they never contribute an estimate, so they get
  // neither their own chart nor a submit control.
  setHidden($("plot-wrap"), S.organizer);
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
    $("plot-wrap").classList.add("plot-disabled");
    renderConsole(null);
    return;
  }

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
  if (r.link) {
    title.href = r.link;
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
  // Organizers never submit, so they must not inflate the denominator —
  // "2 of 3" could otherwise never complete.
  const estimators = st.participants.filter((person) => !person.organizer).length;
  $("progress").textContent = `${r.submittedCount} of ${estimators} estimated`;

  if (r.open) {
    drawAverage(r.average || null);
    startCountdown(r.deadlineMs);
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
}

function syncAxes(axes) {
  const mins = S.state.axisMins || axes.map(() => 1);
  const maxes = S.state.axisMaxes || axes.map(() => 8);
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

function startingValue(i) {
  return Math.min(axisMax(i), Math.max(axisMin(i), 3));
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

function schedulePreview() {
  const r = S.state && S.state.round;
  if (!r || !r.open) return;
  clearTimeout(S.previewTimer);
  S.previewTimer = setTimeout(() => send({ type: "preview", values: S.my, touched: S.touched }), 40);
}

function selfSubmitted(state) {
  const self = state.participants && state.participants.find((person) => person.id === S.selfId);
  return !!(self && self.submitted);
}

function renderPeople(st) {
  $("people").innerHTML = st.participants.map((p) => `
    <span class="person ${p.submitted ? "submitted" : ""}">
      <span class="check">✓</span>${escapeHTML(p.name)}${p.id === S.selfId ? " (you)" : ""}
      ${p.organizer ? '<span class="org">org</span>' : ""}
      ${S.organizer && p.submitted && !p.responded ? '<span class="default-vote">default</span>' : ""}
    </span>`).join("");
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
  $("btn-start").hidden = true;
  $("btn-timer").hidden = !open;
  $("in-seconds").hidden = !open;
  $("btn-restart-round").hidden = open || final || !round;
  $("in-items").disabled = open;
  $("btn-load").disabled = open;
  // The floating action remains available after a summary while queued work
  // remains, so a closed shelf never implies the session is finished.
  setHidden($("end-rail"), !round || (!open && queued === 0 && !finished && !final));
  $("end-vote-count").textContent = open && eligible.length ? `Votes: ${submitted}/${eligible.length}` : "";
  $("btn-end").classList.toggle("is-pending", open && !allSubmitted && !S.nextArmed);
  $("btn-end").classList.toggle("is-confirm", open && !allSubmitted && S.nextArmed);
  if (final) {
    resetNextConfirm();
    $("btn-end").textContent = "Restart Session";
    $("end-hint").hidden = true;
  } else if (!open && queued === 0) {
    resetNextConfirm();
    $("btn-end").textContent = "Final Summary";
    $("end-hint").hidden = true;
  } else if (!open) {
    resetNextConfirm();
    $("btn-end").textContent = "Next Issue";
    $("end-hint").hidden = true;
  } else if (allSubmitted) {
    resetNextConfirm();
    $("btn-end").textContent = "End Round";
    $("end-hint").hidden = true;
  } else if (open && S.nextArmed) {
    $("btn-end").textContent = "Confirm";
    $("end-hint").textContent = "Votes are still pending.";
    $("end-hint").hidden = false;
  } else {
    $("btn-end").textContent = "Next Issue";
    $("end-hint").hidden = true;
  }
  $("queue-status").textContent = queued
    ? `${queued} issue${queued === 1 ? "" : "s"} ready`
    : "Load issues to begin";
  $("pending-panel").hidden = !open;
  $("pending-people").textContent = pending.length ? pending.map((person) => person.name).join(", ") : "All votes submitted.";
  $("btn-remind").disabled = pending.length === 0;
}

function renderFinalSummary(final) {
  setHidden($("final-summary-card"), !final);
  if (!final) return;
  $("final-points").textContent = final.totalPoints;
  $("final-issues").innerHTML = (final.issues || []).map((issue) => `
    <div class="final-issue"><span class="title">${escapeHTML(issue.title)}</span><span class="mono">${issue.summary ? issue.summary.storyPoints : 0}</span></div>`).join("");
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

function renderProspectivePlot() {
  const aspects = setupAspectNames();
  const max = setupMax();
  const validAspects = aspects.length >= 2 && aspects.length <= 12;
  $("setup-aspect-warning").hidden = validAspects;
  $("btn-launch").disabled = !validAspects || !max;
  $("setup-plot").hidden = !validAspects || !max;
  $("setup-full-chart").hidden = !validAspects || !max;
  $("setup-prospect").hidden = !validAspects || !max || fullSetupChartVisible;
  if (!validAspects || !max) {
    $("setup-plot").innerHTML = "";
    $("setup-full-plot").innerHTML = "";
    return;
  }
  const mins = aspects.map(() => 1);
  const maxes = aspects.map(() => max);
  const values = aspects.map(() => Math.min(max, 3));
  drawStaticRadar($("setup-plot"), aspects, mins, maxes, [{ name: "Starting values", values, color: "#1E2B2F" }]);
  drawStaticRadar($("setup-full-plot"), aspects, mins, maxes, [{ name: "Starting values", values, color: "#1E2B2F" }]);
}

function observeFullSetupChart() {
  if (setupChartObserver || !window.IntersectionObserver) return;
  setupChartObserver = new IntersectionObserver(([entry]) => {
    fullSetupChartVisible = entry.isIntersecting;
    $("setup-prospect").hidden = entry.isIntersecting;
  }, { threshold: 0.55 });
  setupChartObserver.observe($("setup-full-chart"));
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
  setHidden($("live-toggles"), S.liveView !== "overlay");
  setHidden($("live-overlay"), S.liveView !== "overlay");
  setHidden($("live-grid"), S.liveView !== "grid");
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
  drawStaticRadar($("live-overlay"), S.axes, S.axisMins, S.axisMaxes,
    active.filter((shape) => !S.hiddenLive.has(shape.id)));
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
  return AXIS_COLORS[index < 0 ? 0 : index];
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
  $("history-title").textContent = entry.title;
  $("history-position").textContent = `${S.historyIndex + 1} of ${S.history.length}`;
  $("btn-history-prev").disabled = S.historyIndex === 0;
  $("btn-history-next").disabled = S.historyIndex === S.history.length - 1;
  $("history-points").textContent = summary.storyPoints ?? "—";

  const averages = summary.averages || [];
  $("history-stats").innerHTML = S.axes.map((axis, i) => `
    <div class="axis-row">
      <span class="lbl" style="color:${axisColor(i)}">${escapeHTML(axis)}</span>
      <span class="axis-bar"><i style="width:${averages[i] === undefined ? 0 : ((averages[i] - axisMin(i)) / (axisMax(i) - axisMin(i))) * 100}%;background:${axisColor(i)}"></i></span>
      <span class="num mono">${averages[i] === undefined ? "—" : formatValue(averages[i])}</span>
    </div>`).join("");

  $("history-observations").innerHTML = (summary.observations || [])
    .map((observation) => `<li>${escapeHTML(observation)}</li>`).join("");

  // Every individual shape plus the group consensus, so the organizer can
  // still see who diverged on an issue they have already moved past.
  const shapes = (summary.shapes || []).map((shape, i) => ({
    id: `history-${i}`, name: shape.name, values: shape.values,
    color: AXIS_COLORS[i % AXIS_COLORS.length],
  }));
  if (averages.length) {
    shapes.push({ id: "history-avg", name: "Group", values: averages, color: "var(--pencil)" });
  }
  drawStaticRadar($("history-chart"), S.axes, S.axisMins, S.axisMaxes, shapes);
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

  $("axis-stats").innerHTML = S.axes.map((a, i) => `
    <div class="axis-row">
      <span class="lbl" style="color:${axisColor(i)}">${a}</span>
      <span class="axis-bar"><i style="width:${((sum.averages[i] - axisMin(i)) / (axisMax(i) - axisMin(i))) * 100}%;background:${axisColor(i)}"></i></span>
      <span class="num mono">${formatValue(sum.averages[i])} +/- ${formatValue(sum.spread[i])}</span>
    </div>`).join("");

  $("observations").innerHTML = (sum.observations || [])
    .map((o) => `<li>${escapeHTML(o)}</li>`).join("");

  const outlierNames = new Set((sum.outliers || []).map((o) => o.name));
  $("minis").innerHTML = (sum.shapes || []).map((sh) => miniSVG(sh, outlierNames.has(sh.name))).join("");
  // Redraw the big plot's red polygon as the final consensus.
  drawAverage(sum.averages);
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
function startCountdown(deadlineMs) {
  stopCountdown();
  const elT = $("round-timer");
  if (!deadlineMs) { elT.hidden = true; return; }
  elT.hidden = false;
  const tick = () => {
    const left = Math.max(0, deadlineMs - Date.now());
    const s = Math.ceil(left / 1000);
    elT.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  tick();
  S.countdown = setInterval(tick, 250);
}
function stopCountdown() {
  if (S.countdown) clearInterval(S.countdown);
  S.countdown = null;
  $("round-timer").hidden = true;
}

/* ── misc ──────────────────────────────────────────────────────────── */
let toastTimer = null;
let setupChartObserver = null;
let fullSetupChartVisible = false;
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
  $("draft-items").innerHTML = "";
  $("draft-aspects").innerHTML = "";
  $("setup-point-labels").innerHTML = "";
  $("setup-max").value = "8";
  connect({ type: "create", name: S.name });
};
$("in-name").oninput = updateEntryActions;
$("in-code").oninput = updateEntryActions;
$("btn-join").onclick = () => {
  const code = $("in-code").value.trim().toUpperCase();
  if (code.length < 4) { toast("Enter the 5-character session code."); return; }
  S.name = requiredNickname();
  if (!S.name) return;
  const saved = savedCreds();
  connect({
    type: "join", name: S.name, code,
    organizerToken: saved && saved.code === code ? saved.token : "",
  });
};
$("btn-submit").onclick = () => {
  send({ type: "submit", values: S.my });
  const r = S.state && S.state.round;
  if (r) S.submittedRound = r.number;
  render();
};
$("btn-load").onclick = () => {
  const items = $("in-items").value.split("\n").map((title) => ({ title }));
  send({ type: "replace_items", items });
};
$("btn-start").onclick = () => advanceIssue();
$("btn-timer").onclick = () => {
  const secs = parseInt($("in-seconds").value, 10);
  if (isNaN(secs) || secs <= 0) {
    toast("Enter a timer length in seconds.");
    return;
  }
  send({ type: "set_timer", seconds: secs });
};
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
      send({ type: "show_final_summary" });
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

$("btn-add-item").onclick = () => addDraftItem();
$("btn-add-aspect").onclick = () => addDraftAspect();
$("setup-prospect").onclick = () => $("setup-full-chart").scrollIntoView({ behavior: REDUCED ? "auto" : "smooth", block: "start" });
$("btn-launch").onclick = () => {
  const items = draftItemValues();
  if (items.length === 0) {
    toast("Add at least one issue before launching.");
    return;
  }
  const aspects = setupAspectNames();
  const max = setupMax();
  if (aspects.length < 2 || aspects.length > 12 || !max) {
    renderProspectivePlot();
    return;
  }
  send({ type: "load_items", items, aspects, max, pointLabels: setupPointLabels() });
  send({ type: "start_round" });
};
$("setup-max").oninput = renderSetupRange;
$("btn-live-overlay").onclick = () => { S.liveView = "overlay"; renderLiveInputs((S.state.round && S.state.round.liveShapes) || []); };
$("btn-live-grid").onclick = () => { S.liveView = "grid"; renderLiveInputs((S.state.round && S.state.round.liveShapes) || []); };

function addDraftItem(item = {}) {
  const entry = document.createElement("div");
  entry.className = "draft-item-entry";
  const row = document.createElement("div");
  row.className = "draft-item";
  const input = document.createElement("input");
  input.type = "text";
  input.maxLength = 200;
  input.placeholder = "Issue key and summary";
  input.value = item.title || "";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "btn btn-quiet";
  remove.textContent = "Remove";
  remove.onclick = () => entry.remove();
  row.append(input, remove);
  const meta = document.createElement("details");
  meta.className = "draft-item-meta";
  const summary = document.createElement("summary");
  summary.textContent = "Add link or description";
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
  meta.append(summary, link, description);
  entry.append(row, meta);
  $("draft-items").appendChild(entry);
  input.focus();
}

function addDraftAspect(value = "") {
  const row = document.createElement("div");
  row.className = "draft-item";
  const input = document.createElement("input");
  input.type = "text";
  input.maxLength = 24;
  input.placeholder = "Aspect name";
  input.value = value;
  input.oninput = renderProspectivePlot;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "btn btn-quiet";
  remove.textContent = "Remove";
  remove.onclick = () => { row.remove(); renderProspectivePlot(); };
  row.append(input, remove);
  $("draft-aspects").appendChild(row);
  input.focus();
  renderProspectivePlot();
}

function draftItemValues() {
  return Array.from($("draft-items").querySelectorAll(".draft-item-entry"))
    .map((entry) => ({
      title: entry.querySelector(".draft-item input").value.trim(),
      link: entry.querySelector(".item-link").value.trim(),
      description: entry.querySelector(".item-description").value.trim(),
    }))
    .filter((item) => item.title);
}

function requiredNickname() {
  const name = $("in-name").value.trim();
  if (!name) toast("Choose a nickname before entering a session.");
  return name;
}

function updateEntryActions() {
  const hasNickname = $("in-name").value.trim().length > 0;
  $("btn-create").disabled = !hasNickname;
  $("btn-join").disabled = !hasNickname || $("in-code").value.trim().length !== 5;
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
  $("in-name").placeholder = SILLY_NICKNAMES[Math.floor(Math.random() * SILLY_NICKNAMES.length)];
  updateEntryActions();
})();

/* Test hook. Module-scope `const S` and the function declarations above are
   lexical bindings, so a headless harness cannot reach them off `window`.
   Exposing them explicitly keeps the UI assertions running against shipped
   code instead of a copy. Harmless in the browser; nothing reads it there. */
window.__test = { S, render, showSession, renderHistory, stepHistory, setHidden };
