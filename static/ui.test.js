/* Headless checks for the organizer view. Loads the real index.html, radar.js,
   app.js and style.css so the assertions run against shipped code. */
"use strict";
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom"); // devDependency: npm i --no-save jsdom

const DIR = __dirname;
const read = (f) => fs.readFileSync(path.join(DIR, f), "utf8");

let failures = 0;
function check(name, cond, extra) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + JSON.stringify(extra)}`);
  if (!cond) failures++;
}

function boot() {
  // runScripts:"dangerously" with real <script> tags so app.js executes the way
  // the browser runs it. Top-level `const S` is a lexical binding, reachable
  // neither as window.S nor via eval(), so app.js exposes a test hook instead.
  const html = read("index.html");
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    url: "http://localhost/",
    resources: undefined,
    beforeParse(window) {
      window.WebSocket = function () { this.readyState = 0; this.send = () => {}; this.close = () => {}; };
      window.WebSocket.OPEN = 1;
      window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
    },
  });
  const { window } = dom;
  // Serve the local scripts/styles by hand — jsdom will not fetch them.
  for (const el of window.document.querySelectorAll("script[src]")) {
    const inline = window.document.createElement("script");
    inline.textContent = read(el.getAttribute("src"));
    el.replaceWith(inline);
  }
  const style = window.document.createElement("style");
  style.textContent = read("style.css");
  window.document.head.appendChild(style);
  return window;
}

const shown = (win, id) => {
  const el = win.document.getElementById(id);
  return win.getComputedStyle(el).display !== "none";
};

const stateMsg = (over = {}) => Object.assign({
  type: "state", code: "ABCDE",
  axes: ["Uncertainty", "Complexity", "Toil"],
  axisMins: [1, 1, 1], axisMaxes: [8, 8, 8],
  pointLabels: ["", "Light", "", "", "", "", "", "", "Heavy"],
  participants: [
    { id: "o", name: "Ada", organizer: true, submitted: false },
    { id: "g", name: "Lin", organizer: false, submitted: true },
  ],
  queuedItems: 1,
  round: { number: 1, title: "PROJ-1 first", open: true, submittedCount: 1, liveShapes: [] },
}, over);

const historyEntry = (n, title) => ({
  number: n, title,
  summary: {
    storyPoints: n + 2, averages: [5, 4, 3], spread: [1, 1, 1],
    observations: [`observation for ${title}`], outliers: [],
    shapes: [{ name: "Lin", values: [5, 4, 3] }],
  },
});

/* ── 1. Sum vs Individual actually switches ────────────────────────── */
{
  const win = boot();
  const S = win.__test.S;
  S.organizer = true; S.code = "ABCDE"; S.selfId = "o";
  win.__test.showSession();
  S.state = stateMsg();
  win.__test.render();

  check("live card visible for organizer", shown(win, "live-inputs"));
  check("Sum: overlay shown", shown(win, "live-overlay"));
  check("Sum: grid hidden", !shown(win, "live-grid"), win.getComputedStyle(win.document.getElementById("live-grid")).display);

  win.document.getElementById("btn-live-grid").click();
  check("Individual: overlay hidden", !shown(win, "live-overlay"), win.getComputedStyle(win.document.getElementById("live-overlay")).display);
  check("Individual: grid shown", shown(win, "live-grid"));
  check("Individual: toggles hidden", !shown(win, "live-toggles"));

  win.document.getElementById("btn-live-overlay").click();
  check("back to Sum: overlay shown", shown(win, "live-overlay"));
  check("back to Sum: grid hidden", !shown(win, "live-grid"));
}

/* ── 2. Organizer has no chart and no submit button ────────────────── */
{
  const win = boot();
  const S = win.__test.S;
  S.organizer = true; S.code = "ABCDE"; S.selfId = "o";
  win.__test.showSession();
  S.state = stateMsg();
  win.__test.render();
  check("organizer: own chart hidden", !shown(win, "plot-wrap"));
  check("organizer: submit row hidden", !shown(win, "submit-row"));
  check("organizer: progress excludes organizer", win.document.getElementById("progress").textContent === "1 of 1 estimated",
    win.document.getElementById("progress").textContent);

  const guest = boot();
  const gS = guest.__test.S; gS.organizer = false; gS.code = "ABCDE"; gS.selfId = "g";
  guest.__test.showSession();
  gS.state = stateMsg();
  guest.__test.render();
  check("participant: chart visible", shown(guest, "plot-wrap"));
  check("participant: submit row visible", shown(guest, "submit-row"));
}

/* ── 3. History appears only after an issue is completed ───────────── */
{
  const win = boot();
  const S = win.__test.S;
  S.organizer = true; S.code = "ABCDE"; S.selfId = "o";
  win.__test.showSession();

  S.state = stateMsg();
  win.__test.render();
  check("no history area with zero completed issues", !shown(win, "history-card"));

  S.state = stateMsg({ history: [historyEntry(1, "PROJ-1 first")] });
  win.__test.render();
  check("history appears after first completion", shown(win, "history-card"));
  check("history shows the issue title", win.document.getElementById("history-title").textContent === "PROJ-1 first");
  check("history position 1 of 1", win.document.getElementById("history-position").textContent === "1 of 1");
  check("prev disabled at start", win.document.getElementById("btn-history-prev").disabled);
  check("next disabled at end", win.document.getElementById("btn-history-next").disabled);
  check("history renders a chart", win.document.getElementById("history-chart").querySelectorAll("polygon").length > 0);

  // Second completion auto-selects the newest entry.
  S.state = stateMsg({ history: [historyEntry(1, "PROJ-1 first"), historyEntry(2, "PROJ-2 second")] });
  win.__test.render();
  check("newest issue auto-selected", win.document.getElementById("history-title").textContent === "PROJ-2 second");
  check("position 2 of 2", win.document.getElementById("history-position").textContent === "2 of 2");

  // Arrow buttons.
  win.document.getElementById("btn-history-prev").click();
  check("prev arrow pages back", win.document.getElementById("history-title").textContent === "PROJ-1 first");
  win.document.getElementById("btn-history-next").click();
  check("next arrow pages forward", win.document.getElementById("history-title").textContent === "PROJ-2 second");

  // Arrow keys.
  const key = (k, target) => {
    const e = new win.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
    (target || win.document.body).dispatchEvent(e);
    return e;
  };
  key("ArrowLeft");
  check("ArrowLeft pages back", win.document.getElementById("history-title").textContent === "PROJ-1 first");
  key("ArrowRight");
  check("ArrowRight pages forward", win.document.getElementById("history-title").textContent === "PROJ-2 second");
  key("ArrowLeft"); key("ArrowLeft");
  check("paging clamps at the oldest", win.document.getElementById("history-position").textContent === "1 of 2");

  // Typing in a field must not page the history.
  const seconds = win.document.getElementById("in-seconds");
  const ev = key("ArrowRight", seconds);
  check("arrow keys ignored inside inputs", win.document.getElementById("history-position").textContent === "1 of 2" && !ev.defaultPrevented);

  // A routine broadcast with no new completions holds the organizer's place.
  S.state = stateMsg({ history: [historyEntry(1, "PROJ-1 first"), historyEntry(2, "PROJ-2 second")] });
  win.__test.render();
  check("state refresh does not jump the view", win.document.getElementById("history-position").textContent === "1 of 2");
}

/* ── 4. Participants never receive/see history ─────────────────────── */
{
  const win = boot();
  const gs = win.__test.S; gs.organizer = false; gs.code = "ABCDE"; gs.selfId = "g";
  win.__test.showSession();
  gs.state = stateMsg({ history: [historyEntry(1, "PROJ-1 first")] });
  win.__test.render();
  check("participant: no history panel", !shown(win, "history-card"));
}

/* ── 5. Floating Next Issue + shelf caret ──────────────────────────── */
{
  const win = boot();
  const S = win.__test.S;
  S.organizer = true; S.code = "ABCDE"; S.selfId = "o";
  win.__test.showSession();

  S.state = stateMsg();
  win.__test.render();
  const rail = win.document.getElementById("end-rail");
  check("Next Issue visible while round open", shown(win, "end-rail"));
  check("Next Issue is fixed to the viewport", win.getComputedStyle(rail).position === "fixed",
    win.getComputedStyle(rail).position);
  check("Next Issue is outside the shelf", !win.document.getElementById("organizer-shelf").contains(win.document.getElementById("btn-end")));
  check("End Round shown when all votes are in", win.document.getElementById("btn-end").textContent === "End Round");

  S.state = stateMsg({ participants: [
    { id: "o", name: "Ada", organizer: true, submitted: false },
    { id: "g", name: "Lin", organizer: false, submitted: false },
  ] });
  win.__test.render();
  const next = win.document.getElementById("btn-end");
  check("pending vote rail is desaturated", next.classList.contains("is-pending"));
  next.click();
  check("first pending click arms confirmation", next.textContent === "Confirm" && next.classList.contains("is-confirm"));

  S.state = stateMsg({ round: { number: 1, title: "PROJ-1 first", open: false, submittedCount: 1, summary: historyEntry(1, "x").summary }, history: [historyEntry(1, "PROJ-1 first")] });
  win.__test.render();
  check("Next Issue remains visible while queued work remains", shown(win, "end-rail"));
  check("organizer: duplicate summary card hidden", !shown(win, "summary-card"));

  const caret = win.document.querySelector("#organizer-shelf summary .caret");
  check("shelf has a caret", !!caret);
  const shelf = win.document.getElementById("organizer-shelf");
  const closed = win.getComputedStyle(caret).transform;
  shelf.open = true;
  const opened = win.getComputedStyle(caret).transform;
  check("caret flips when the shelf opens", closed !== opened, { closed, opened });
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
