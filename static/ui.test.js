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

// Whether the user can actually see it: an element inside a hidden wrapper is
// hidden, but jsdom's computed style is per-element and won't tell you that.
const visible = (win, id) => {
  let node = win.document.getElementById(id);
  while (node && node.nodeType === 1) {
    if (node.hasAttribute("hidden")) return false;
    if (win.getComputedStyle(node).display === "none") return false;
    node = node.parentElement;
  }
  return true;
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

/* ── 5. Floating round action + shelf caret ────────────────────────── */
{
  const win = boot();
  const S = win.__test.S;
  S.organizer = true; S.code = "ABCDE"; S.selfId = "o";
  win.__test.showSession();

  S.state = stateMsg();
  win.__test.render();
  const rail = win.document.getElementById("end-rail");
  check("round action visible while round open", shown(win, "end-rail"));
  check("round action is fixed to the viewport", win.getComputedStyle(rail).position === "fixed",
    win.getComputedStyle(rail).position);
  check("round action is outside the shelf", !win.document.getElementById("organizer-shelf").contains(win.document.getElementById("btn-end")));
  // A live round is never advanced straight to the next issue: the button ends
  // the round, and only the summary offers what comes after it.
  check("open round offers Finish round", win.document.getElementById("btn-end").textContent === "Finish round",
    win.document.getElementById("btn-end").textContent);

  S.state = stateMsg({ participants: [
    { id: "o", name: "Ada", organizer: true, submitted: false },
    { id: "g", name: "Lin", organizer: false, submitted: false },
  ] });
  win.__test.render();
  const next = win.document.getElementById("btn-end");
  check("open round with pending votes still offers Finish round", next.textContent === "Finish round", next.textContent);
  check("pending vote rail is desaturated", next.classList.contains("is-pending"));
  next.click();
  check("first pending click arms confirmation", next.textContent === "Confirm" && next.classList.contains("is-confirm"));

  S.state = stateMsg({ round: { number: 1, title: "PROJ-1 first", open: false, submittedCount: 1, summary: historyEntry(1, "x").summary }, history: [historyEntry(1, "PROJ-1 first")] });
  win.__test.render();
  check("round action remains visible while queued work remains", shown(win, "end-rail"));
  check("concluded round offers Next issue", next.textContent === "Next issue", next.textContent);
  check("organizer: duplicate summary card hidden", !shown(win, "summary-card"));

  const caret = win.document.querySelector("#organizer-shelf summary .caret");
  check("shelf has a caret", !!caret);
  const shelf = win.document.getElementById("organizer-shelf");
  const closed = win.getComputedStyle(caret).transform;
  shelf.open = true;
  const opened = win.getComputedStyle(caret).transform;
  check("caret flips when the shelf opens", closed !== opened, { closed, opened });

  win.document.getElementById("btn-add-queue-item").click();
  const queueRow = win.document.querySelector(".queue-item");
  const queueTitle = queueRow.querySelector(".draft-item input");
  queueTitle.value = "PROJ-3 queued";
  queueRow.querySelector(".queue-confirm").click();
  check("confirmed queue row locks its title", queueRow.classList.contains("confirmed") && queueTitle.disabled);
  check("confirmed queue row exposes deletion", !queueRow.querySelector(".btn-quiet").hidden);
}

/* ── 6. Every disclosure signals itself the same way ───────────────── */
{
  const win = boot();
  const T = win.__test;
  T.S.organizer = true; T.S.code = "ABCDE"; T.S.selfId = "o";

  // Populate the JS-built drawers in both the setup and shelf paths.
  T.showSetup();
  T.addDraftItem({ title: "PROJ-1" });
  win.document.getElementById("btn-add-queue-item").click();

  const summaries = Array.from(win.document.querySelectorAll("details > summary"));
  check("found the app's disclosures", summaries.length >= 5, summaries.length);

  const missingCaret = summaries.filter((s) => !s.querySelector(".caret"))
    .map((s) => s.textContent.trim().slice(0, 40));
  check("every summary has a caret", missingCaret.length === 0, missingCaret);

  // Drawers inside drawers bury controls and push their labels to different
  // left edges. The one allowed nesting is an issue's own link/description,
  // which sits inside that issue's container and nowhere else.
  const nested = Array.from(win.document.querySelectorAll("details details"))
    .filter((d) => !d.classList.contains("draft-item-meta"))
    .map((d) => d.querySelector("summary").textContent.trim().slice(0, 40));
  check("no drawer contains another drawer", nested.length === 0, nested);

  const strays = Array.from(win.document.querySelectorAll(".draft-item-meta"))
    .filter((meta) => !meta.parentElement.matches(".draft-item-entry, .queue-item"));
  check("item fields stay inside their issue container", strays.length === 0, strays.length);

  // A native triangle alongside the custom caret would double the affordance.
  // jsdom hardcodes display:list-item for <summary> whatever the stylesheet
  // says, so assert the suppression at the source instead of via layout.
  const css = read("style.css");
  check("native marker suppressed globally, not per-class",
    /(^|\n)summary::marker \{[^}]*content: ""/.test(css)
    && /(^|\n)summary::-webkit-details-marker \{[^}]*display: none/.test(css));
  check("no per-class marker suppression left to drift from",
    !/\.[a-z-]+ summary::(-webkit-details-)?marker/.test(css),
    (css.match(/\.[a-z-]+ summary::(-webkit-details-)?marker/g) || []));

  // Closed points down, open points up — same rotation everywhere.
  const details = win.document.querySelector(".queue-item .draft-item-meta");
  const caret = details.querySelector(".caret");
  const closed = win.getComputedStyle(caret).transform;
  details.open = true;
  const opened = win.getComputedStyle(caret).transform;
  check("issue field caret flips when opened", closed !== opened, { closed, opened });
}

/* ── 7. Organizer-controlled strings cannot inject markup ──────────── */
{
  const win = boot();
  const T = win.__test;
  T.S.organizer = false; T.S.code = "ABCDE"; T.S.selfId = "g";
  T.showSession();
  const evil = '<img src=x onerror="window.__PWNED=1">';
  const summary = { storyPoints: 3, averages: [5, 4, 3], spread: [1, 1, 1], observations: [evil], outliers: [], shapes: [{ name: evil, values: [5, 4, 3] }] };
  T.S.state = stateMsg({ axes: [evil, "Complexity", "Toil"], round: { number: 1, title: "PROJ-1", open: false, submittedCount: 1, summary } });
  T.render();
  check("aspect names are escaped in the summary", win.document.querySelectorAll("#axis-stats img").length === 0);
  check("observations are escaped", win.document.querySelectorAll("#observations img").length === 0);
  check("participant names are escaped", win.document.querySelectorAll("#minis img").length === 0);
  check("no injected script ran", win.__PWNED === undefined);
}

/* ── 8. The capstone leaves the round stage behind ─────────────────── */
{
  const win = boot();
  const T = win.__test;
  T.S.organizer = true; T.S.code = "ABCDE"; T.S.selfId = "o";
  T.showSession();

  const finished = { number: 2, title: "PROJ-2 second", open: false, submittedCount: 1,
    summary: { storyPoints: 5, averages: [5, 4, 3], spread: [1, 1, 1], observations: [], outliers: [], shapes: [] } };

  // Mid-session: the round stage is what you see.
  T.S.state = stateMsg({ round: finished, queuedItems: 0, history: [historyEntry(1, "PROJ-1 first"), historyEntry(2, "PROJ-2 second")] });
  T.render();
  check("round stage visible before the final summary", shown(win, "round-stage"));
  check("capstone hidden before the final summary", !shown(win, "final-summary-card"));

  // Concluded: the whole per-round stack is left behind, not stacked under.
  T.S.state = stateMsg({ round: finished, queuedItems: 0,
    history: [historyEntry(1, "PROJ-1 first"), historyEntry(2, "PROJ-2 second")],
    finalSummary: { totalPoints: 8, issues: [{ title: "PROJ-1 first", summary: { storyPoints: 3 } }, { title: "PROJ-2 second", summary: { storyPoints: 5 } }] } });
  T.render();
  check("capstone visible when concluded", shown(win, "final-summary-card"));
  check("round stage left behind", !shown(win, "round-stage"));
  check("no stale round header carried over", !visible(win, "round-eyebrow"));
  check("no stale per-round summary carried over", !visible(win, "summary-card"));
  check("no stale live inputs carried over", !visible(win, "live-inputs"));
  check("no stale history pager carried over", !visible(win, "history-card"));
  check("capstone reports the total", win.document.getElementById("final-points").textContent === "8");
  check("capstone counts the issues", /2 issues/.test(win.document.getElementById("final-meta").textContent),
    win.document.getElementById("final-meta").textContent);
  check("capstone lists every issue", win.document.querySelectorAll("#final-issues .final-issue").length === 2);

  // The capstone must not read as another card in the same stack.
  const capstone = win.document.getElementById("final-summary-card");
  check("capstone is not styled as a process card", !capstone.classList.contains("card"));
  const sheet = read("style.css");
  const capstoneRule = /\.final-summary-card \{[^}]*\}/.exec(sheet);
  check("capstone inverts against the pale process cards",
    capstoneRule && /background: var\(--ink\)/.test(capstoneRule[0]) && /color: var\(--paper\)/.test(capstoneRule[0]),
    capstoneRule && capstoneRule[0].slice(0, 90));

  // The organizer keeps the one action that matters: restart.
  check("restart action still reachable", shown(win, "end-rail"));
  check("restart is the offered action", win.document.getElementById("btn-end").textContent === "Restart session");
}

/* ── 9. A concluded session cannot be re-queued or re-timed ────────── */
{
  const win = boot();
  const T = win.__test;
  T.S.organizer = true; T.S.code = "ABCDE"; T.S.selfId = "o";
  T.showSession();
  const finished = { number: 1, title: "PROJ-1", open: false, submittedCount: 1,
    summary: { storyPoints: 3, averages: [2, 2, 2], spread: [0, 0, 0], observations: [], outliers: [], shapes: [] } };

  T.S.state = stateMsg({ round: finished, queuedItems: 0, history: [historyEntry(1, "PROJ-1")],
    finalSummary: { totalPoints: 3, issues: [{ title: "PROJ-1", summary: { storyPoints: 3 } }] } });
  T.render();
  check("queue editor gone once concluded", !shown(win, "queue-editor"));
  check("queue editor is a plain group, not a drawer",
    win.document.getElementById("queue-editor").tagName === "DIV");
  check("timer button gone once concluded", !shown(win, "btn-timer"));
  check("timer input gone once concluded", !shown(win, "in-seconds"));
  check("empty round group leaves no bare heading", !shown(win, "round-group"));

  // Restarting brings them back.
  T.S.state = stateMsg({ round: { number: 1, title: "PROJ-1", open: true, submittedCount: 0 }, queuedItems: 1 });
  T.render();
  check("queue editor returns after restart", shown(win, "queue-editor"));
  check("timer returns after restart", shown(win, "btn-timer"));
}

/* ── 10. Estimates start low, and charts get real estate ───────────── */
{
  const win = boot();
  const T = win.__test;
  T.S.organizer = false; T.S.code = "ABCDE"; T.S.selfId = "g";
  T.showSession();
  T.S.state = stateMsg();
  T.render();
  check("every aspect starts at 2", T.S.my.every((v) => v === 2), T.S.my);

  const css = read("style.css");
  const plotMax = /#plot \{[^}]*max-width: (\d+)px/.exec(css);
  check("estimation chart has room", plotMax && Number(plotMax[1]) >= 560, plotMax && plotMax[1]);
  // The floating rail is positioned against the column width; a literal here
  // means widening the column silently misplaces the button.
  check("end rail tracks the column variable", /\.end-rail \{[^}]*left: calc\(50% - var\(--column-half\)/.test(css));
  check("column width is a variable, not a magic number", /--column-half:/.test(css) && /main \{[^}]*max-width: var\(--column\)/.test(css));
}

/* ── 11. Organizer text never becomes a link to our own host ───────── */
{
  const win = boot();
  const T = win.__test;
  const link = T.safeLink;

  // The reported bug: a bare word resolved against the app's own origin.
  check("bare text is not a link", link("abcdef") === null, link("abcdef"));
  check("a relative path is not a link", link("/tickets/4") === null, link("/tickets/4"));
  check("javascript: is refused", link("javascript:alert(1)") === null, link("javascript:alert(1)"));
  check("mailto: is refused", link("mailto:a@b.com") === null, link("mailto:a@b.com"));
  check("absolute links survive", link("https://jira.example.com/PROJ-1") === "https://jira.example.com/PROJ-1");
  check("a bare host gets a scheme", link("jira.example.com/PROJ-1") === "https://jira.example.com/PROJ-1",
    link("jira.example.com/PROJ-1"));
  check("empty is not a link", link("") === null);

  T.S.organizer = false; T.S.code = "ABCDE"; T.S.selfId = "g";
  T.showSession();
  T.S.state = stateMsg({ round: { number: 1, title: "PROJ-1", link: "abcdef", open: true, submittedCount: 0 } });
  T.render();
  check("unusable link leaves the title unlinked",
    !win.document.getElementById("round-title").hasAttribute("href"));
}

/* ── 12. Round lengths read as durations ───────────────────────────── */
{
  const win = boot();
  const secs = win.__test.parseDuration;
  check("a plain number is seconds", secs("90") === 90, secs("90"));
  check("90s", secs("90s") === 90, secs("90s"));
  check("5m", secs("5m") === 300, secs("5m"));
  check("1m30s", secs("1m30s") === 90, secs("1m30s"));
  check("1h", secs("1h") === 3600, secs("1h"));
  check("clock notation", secs("5:30") === 330, secs("5:30"));
  check("nonsense is rejected", secs("soon") === null, secs("soon"));
  check("empty is rejected", secs("  ") === null, secs("  "));
}

/* ── 13. The entry form asks for a nickname only when it matters ──── */
{
  const win = boot();
  const doc = win.document;
  check("both entry actions start enabled",
    !doc.getElementById("btn-create").disabled && !doc.getElementById("btn-join").disabled);
  check("no standing nickname warning", !shown(win, "entry-warning"));

  doc.getElementById("btn-create").click();
  check("warning appears on an attempt without a nickname", shown(win, "entry-warning"));

  doc.getElementById("in-name").value = "Ada";
  doc.getElementById("in-name").oninput();
  check("warning clears once a nickname is typed", !shown(win, "entry-warning"));

  // Both actions sit on one line, so neither may be pushed off it by the
  // warning appearing between them.
  const warning = doc.getElementById("entry-warning");
  check("the warning is outside the button row", !warning.closest(".landing-split"));
}

/* ── 14. Personal shape colour ─────────────────────────────────────── */
{
  const win = boot();
  const T = win.__test;
  T.S.organizer = false; T.S.code = "ABCDE"; T.S.selfId = "g";
  T.showSession();

  const people = [
    { id: "o", name: "Ada", organizer: true, submitted: false },
    { id: "g", name: "Lin", organizer: false, submitted: false, color: "#2A6F8E" },
    { id: "r", name: "Ravi", organizer: false, submitted: false, color: "#6D57B8" },
  ];
  T.S.state = stateMsg({ participants: people });
  T.render();

  check("picker offered to participants", shown(win, "color-picker"));
  const options = Array.from(win.document.querySelectorAll(".color-option"));
  check("every palette colour is offered", options.length >= 8, options.length);
  const taken = options.find((o) => o.getAttribute("aria-label").includes("#6D57B8"));
  check("a colour in use cannot be taken", taken.disabled);
  const mine = options.find((o) => o.classList.contains("is-mine"));
  check("my own colour is marked", !!mine && mine.getAttribute("aria-label") === "#2A6F8E");

  // The stylesheet colours .my-shape, so the personal colour has to win on
  // inline style or it never reaches the screen.
  const shape = win.document.querySelector("#plot .my-shape");
  check("my shape wears my colour", shape.style.stroke.length > 0, shape.style.stroke);

  win.document.getElementById("btn-color").click();
  check("swatch opens the palette", shown(win, "color-options"));
  win.document.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape" }));
  check("escape closes the palette", !shown(win, "color-options"));

  // The organizer contributes no shape, so there is nothing to colour.
  const org = boot();
  org.__test.S.organizer = true; org.__test.S.code = "ABCDE"; org.__test.S.selfId = "o";
  org.__test.showSession();
  org.__test.S.state = stateMsg({ participants: people });
  org.__test.render();
  check("organizer gets no colour picker", !shown(org, "color-picker"));
}

/* ── 15. One button runs, stops and resumes the clock ──────────────── */
{
  const win = boot();
  const T = win.__test;
  T.S.organizer = true; T.S.code = "ABCDE"; T.S.selfId = "o";
  T.showSession();
  const button = win.document.getElementById("btn-timer");

  T.S.state = stateMsg();
  T.render();
  check("no clock yet reads Start timer", button.textContent === "Start timer", button.textContent);

  T.S.state = stateMsg({ round: { number: 1, title: "PROJ-1", open: true, submittedCount: 0, deadlineMs: Date.now() + 60000 } });
  T.render();
  check("a running clock offers Stop timer", button.textContent === "Stop timer", button.textContent);
  check("the running clock is shown", shown(win, "round-timer"));
  check("a running clock is not styled as paused",
    !win.document.getElementById("round-timer").classList.contains("is-paused"));

  T.S.state = stateMsg({ round: { number: 1, title: "PROJ-1", open: true, submittedCount: 0, pausedMs: 45000 } });
  T.render();
  check("a stopped clock offers Start timer again", button.textContent === "Start timer", button.textContent);
  const clock = win.document.getElementById("round-timer");
  check("the stopped clock keeps its reading", clock.textContent === "0:45", clock.textContent);
  check("the stopped clock is marked paused", clock.classList.contains("is-paused"));
}

/* ── 16. Layout: equal columns, one chart, one stage ───────────────── */
{
  const win = boot();
  const css = read("style.css");

  // Nickname and session code are one row of equal tracks, not two flex
  // children whose content decides how wide each ends up.
  check("entry columns are explicit equal tracks",
    /\.landing-split \{[^}]*grid-template-columns: 1fr 1px 1fr/.test(css),
    (/\.landing-split \{[^}]*\}/.exec(css) || [""])[0].slice(0, 90));
  const nameCol = win.document.getElementById("in-name").closest(".landing-col");
  const codeCol = win.document.getElementById("in-code").closest(".landing-col");
  check("both fields sit in the split", !!nameCol && !!codeCol && nameCol !== codeCol);

  // The full prospective chart lines up with the card, not the rail.
  check("full chart is inset past the rail",
    /\.setup-full-chart \{[^}]*margin: 22px 0 0 calc\(var\(--setup-rail\) \+ var\(--setup-gap\)\)/.test(css),
    (/\.setup-full-chart \{[^}]*\}/.exec(css) || [""])[0].slice(0, 90));
  check("the rail width is a variable both rules share",
    /--setup-rail:/.test(css) && /grid-template-columns: var\(--setup-rail\)/.test(css));

  // Sum and Individual share a box, and a mini chart cannot balloon to fill it.
  check("both live views share one stage", !!win.document.querySelector(".live-stage"));
  check("the stage has a floor so switching views does not resize the card",
    /\.live-stage \{[^}]*min-height:/.test(css));
  const grid = /\.live-grid \{[^}]*\}/.exec(css)[0];
  check("mini charts are capped rather than stretched",
    /auto-fill/.test(grid) && !/1fr\)\)/.test(grid), grid.slice(0, 110));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
