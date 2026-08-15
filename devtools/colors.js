/* Colour lab — local only. Edits :root inline for the live preview, and POSTs
   the changed tokens so the server rewrites static/style.css in place.

   Deliberately dependency-free and un-built: this file is a development tool,
   not something the app loads, so it should stay readable with no toolchain. */
"use strict";

const $ = (id) => document.getElementById(id);
const ROOT = document.documentElement;

let LOADED = [];              // tokens as they are on disk
let VALUES = new Map();       // name -> current editor value

/* ── colour maths ──────────────────────────────────────────────────── */
/* Same arithmetic the test suite uses. Duplicated rather than shared because
   the suite must be able to fail a palette this page never opened. */
function parseColor(value) {
  const raw = String(value == null ? "" : value).trim();
  const hex6 = /^#([0-9a-fA-F]{6})$/.exec(raw);
  if (hex6) {
    const n = parseInt(hex6[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const hex3 = /^#([0-9a-fA-F]{3})$/.exec(raw);
  if (hex3) {
    const c = hex3[1];
    return [parseInt(c[0] + c[0], 16), parseInt(c[1] + c[1], 16), parseInt(c[2] + c[2], 16), 1];
  }
  const fn = /^rgba?\(([^)]+)\)$/.exec(raw);
  if (!fn) return null;
  const parts = fn[1].split(",").map((p) => parseFloat(p));
  if (parts.length < 3 || parts.some((p) => Number.isNaN(p))) return null;
  return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
}

function composite(fg, bg) {
  const f = parseColor(fg);
  const b = parseColor(bg);
  if (!f || !b) return null;
  const out = [0, 1, 2].map((i) => Math.round((f[3] * f[i]) + ((1 - f[3]) * b[i])));
  return `rgb(${out[0]}, ${out[1]}, ${out[2]})`;
}

function luminance(value) {
  const c = parseColor(value);
  if (!c) return null;
  const chan = (v) => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  return (0.2126 * chan(c[0])) + (0.7152 * chan(c[1])) + (0.0722 * chan(c[2]));
}

function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  if (la === null || lb === null) return null;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const val = (name) => VALUES.get(name) || "";

/* ── editor ────────────────────────────────────────────────────────── */
function buildEditor(tokens) {
  const host = $("lab-tokens");
  host.textContent = "";
  let currentGroup = null;
  let groupBody = null;

  for (const token of tokens) {
    if (token.group !== currentGroup) {
      currentGroup = token.group;
      const section = document.createElement("div");
      section.className = "lab-group";
      const heading = document.createElement("h3");
      heading.textContent = currentGroup || "Ungrouped";
      section.appendChild(heading);
      host.appendChild(section);
      groupBody = section;
    }

    const row = document.createElement("div");
    row.className = "lab-token";
    row.dataset.name = token.name;

    // A native picker only understands #rrggbb; everything else (rgba, deg)
    // gets a preview chip and stays text-edited.
    const isHex6 = /^#[0-9a-fA-F]{6}$/.test(token.value);
    let picker = null;
    if (isHex6) {
      picker = document.createElement("input");
      picker.type = "color";
      picker.value = token.value;
      picker.setAttribute("aria-label", token.label || token.name);
      row.appendChild(picker);
    } else {
      const chip = document.createElement("span");
      chip.className = "lab-chip";
      chip.style.background = token.value;
      row.appendChild(chip);
    }

    const text = document.createElement("input");
    text.type = "text";
    text.value = token.value;
    text.spellcheck = false;
    text.setAttribute("aria-label", `${token.label || token.name} value`);
    row.appendChild(text);

    const name = document.createElement("div");
    name.className = "lab-name";
    name.innerHTML = "";
    const strong = document.createElement("b");
    strong.textContent = token.label || token.name;
    name.appendChild(strong);
    name.appendChild(document.createTextNode(` ${token.name}`));
    row.appendChild(name);

    const commit = (next) => {
      VALUES.set(token.name, next);
      ROOT.style.setProperty(token.name, next);
      if (picker && /^#[0-9a-fA-F]{6}$/.test(next)) picker.value = next;
      const chip = row.querySelector(".lab-chip");
      if (chip) chip.style.background = next;
      row.classList.toggle("is-dirty", next !== token.value);
      if (text.value !== next) text.value = next;
      refreshDerived();
    };

    if (picker) picker.addEventListener("input", () => commit(picker.value.toUpperCase()));
    text.addEventListener("input", () => commit(text.value.trim()));

    groupBody.appendChild(row);
  }
}

function applyAll() {
  for (const [name, value] of VALUES) ROOT.style.setProperty(name, value);
}

function changedTokens() {
  const out = {};
  for (const token of LOADED) {
    const now = val(token.name);
    if (now !== token.value) out[token.name] = now;
  }
  return out;
}

/* ── specimens that need generating ────────────────────────────────── */
function axisNames() {
  return LOADED.filter((t) => /^--axis-\d+$/.test(t.name)).map((t) => t.name);
}

function buildSwatchGrid(host, names) {
  host.textContent = "";
  for (const name of names) {
    const token = LOADED.find((t) => t.name === name);
    if (!token) continue;
    const cell = document.createElement("div");
    cell.className = "lab-swatch";
    const block = document.createElement("i");
    block.style.background = `var(${name})`;
    const caption = document.createElement("span");
    caption.dataset.swatchFor = name;
    caption.textContent = `${token.label} · ${val(name)}`;
    cell.append(block, caption);
    host.appendChild(cell);
  }
}

/* The specimen radar is drawn with the app's own geometry helper, so a change
   to axis maths shows up here too rather than drifting into a pretty lie. */
function buildRadar() {
  const svg = $("lab-radar");
  const NS = "http://www.w3.org/2000/svg";
  const CX = 180, CY = 180, R = 132;
  const axes = ["Uncertainty", "Complexity", "Toil"];
  const mine = [6, 3, 5];
  const average = [4, 5, 3];
  const other = [2, 6, 7];
  const angle = (i) => window.Radar.axisAngle(i, axes.length);
  const point = (i, v) => [CX + (Math.cos(angle(i)) * R * (v / 8)), CY + (Math.sin(angle(i)) * R * (v / 8))];
  const poly = (vals) => vals.map((v, i) => point(i, v).join(",")).join(" ");
  const add = (tag, attrs, parent) => {
    const node = document.createElementNS(NS, tag);
    for (const key in attrs) node.setAttribute(key, attrs[key]);
    (parent || svg).appendChild(node);
    return node;
  };

  svg.textContent = "";
  for (let ring = 1; ring <= 4; ring += 1) {
    add("polygon", {
      class: ring === 4 ? "ring ring-outer" : "ring",
      points: poly(axes.map(() => (ring / 4) * 8)),
    });
  }
  axes.forEach((label, i) => {
    const [x, y] = point(i, 8);
    add("line", { class: "axis-line", x1: CX, y1: CY, x2: x, y2: y, stroke: `var(--axis-${i + 1})` });
    const at = window.Radar.labelPosition(x, y, angle(i));
    const text = add("text", { class: "axis-label", x: at.x, y: at.y, "text-anchor": at.anchor, fill: `var(--axis-${i + 1})` });
    text.textContent = label;
    const tick = window.Radar.tickPosition(...point(i, 4), angle(i));
    const num = add("text", { class: "tick-label", x: tick.x, y: tick.y, "text-anchor": tick.anchor });
    num.textContent = "4";
  });
  add("polygon", { class: "live-shape", points: poly(other), stroke: "var(--axis-2)", fill: "var(--axis-2)" });
  add("polygon", { class: "avg-shape", points: poly(average) });
  add("polygon", { class: "my-shape", points: poly(mine) });
  mine.forEach((v, i) => {
    const [x, y] = point(i, v);
    const group = add("g", { class: "handle" });
    add("circle", { class: "hit", cx: x, cy: y }, group);
    add("circle", { class: "dot", cx: x, cy: y, stroke: `var(--axis-${i + 1})` }, group);
  });
}

function buildRoster() {
  const toggles = $("lab-live-toggles");
  const scores = $("lab-live-scores");
  const people = $("lab-people");
  const options = $("lab-color-options");
  const names = ["Waffle Wizard", "Cosmic Badger", "Laser Pigeon", "Quiet Otter"];
  toggles.textContent = "";
  people.textContent = "";
  options.textContent = "";
  for (const node of Array.from(scores.querySelectorAll(".live-score-row"))) node.remove();

  names.forEach((name, i) => {
    const colour = `var(--axis-${i + 1})`;

    const toggle = document.createElement("label");
    toggle.className = "live-toggle";
    const dot = document.createElement("i");
    dot.style.background = colour;
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = true;
    toggle.append(box, dot, document.createTextNode(name));
    toggles.appendChild(toggle);

    const row = document.createElement("div");
    row.className = "live-score-row";
    const who = document.createElement("span");
    who.className = "live-score-name";
    who.style.color = colour;
    who.textContent = name;
    const track = document.createElement("span");
    track.className = "live-score-track";
    const fill = document.createElement("i");
    fill.style.background = colour;
    fill.style.width = `${40 + (i * 15)}%`;
    track.appendChild(fill);
    const score = document.createElement("strong");
    score.textContent = String(3 + i);
    row.append(who, track, score);
    scores.appendChild(row);

    const person = document.createElement("span");
    person.className = i % 2 === 0 ? "person submitted" : "person";
    const check = document.createElement("span");
    check.className = "check";
    check.textContent = "✓";
    const label = document.createElement("span");
    label.textContent = name;
    label.style.color = colour;
    person.append(check, label);
    if (i === 0) {
      const org = document.createElement("span");
      org.className = "org";
      org.textContent = "organizer";
      person.appendChild(org);
    }
    people.appendChild(person);
  });

  axisNames().forEach((name, i) => {
    const option = document.createElement("button");
    option.type = "button";
    option.className = i === 1 ? "color-option is-mine" : "color-option";
    option.style.background = `var(${name})`;
    option.setAttribute("aria-label", name);
    if (i === 3) option.disabled = true;
    options.appendChild(option);
  });
}

function buildAxisStats() {
  const host = $("lab-axis-stats");
  host.textContent = "";
  ["Uncertainty", "Complexity", "Toil"].forEach((label, i) => {
    const row = document.createElement("div");
    row.className = "axis-row";
    const name = document.createElement("span");
    name.className = "lbl";
    name.textContent = label;
    const bar = document.createElement("span");
    bar.className = "axis-bar";
    const fill = document.createElement("i");
    fill.style.background = `var(--axis-${i + 1})`;
    fill.style.width = `${45 + (i * 18)}%`;
    bar.appendChild(fill);
    const num = document.createElement("span");
    num.className = "num";
    num.textContent = `${4 + i}.2 avg`;
    row.append(name, bar, num);
    host.appendChild(row);
  });
}

/* ── contrast table ────────────────────────────────────────────────── */
/* Mirrors the floors in static/ui.test.js. If you relax one, relax both, and
   say why in COLOR_RULES.md. */
function checkRows() {
  const rows = [];
  const families = [
    ["Issues", "--honey-deep"],
    ["Aspects", "--orange-deep"],
    ["Point labels", "--blue-deep"],
  ];
  for (const [label, deep] of families) {
    const shaded = composite(val("--panel-shade-deep"), val(deep));
    const slot = composite(val("--panel-slot"), shaded);
    const soft = composite(val("--panel-ink-soft"), slot);
    rows.push([`${label}: panel text`, "shaded corner", contrast(val("--panel-ink"), shaded), 4.5]);
    rows.push([`${label}: text in a row`, "recessed slot", contrast(val("--panel-ink"), slot), 4.5]);
    rows.push([`${label}: quiet copy`, "recessed slot", contrast(soft, slot), 4.5]);
    rows.push([`${label}: warning copy`, "shaded corner", contrast(val("--panel-warn"), shaded), 4.5]);
    rows.push([`${label}: recessed field`, "recessed slot", contrast(val("--surface-input"), slot), 3.0]);
  }
  const resultLit = composite(val("--deep-gloss"), val("--violet-lit"));
  rows.push(["Result: primary text", "lit corner", contrast(val("--ink"), resultLit), 4.5]);
  rows.push(["Result: secondary text", "lit corner", contrast(val("--muted"), resultLit), 4.5]);
  rows.push(["Result: score numeral", "lit corner", contrast(val("--pencil"), resultLit), 3.0]);
  rows.push(["Primary action label", "primary action", contrast(val("--on-primary"), val("--primary-action")), 4.5]);
  rows.push(["Coral action label", "consensus coral", contrast(val("--on-pencil"), val("--pencil")), 4.5]);
  rows.push(["Pending action label", "pending rose", contrast(val("--on-pending"), val("--pending")), 4.5]);
  for (const name of axisNames()) {
    const token = LOADED.find((t) => t.name === name);
    rows.push([`Participant: ${token.label.replace(/^Axis \d+ \/ /, "")}`, "live round card", contrast(val(name), val("--card")), 4.5]);
  }
  return rows;
}

function refreshDerived() {
  const body = $("lab-check-rows");
  body.textContent = "";
  let failures = 0;
  for (const [label, surface, ratio, floor] of checkRows()) {
    const tr = document.createElement("tr");
    const ok = ratio !== null && ratio >= floor;
    if (!ok) failures += 1;
    for (const [text, cls] of [[label, ""], [surface, ""], [ratio === null ? "—" : ratio.toFixed(2), "num"], [floor.toFixed(1), "num"]]) {
      const td = document.createElement("td");
      td.className = cls;
      td.textContent = text;
      tr.appendChild(td);
    }
    tr.lastChild.previousSibling.className = `num ${ok ? "lab-pass" : "lab-fail"}`;
    body.appendChild(tr);
  }
  for (const caption of document.querySelectorAll("[data-swatch-for]")) {
    const name = caption.dataset.swatchFor;
    const token = LOADED.find((t) => t.name === name);
    caption.textContent = `${token.label} · ${val(name)}`;
  }
  const dirty = Object.keys(changedTokens()).length;
  const status = $("lab-status");
  status.textContent = `${LOADED.length} tokens · ${dirty} changed · ${failures} contrast failure${failures === 1 ? "" : "s"}`;
  status.style.color = failures ? "var(--pencil)" : "var(--muted)";
}

/* ── save ──────────────────────────────────────────────────────────── */
async function save() {
  const updates = changedTokens();
  if (!Object.keys(updates).length) {
    $("lab-status").textContent = "Nothing changed.";
    return;
  }
  const failures = checkRows().filter(([, , ratio, floor]) => ratio === null || ratio < floor);
  if (failures.length) {
    const names = failures.map(([label]) => label).join(", ");
    if (!window.confirm(`${failures.length} pairing(s) fall below the legibility floor:\n\n${names}\n\nThe test suite will fail on this palette. Save anyway?`)) return;
  }
  try {
    const response = await fetch("/dev/colors/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || response.statusText);
    LOADED = LOADED.map((t) => (updates[t.name] === undefined ? t : { ...t, value: updates[t.name] }));
    for (const row of document.querySelectorAll(".lab-token")) row.classList.remove("is-dirty");
    $("lab-status").textContent = `Saved ${data.saved} token(s) to ${data.path}. Reload the app to see it served.`;
  } catch (err) {
    $("lab-status").textContent = `Save failed: ${err.message}`;
    $("lab-status").style.color = "var(--pencil)";
  }
}

function revert() {
  VALUES = new Map(LOADED.map((t) => [t.name, t.value]));
  for (const name of VALUES.keys()) ROOT.style.removeProperty(name);
  buildEditor(LOADED);
  refreshDerived();
  $("lab-status").textContent = "Reverted to the values on disk.";
}

/* The escape hatch: if you would rather paste the block into style.css by hand
   than let the server write it, this gives you exactly what it would have
   written. */
function copyBlock() {
  const lines = [":root {"];
  let group = null;
  for (const token of LOADED) {
    if (token.group !== group) {
      group = token.group;
      lines.push(`  /* @group ${group} */`);
    }
    const decl = `  ${token.name}: ${val(token.name)};`;
    lines.push(token.label ? `${decl.padEnd(46)} /* @label ${token.label} */` : decl);
  }
  lines.push("}");
  const text = lines.join("\n");
  navigator.clipboard.writeText(text).then(
    () => { $("lab-status").textContent = "Token block copied."; },
    () => { window.prompt("Copy the block:", text); },
  );
}

/* ── boot ──────────────────────────────────────────────────────────── */
async function boot() {
  try {
    const response = await fetch("/dev/colors/tokens");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || response.statusText);
    LOADED = data.tokens;
    $("lab-path").textContent = `Local only — Save writes straight into ${data.path}.`;
  } catch (err) {
    $("lab-status").textContent = `Could not read tokens: ${err.message}`;
    return;
  }
  VALUES = new Map(LOADED.map((t) => [t.name, t.value]));
  buildEditor(LOADED);
  applyAll();
  buildSwatchGrid($("lab-base"), [
    "--paper", "--paper-lift", "--card", "--card-raised", "--surface-input",
    "--surface-hover", "--grid", "--border", "--ink", "--muted", "--on-primary",
  ]);
  buildSwatchGrid($("lab-axes"), axisNames());
  buildRadar();
  buildRoster();
  buildAxisStats();
  refreshDerived();
  $("lab-save").addEventListener("click", save);
  $("lab-revert").addEventListener("click", revert);
  $("lab-copy").addEventListener("click", copyBlock);
}

boot();
