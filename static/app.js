/* Triangulate client — no framework, one WebSocket, one SVG. */
"use strict";

const $ = (id) => document.getElementById(id);
const SVGNS = "http://www.w3.org/2000/svg";
const AXIS_COLORS = ["#6D57B8", "#2A6F8E", "#A87428", "#C03B2D", "#43775C", "#9A4E86", "#536B9B", "#875E3A"];
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

const S = {
  ws: null,
  code: null,
  selfId: null,
  organizer: false,
  orgToken: null,
  name: "",
  axes: ["Uncertainty", "Complexity", "Toil"],
  axisMax: 10,
  my: [5, 5, 5],
  submittedRound: null,   // round number my last submit belongs to
  state: null,            // latest server snapshot
  live: false,
  leftDeliberately: false,
  dispAvg: null,          // animated average currently drawn
  countdown: null,
};

/* ── plot geometry ─────────────────────────────────────────────────── */
const CX = 180, CY = 180, R = 132, VMAX = () => S.axisMax;
const angle = (i) => S.axes.length === 2
  ? (i === 0 ? Math.PI : 0)
  : (-Math.PI / 2) + ((2 * Math.PI * i) / S.axes.length);
const axisColor = (i) => AXIS_COLORS[i % AXIS_COLORS.length];
const pt = (i, v) => [
  CX + Math.cos(angle(i)) * R * (v / VMAX()),
  CY + Math.sin(angle(i)) * R * (v / VMAX()),
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
  for (let v = 2; v <= VMAX(); v += 2) {
    el("polygon", {
      points: polyPoints(S.axes.map(() => v)),
      class: "ring" + (v === VMAX() ? " ring-outer" : ""),
    });
  }
  S.axes.forEach((name, i) => {
    const [x, y] = pt(i, VMAX());
    el("line", {
      x1: CX, y1: CY, x2: x, y2: y,
      class: "axis-line", stroke: axisColor(i),
    });
    // Tick labels along the axis (2..10) — enough to read values off the grid.
    for (let v = 2; v <= VMAX(); v += 4) {
      const [tx, ty] = pt(i, v);
      el("text", { x: tx + 4, y: ty - 4, class: "tick-label" }).textContent = v;
    }
    const lx = CX + Math.cos(angle(i)) * (R + 26);
    const ly = CY + Math.sin(angle(i)) * (R + 26);
    const cos = Math.cos(angle(i));
    const anchor = cos > 0.1 ? "end" : cos < -0.1 ? "start" : "middle";
    const label = el("text", {
      x: lx, y: ly + 4, class: "axis-label", fill: axisColor(i),
      "text-anchor": anchor,
    });
    label.textContent = name;
  });

  plot.avg = el("polygon", { points: polyPoints(S.axes.map(() => 0)), class: "avg-shape", visibility: "hidden" });
  plot.mine = el("polygon", { points: polyPoints(S.my), class: "my-shape" });

  plot.handles = S.axes.map((name, i) => {
    const g = el("g", {
      class: "handle", tabindex: 0, role: "slider",
      "aria-label": name, "aria-valuemin": 0, "aria-valuemax": VMAX(),
      "aria-valuenow": S.my[i],
    });
    el("circle", { class: "hit" }, g);
    const dot = el("circle", { class: "dot", stroke: axisColor(i) }, g);
    g._dot = dot;
    g.addEventListener("keydown", (e) => {
      const step = { ArrowUp: 0.5, ArrowRight: 0.5, ArrowDown: -0.5, ArrowLeft: -0.5 }[e.key];
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
      setAxis(i, Radar.projectAxis(p, { x: CX, y: CY }, angle(i), R, VMAX()));
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
    const value = Radar.quantizeAxis(Radar.projectAxis(point, { x: CX, y: CY }, angle(i), R, VMAX()), VMAX());
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
  v = Radar.quantizeAxis(v, VMAX());
  if (v === S.my[i]) return;
  S.my[i] = v;
  drawMine();
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
    if (ro) ro.textContent = S.my[i].toFixed(1);
  });
}

function buildReadouts() {
  $("readouts").innerHTML = S.axes.map((a, i) =>
    `<div class="readout"><div id="ro-${i}" class="val" style="color:${axisColor(i)}">${S.my[i].toFixed(1)}</div>
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
  return !!(r && r.open);
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
      S.axisMax = msg.axisMax;
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
}

function toLanding(message) {
  S.leftDeliberately = true;
  if (S.ws) try { S.ws.close(); } catch (_) {}
  S.ws = null; S.state = null; S.code = null; S.submittedRound = null; S.live = false;
  $("draft-items").innerHTML = "";
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
  const r = st.round;
  const title = $("round-title");
  const eyebrow = $("round-eyebrow");
  const submitBtn = $("btn-submit");

  if (!r) {
    eyebrow.textContent = "Waiting";
    title.textContent = S.organizer
      ? "Post an issue below to start the first round."
      : "Waiting for the organizer to post an issue.";
    title.classList.add("idle");
    submitBtn.disabled = true;
    $("progress").textContent = "";
    $("summary-card").hidden = true;
    drawAverage(null);
    stopCountdown();
    $("plot-wrap").classList.add("plot-disabled");
    renderConsole(null);
    return;
  }

  title.textContent = r.title;
  title.classList.remove("idle");
  eyebrow.textContent = `Round ${r.number} — ${r.open ? "estimating" : "concluded"}`;
  $("plot-wrap").classList.toggle("plot-disabled", !r.open);

  const mineIn = r.number === S.submittedRound;
  submitBtn.disabled = !r.open;
  submitBtn.textContent = mineIn ? "Update estimate" : "Submit estimate";
  $("progress").textContent = `${r.submittedCount} of ${st.participants.length} estimated`;

  if (r.open) {
    drawAverage(r.average || null);
    startCountdown(r.deadlineMs);
    $("summary-card").hidden = true;
  } else {
    stopCountdown();
    if (r.summary) renderSummary(r.summary);
  }
  renderConsole(r);
}

function syncAxes(axes) {
  if (!axes || (axes.length === S.axes.length && axes.every((axis, i) => axis === S.axes[i]))) return;
  S.axes = axes.slice();
  S.my = S.axes.map((_, i) => S.my[i] === undefined ? 5 : S.my[i]);
  S.dispAvg = null;
  buildPlot();
}

function renderPeople(st) {
  $("people").innerHTML = st.participants.map((p) => `
    <span class="person ${p.submitted ? "submitted" : ""}">
      <span class="check">✓</span>${escapeHTML(p.name)}${p.id === S.selfId ? " (you)" : ""}
      ${p.organizer ? '<span class="org">org</span>' : ""}
    </span>`).join("");
}

function renderConsole(round) {
  if (!S.organizer) return;
  const open = !!(round && round.open);
  const queued = S.state.queuedItems || 0;
  $("btn-start").hidden = open || queued === 0;
  $("in-items").disabled = open;
  $("btn-load").disabled = open;
  $("custom-aspects").disabled = open;
  $("in-aspects").disabled = open;
  $("btn-end").hidden = !open;
  $("queue-status").textContent = queued
    ? `${queued} issue${queued === 1 ? "" : "s"} ready`
    : "Load issues to begin";
}

function renderSummary(sum) {
  $("summary-card").hidden = false;
  $("points-num").textContent = sum.storyPoints;
  $("points-why").textContent = sum.pointsWhy;

  $("axis-stats").innerHTML = S.axes.map((a, i) => `
    <div class="axis-row">
      <span class="lbl" style="color:${axisColor(i)}">${a}</span>
      <span class="axis-bar"><i style="width:${(sum.averages[i] / S.axisMax) * 100}%;background:${axisColor(i)}"></i></span>
      <span class="num mono">${sum.averages[i].toFixed(1)} ± ${sum.spread[i].toFixed(1)}</span>
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
    cx + Math.cos(angle(i)) * r * (v / S.axisMax),
    cy + Math.sin(angle(i)) * r * (v / S.axisMax),
  ].join(",");
  const ring = S.axes.map((_, i) => p(i, S.axisMax)).join(" ");
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
  S.name = $("in-name").value.trim() || "Anonymous";
  S.live = false;
  $("draft-items").innerHTML = "";
  connect({ type: "create", name: S.name });
};
$("btn-join").onclick = () => {
  const code = $("in-code").value.trim().toUpperCase();
  if (code.length < 4) { toast("Enter the 5-character session code."); return; }
  S.name = $("in-name").value.trim() || "Anonymous";
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
  const items = $("in-items").value.split("\n");
  const aspects = $("custom-aspects").checked ? $("in-aspects").value.split("\n") : [];
  send({ type: "load_items", items, aspects });
};
$("custom-aspects").onchange = () => {
  $("custom-aspect-field").hidden = !$("custom-aspects").checked;
};
$("btn-start").onclick = () => {
  const secs = parseInt($("in-seconds").value, 10);
  send({ type: "start_round", seconds: isNaN(secs) ? 0 : secs });
};
$("btn-end").onclick = () => send({ type: "end_round" });
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
$("btn-launch").onclick = () => {
  const items = draftItemValues();
  if (items.length === 0) {
    toast("Add at least one issue before launching.");
    return;
  }
  const aspects = $("setup-custom-aspects").checked ? $("setup-aspects").value.split("\n") : [];
  send({ type: "load_items", items, aspects });
  send({ type: "start_round" });
};
$("setup-custom-aspects").onchange = () => {
  $("setup-aspect-field").hidden = !$("setup-custom-aspects").checked;
};

function addDraftItem(value = "") {
  const row = document.createElement("div");
  row.className = "draft-item";
  const input = document.createElement("input");
  input.type = "text";
  input.maxLength = 200;
  input.placeholder = "Issue key and summary";
  input.value = value;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "btn btn-quiet";
  remove.textContent = "Remove";
  remove.onclick = () => row.remove();
  row.append(input, remove);
  $("draft-items").appendChild(row);
  input.focus();
}

function draftItemValues() {
  return Array.from($("draft-items").querySelectorAll("input"))
    .map((input) => input.value.trim())
    .filter(Boolean);
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
})();
