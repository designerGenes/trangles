/* Headless checks for the organizer view. Loads the real index.html, radar.js,
   app.js and style.css so the assertions run against shipped code. */
"use strict";
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom"); // devDependency: npm i --no-save jsdom

const DIR = __dirname;
const read = (f) => fs.readFileSync(path.join(DIR, f), "utf8");
// i18n strings live outside static/ (the server serves /resources/); the test
// harness serves them the same way so data-i18n text resolves as in a browser.
const strings = JSON.parse(fs.readFileSync(path.join(DIR, "..", "resources", "strings.json"), "utf8"));

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
      // i18n.js reads /resources/strings.json at load; hand them over
      // synchronously so data-i18n text resolves before assertions run, the
      // way a real browser resolves it after the fetch completes.
      window.__I18N_STRINGS = strings;
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
  round: { number: 1, title: "PROJ-1 first", open: true, submittedCount: 1, liveShapes: [],
    axes: ["Uncertainty", "Complexity", "Toil"], axisMins: [1, 1, 1], axisMaxes: [8, 8, 8] },
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

/* ── 2b. Live scalar estimates render as tracks, not missing shapes ─── */
{
  const win = boot();
  const T = win.__test;
  T.S.organizer = true; T.S.code = "ABCDE"; T.S.selfId = "o";
  T.showSession();
  T.S.state = stateMsg({ participants: [
    { id: "o", name: "Ada", organizer: true, submitted: false },
    { id: "g", name: "Lin", organizer: false, submitted: false, color: "#A98CFF" },
    { id: "r", name: "Ravi", organizer: false, submitted: true, color: "#4FC3FF" },
  ], round: { number: 1, title: "PROJ-1", open: true, submittedCount: 1,
    axes: ["Uncertainty", "Complexity", "Toil"], axisMins: [1, 1, 1], axisMaxes: [8, 8, 8],
    liveShapes: [{ id: "g", name: "Lin", values: [5, 4, 3] }],
    liveScores: [{ id: "r", name: "Ravi", score: 6 }] } });
  T.render();
  check("Sum keeps the radar beside scalar input", shown(win, "live-overlay") && shown(win, "live-scores"));
  check("Sum reports scalar names and values", /Ravi/.test(win.document.getElementById("live-scores").textContent)
    && /6/.test(win.document.getElementById("live-scores").textContent));

  win.document.getElementById("btn-live-grid").click();
  check("Individual renders a scalar as a line card", shown(win, "live-grid")
    && win.document.querySelectorAll(".live-score-card").length === 1
    && !shown(win, "live-scores"));
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
  check("history labels the group observations as insights", shown(win, "history-insights-title"));

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

  // The shelf used to host an issue queue, an "add an aspect" control, and a
  // session-settings shortcut. All three are gone: adding work is reserved for
  // the intake screen, aspects are configured before launch, and settings open
  // from the intake — the shelf is organizer-only session controls.
  check("shelf has no issue queue editor", !win.document.getElementById("queue-editor"));
  check("shelf has no add-aspect control", !win.document.getElementById("aspect-group"));
  check("shelf has no session-settings shortcut", !win.document.getElementById("btn-session-settings"));
  check("close session is the shelf's full-width action",
    win.document.getElementById("btn-close").classList.contains("btn-close-session"));
}

/* ── 6. Every disclosure signals itself the same way ───────────────── */
{
  const win = boot();
  const T = win.__test;
  T.S.organizer = true; T.S.code = "ABCDE"; T.S.selfId = "o";

  // Populate a JS-built intake row; the organizer shelf is the app's one
  // remaining disclosure now that the issue queue and its per-row link/description
  // drawers are gone.
  T.showIntake("first");
  T.addDraftItem({ title: "PROJ-1" });
  win.document.getElementById("organizer-shelf").hidden = false;

  const summaries = Array.from(win.document.querySelectorAll("details > summary"));
  check("found the app's disclosures", summaries.length >= 1, summaries.length);

  const missingCaret = summaries.filter((s) => !s.querySelector(".caret"))
    .map((s) => s.textContent.trim().slice(0, 40));
  check("every summary has a caret", missingCaret.length === 0, missingCaret);

  // Drawers inside drawers bury controls and push their labels to different
  // left edges. No disclosure should nest another.
  const nested = Array.from(win.document.querySelectorAll("details details"))
    .map((d) => d.querySelector("summary").textContent.trim().slice(0, 40));
  check("no drawer contains another drawer", nested.length === 0, nested);

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
  const details = win.document.getElementById("organizer-shelf");
  const caret = details.querySelector("summary .caret");
  const closed = win.getComputedStyle(caret).transform;
  details.open = true;
  const opened = win.getComputedStyle(caret).transform;
  check("shelf caret flips when opened", closed !== opened, { closed, opened });
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
    finalSummary: { totalPoints: 8, sessionInsights: ["2 issues estimated across this session."],
      issues: [{ title: "PROJ-1 first", summary: { storyPoints: 3 } }, { title: "PROJ-2 second", summary: { storyPoints: 5 } }] } });
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
  check("capstone includes session insights", shown(win, "session-insights")
    && /2 issues estimated/.test(win.document.getElementById("final-insights").textContent));
  T.showSettings("session");
  T.render();
  check("a final summary replaces any open settings screen", shown(win, "view-session") && !shown(win, "view-settings"));
  win.dispatchEvent(new win.PopStateEvent("popstate", { state: { view: "settings" } }));
  check("browser navigation cannot reopen settings after completion", shown(win, "view-session") && !shown(win, "view-settings"));

  // Results use the shared violet result surface, not the active-session card.
  const capstone = win.document.getElementById("final-summary-card");
  check("capstone is not styled as a process card", !capstone.classList.contains("card"));
  const sheet = read("style.css");
  const resultRule = /\.chart-box, \.summary-card, \.history-card, \.final-summary-card \{[^}]*\}/.exec(sheet);
  // Anchored: the shared result rule also ends in ".final-summary-card {".
  const capstoneRule = /^\.final-summary-card \{[^}]*\}/m.exec(sheet);
  check("capstone uses the violet result surface",
    resultRule && /var\(--violet-lit\), var\(--violet-deep\)/.test(resultRule[0])
    && capstoneRule && /color: var\(--ink\)/.test(capstoneRule[0]),
    capstoneRule && capstoneRule[0].slice(0, 90));

  // The organizer keeps the one action that matters: restart.
  check("restart action still reachable", shown(win, "end-rail"));
  check("restart is the offered action", win.document.getElementById("btn-end").textContent === "Restart session");
  check("final results hide session settings and other shelf controls", !shown(win, "organizer-shelf"));
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
  check("timer button gone once concluded", !shown(win, "btn-timer"));
  check("timer input gone once concluded", !shown(win, "in-seconds"));
  check("empty round group leaves no bare heading", !shown(win, "round-group"));

  // Restarting brings the timer back.
  T.S.state = stateMsg({ round: { number: 1, title: "PROJ-1", open: true, submittedCount: 0 }, queuedItems: 1 });
  T.render();
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
    { id: "g", name: "Lin", organizer: false, submitted: false, color: "#4FC3FF" },
    { id: "r", name: "Ravi", organizer: false, submitted: false, color: "#A98CFF" },
  ];
  T.S.state = stateMsg({ participants: people });
  T.render();

  check("picker offered to participants", shown(win, "color-picker"));
  const options = Array.from(win.document.querySelectorAll(".color-option"));
  check("every palette colour is offered", options.length >= 8, options.length);
  const taken = options.find((o) => o.getAttribute("aria-label").includes("#A98CFF"));
  check("a colour in use cannot be taken", taken.disabled);
  const mine = options.find((o) => o.classList.contains("is-mine"));
  check("my own colour is marked", !!mine && mine.getAttribute("aria-label") === "#4FC3FF");

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

  // The prospective chart is a settings-screen concern now, not a launch one.
  check("prospective chart lives on the settings screen",
    !!win.document.querySelector("#view-settings #setup-full-chart"));
  check("no prospective chart on the intake screen",
    !win.document.querySelector("#view-intake svg"));

  // Sum and Individual share a box, and a mini chart cannot balloon to fill it.
  check("both live views share one stage", !!win.document.querySelector(".live-stage"));
  check("the stage has a floor so switching views does not resize the card",
    /\.live-stage \{[^}]*min-height:/.test(css));
  const grid = /\.live-grid \{[^}]*\}/.exec(css)[0];
  check("mini charts are capped rather than stretched",
    /auto-fill/.test(grid) && !/1fr\)\)/.test(grid), grid.slice(0, 110));
}

/* ── 16b. Theme: semantic dark surfaces stay distinct ───────────────── */
{
  const win = boot();
  const css = read("style.css");
  check("theme uses a non-black charcoal app background",
    /--paper:\s+#161922/.test(css) && /background: radial-gradient/.test(css));
  check("logo keeps a bright triangle on the single-colour wordmark",
    /\.wordmark \{[^}]*color: var\(--ink\)/.test(css)
    && /\.wordmark-angle \{[^}]*color: var\(--pencil\)/.test(css));
  check("settings surfaces carry semantic concepts",
    win.document.querySelector("#view-settings .issues-box")
    && win.document.querySelector("#view-settings .aspects-box")
    && win.document.querySelector("#view-settings .point-labels-box")
    && win.document.querySelector("#setup-full-chart.chart-box"));
  check("issues use honey fields and focus", /\.issues-box \{[^}]*--honey/.test(css)
    && /\.issues-box input:focus-visible \{[^}]*--honey/.test(css));
  check("preparation boxes are filled with their semantic colours",
    /\.issues-box \{[^}]*--panel-lit: var\(--honey-lit\)/.test(css)
    && /\.aspects-box \{[^}]*--panel-lit: var\(--orange-lit\)/.test(css)
    && /\.point-labels-box \{[^}]*--panel-lit: var\(--blue-lit\)/.test(css));
  check("aspects use orange fields and focus", /\.aspects-box \{[^}]*--orange/.test(css)
    && /\.aspects-box input:focus-visible \{[^}]*--orange/.test(css));
  check("point labels use blue fields and focus", /\.point-labels-box \{[^}]*--blue/.test(css)
    && /\.point-labels-box input:focus-visible \{[^}]*--blue/.test(css));
  check("radar screens use a violet chart treatment",
    win.document.querySelector("#plot-wrap.chart-box")
    && win.document.querySelector("#live-inputs.chart-box")
    && /\.ring-outer \{[^}]*var\(--violet\)/.test(css));
  check("active chart surfaces stay reserved while results are violet",
    /\.round-card \.chart-box, \.live-inputs\.chart-box \{[^}]*background: var\(--card\)/.test(css)
    && /\.chart-box, \.summary-card, \.history-card, \.final-summary-card \{[^}]*var\(--violet-lit\), var\(--violet-deep\)/.test(css));
  check("preparation launch actions use the blue CTA family",
    /\.btn-primary \{[^}]*background: var\(--primary-action\)/.test(css)
    && /--primary-action:\s+#1769AA/.test(css));
  check("session settings uses a distinct violet panel accent",
    /\.btn-panel-accent \{[^}]*background: var\(--panel-accent\)/.test(css)
    && win.document.getElementById("btn-open-settings").classList.contains("btn-panel-accent"));
  check("active participant submission keeps the coral commitment treatment",
    /\.btn-session-commit \{[^}]*background: var\(--pencil\)/.test(css)
    && win.document.getElementById("btn-submit").classList.contains("btn-session-commit"));
  check("radar axis labels use the light chart foreground",
    /\.axis-label \{[^}]*fill: var\(--ink\)/.test(css)
    && /\.tick-label \{[^}]*fill: var\(--ink\)/.test(css));
  check("session settings is a taller light-text panel control",
    /\.intake-settings\.btn-panel-accent \{[^}]*min-height: 46px[^}]*text-align: center/.test(css));
}

/* ── 16c. Control panels are raised plastic, and stay readable ──────── */
/* The organizer's editing surfaces are bright, which inverts their text. The
   checks below are the ones that a colour edit can silently break: the lab at
   /dev/colors writes straight into the token block, so the floor lives here
   rather than in a reviewer's eye. */
{
  const win = boot();
  const css = read("style.css");

  const TOKENS = (() => {
    const block = /TRIANGULATE-TOKENS:START([\s\S]*?)TRIANGULATE-TOKENS:END/.exec(css);
    const found = {};
    if (!block) return found;
    const decl = /--([a-zA-Z0-9-]+):\s*([^;]+);/g;
    let m;
    while ((m = decl.exec(block[1]))) found["--" + m[1]] = m[2].trim();
    return found;
  })();

  // sRGB relative luminance and WCAG contrast, over an opaque backdrop.
  const parse = (value) => {
    const raw = String(value).trim();
    const hex = /^#([0-9a-fA-F]{6})$/.exec(raw);
    if (hex) {
      const n = parseInt(hex[1], 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
    }
    const fn = /^rgba?\(([^)]+)\)$/.exec(raw);
    if (!fn) return null;
    const parts = fn[1].split(",").map((p) => parseFloat(p));
    return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
  };
  const over = (fg, bg) => {
    const f = parse(fg), b = parse(bg);
    if (!f || !b) return null;
    return [0, 1, 2].map((i) => Math.round((f[3] * f[i]) + ((1 - f[3]) * b[i]))).concat([1]);
  };
  const toCss = (rgb) => `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 1)`;
  const luminance = (value) => {
    const c = parse(value);
    if (!c) return null;
    const chan = (v) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
    return (0.2126 * chan(c[0])) + (0.7152 * chan(c[1])) + (0.0722 * chan(c[2]));
  };
  const ratio = (a, b) => {
    const la = luminance(a), lb = luminance(b);
    if (la === null || lb === null) return 0;
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };
  const T = (name) => TOKENS[name];

  check("every colour token the theme needs is declared",
    ["--panel-ink", "--panel-ink-soft", "--panel-warn", "--panel-slot", "--honey-deep",
     "--orange-deep", "--blue-deep", "--violet-lit", "--ink", "--muted", "--primary-action",
     "--on-primary", "--panel-shade-deep", "--deep-gloss", "--axis-1", "--axis-8"]
      .every((name) => !!T(name)),
    Object.keys(TOKENS).length);

  // A panel is a ramp with a sheen over it, so the surface that actually sits
  // behind the text is darkest in the shaded corner — and darker still inside a
  // recessed row. That composite, not the raw token, is what text must clear.
  const families = [["issues", "--honey-deep"], ["aspects", "--orange-deep"], ["labels", "--blue-deep"]];
  let panelFloor = Infinity, panelWorst = "";
  for (const [name, deep] of families) {
    const shaded = toCss(over(T("--panel-shade-deep"), T(deep)));
    const slot = toCss(over(T("--panel-slot"), shaded));
    const soft = toCss(over(T("--panel-ink-soft"), slot));
    const pairs = [
      [`${name}: panel ink`, ratio(T("--panel-ink"), shaded)],
      [`${name}: panel ink in a row`, ratio(T("--panel-ink"), slot)],
      [`${name}: quiet copy in a row`, ratio(soft, slot)],
      [`${name}: warning copy`, ratio(T("--panel-warn"), shaded)],
      [`${name}: recessed field`, ratio(T("--surface-input"), slot)],
    ];
    for (const [label, value] of pairs) {
      if (value < panelFloor) { panelFloor = value; panelWorst = label; }
    }
  }
  check("bright control panels keep dark text above the AA floor",
    panelFloor >= 4.5, { worst: panelWorst, ratio: Number(panelFloor.toFixed(2)) });

  // Results run the same construction in the other direction: light text, so
  // the lightest corner is the one that can fail.
  const resultLit = toCss(over(T("--deep-gloss"), T("--violet-lit")));
  check("result surfaces keep light text above the AA floor",
    ratio(T("--ink"), resultLit) >= 4.5 && ratio(T("--muted"), resultLit) >= 4.5,
    { ink: Number(ratio(T("--ink"), resultLit).toFixed(2)), muted: Number(ratio(T("--muted"), resultLit).toFixed(2)) });

  check("the primary action carries its own label",
    ratio(T("--on-primary"), T("--primary-action")) >= 4.5,
    Number(ratio(T("--on-primary"), T("--primary-action")).toFixed(2)));

  // Participant colours are stroke AND name label, so they are read as text.
  const axes = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => T(`--axis-${i}`));
  const axisFloor = Math.min(...axes.map((c) => ratio(c, T("--card"))));
  check("every participant colour is legible on the live round surface",
    axisFloor >= 4.5, Number(axisFloor.toFixed(2)));
  check("participant colours stay distinguishable from each other",
    new Set(axes.map((c) => c.toLowerCase())).size === axes.length, axes);

  // The lab can only be authoritative if nothing outside the block paints.
  const afterBlock = css.slice(css.indexOf("TRIANGULATE-TOKENS:END"));
  const strays = afterBlock.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/g) || [];
  check("no colour is hard-coded outside the token block", strays.length === 0, strays.slice(0, 6));

  check("panels invert to dark ink rather than inheriting light text",
    /\.panel \{[^}]*color: var\(--panel-ink\)/.test(css)
    && win.document.querySelectorAll(".panel").length >= 3);
  check("panels are lit on the diagonal with a sheen across it",
    /\.panel \{[^}]*linear-gradient\(var\(--panel-sheen-angle\)/.test(css)
    && /\.panel \{[^}]*linear-gradient\(var\(--panel-angle\), var\(--panel-lit\), var\(--panel-deep\)\)/.test(css)
    && /--panel-angle:\s*\d+deg/.test(css));
  check("panels carry a bevel so they read as raised",
    /\.panel \{[^}]*inset 0 1px 0 var\(--panel-bevel\)/.test(css)
    && /inset 0 -1px 0 var\(--panel-bevel-dark\)/.test(css));
  check("panel rows recess instead of lightening",
    /\.panel \.intake-row,[\s\S]{0,200}background: var\(--panel-slot\)/.test(css));
}

/* ── 17. Intake: one mode-switching row, nothing else up front ───────── */
{
  const win = boot();
  const T = win.__test;
  T.S.organizer = true; T.S.code = "ABCDE"; T.S.selfId = "o";
  T.showIntake("first");

  check("intake is the organizer's first screen", shown(win, "view-intake"));
  check("settings are not up front", !shown(win, "view-settings"));
  check("exactly one issue row to start", win.document.querySelectorAll(".intake-row").length === 1,
    win.document.querySelectorAll(".intake-row").length);
  check("the single row cannot be removed", !win.document.querySelector(".intake-row .row-minus"));
  check("launch is the primary action",
    win.document.getElementById("btn-launch").textContent === "Launch pointing session",
    win.document.getElementById("btn-launch").textContent);
  check("no aspect rows on the intake screen", !win.document.querySelector("#view-intake #draft-aspects"));
  check("no results action before anything is pointed", !shown(win, "btn-intake-results"));
  check("title uses the natural placeholder", win.document.querySelector(".intake-title-input").placeholder === "Issue title");
  check("field mode begins as raw title", win.document.querySelector(".issue-mode-field").classList.contains("field-mode-raw"));
  check("field mode has an icon control", !!win.document.querySelector(".field-mode-toggle svg"));
  check("the lone row carries the add affordance", !!win.document.querySelector(".intake-row .row-plus"));
  check("there is no separate add-issue button", !win.document.getElementById("btn-intake-add"));
  check("initial intake copy names the first issue",
    win.document.getElementById("intake-title").textContent === "Enter the first issue to point.");
  check("initial intake explains that more issues can be added",
    /add more issues to the session/.test(win.document.getElementById("intake-detail").textContent));
  check("initial intake block is vertically centered", win.document.getElementById("view-intake").classList.contains("intake-initial"));

  // Adding rows happens at the right edge of the last row, not through a
  // competing action elsewhere on the page.
  win.document.querySelector(".intake-row .row-plus").click();
  check("the last-row plus adds another issue", win.document.querySelectorAll(".intake-row").length === 2);
  check("multiple rows change the intake heading to each issue",
    win.document.getElementById("intake-title").textContent === "Enter each issue to point.");
  check("extra rows use matching minus controls", win.document.querySelectorAll(".intake-row .row-minus").length === 2
    && !!win.document.querySelector(".intake-row .row-plus"));
  win.document.querySelector(".intake-row .row-minus").click();
  check("returning to one row restores the first-issue heading",
    win.document.getElementById("intake-title").textContent === "Enter the first issue to point.");
  const css = read("style.css");
  check("plus and minus share one size rule", /\.row-plus, \.row-minus \{[^}]*flex: 0 0 44px/.test(css));
  check("settings precede the full-width launch action", win.document.getElementById("btn-open-settings").compareDocumentPosition(win.document.querySelector(".intake-actions"))
    & win.Node.DOCUMENT_POSITION_FOLLOWING && /#btn-launch \{ width: 100%/.test(css));
  check("session code bubble inverts while pressed",
    /\.code-chip:active \{[^}]*background: var\(--ink\)[^}]*color: var\(--paper\)/.test(css)
    && /\.code-chip:active \.mono \{ color: var\(--paper\)/.test(css));
}

/* ── 18. Field modes preserve title, URL, and description ────────────── */
{
  const win = boot();
  const T = win.__test;
  T.S.organizer = true; T.S.code = "ABCDE"; T.S.selfId = "o";
  T.showIntake("first");

  const input = win.document.querySelector(".intake-title-input");
  input.value = "PROJ-9 payments";
  input.oninput();
  T.showSettings("intake");
  const titles = Array.from(win.document.querySelectorAll("#settings-items .intake-title-input")).map((n) => n.value);
  check("settings edits the issue typed on intake", titles.includes("PROJ-9 payments"), titles);
  const cycle = () => win.document.querySelector("#settings-items .field-mode-toggle").click();
  cycle();
  const link = win.document.querySelector("#settings-items .issue-mode-input");
  check("icon cycles to the URL mode", win.document.querySelector("#settings-items .issue-mode-field").classList.contains("field-mode-link")
    && link.placeholder === "Issue URL");
  link.value = "https://jira.example.com/PROJ-9";
  link.oninput();
  cycle();
  const description = win.document.querySelector("#settings-items .issue-mode-input");
  description.value = "Invite the payments team after approval.";
  description.oninput();
  check("icon cycles to description mode", win.document.querySelector("#settings-items .issue-mode-field").classList.contains("field-mode-description"));
  cycle();
  check("cycling keeps the original title", win.document.querySelector("#settings-items .issue-mode-input").value === "PROJ-9 payments");
  T.showIntake("first");
  check("returning to intake keeps the same row", shown(win, "view-intake"));
  check("all field-mode values survive the round trip",
    T.S.drafts[0].link === "https://jira.example.com/PROJ-9" && T.S.drafts[0].description === "Invite the payments team after approval.", T.S.drafts[0]);
  const sent = [];
  T.S.ws = { readyState: win.WebSocket.OPEN, send: (message) => sent.push(JSON.parse(message)) };
  win.document.getElementById("btn-launch").click();
  check("launch submits every field mode", sent[0].items[0].title === "PROJ-9 payments"
    && sent[0].items[0].link === "https://jira.example.com/PROJ-9"
    && sent[0].items[0].description === "Invite the payments team after approval.", sent[0]);
}

/* ── 19. An emptied queue offers more work before it offers totals ────── */
{
  const win = boot();
  const T = win.__test;
  T.S.organizer = true; T.S.code = "ABCDE"; T.S.selfId = "o";
  T.showSession();

  const done = { number: 2, title: "PROJ-2", open: false, submittedCount: 1,
    axes: ["Uncertainty", "Complexity", "Toil"], axisMins: [1, 1, 1], axisMaxes: [8, 8, 8],
    summary: { storyPoints: 5, averages: [5, 4, 3], spread: [1, 1, 1], observations: [], outliers: [], shapes: [] } };

  T.S.state = stateMsg({ round: done, queuedItems: 0,
    history: [historyEntry(1, "PROJ-1"), historyEntry(2, "PROJ-2")] });
  T.render();

  check("an emptied queue lands on intake, not the capstone", shown(win, "view-intake"));
  check("the capstone is not forced on the organizer", !shown(win, "final-summary-card"));
  check("more issues is the primary action",
    win.document.getElementById("btn-launch").textContent === "Add more issues",
    win.document.getElementById("btn-launch").textContent);
  check("results are offered alongside", shown(win, "btn-intake-results"));
  check("progress so far is stated", /2 issues pointed/.test(win.document.getElementById("intake-tally").textContent),
    win.document.getElementById("intake-tally").textContent);
  check("a single row is still the default", win.document.querySelectorAll(".intake-row").length === 1);

  // Reading the last result must not bounce straight back to intake.
  win.document.getElementById("btn-intake-back").click();
  check("stepping back reaches the session view", shown(win, "view-session"));
  T.S.state = stateMsg({ round: done, queuedItems: 0,
    history: [historyEntry(1, "PROJ-1"), historyEntry(2, "PROJ-2")] });
  T.render();
  check("a broadcast does not yank the organizer away", shown(win, "view-session"));
}

/* ── 20. Simple pointing swaps the chart for one number ───────────────── */
{
  const win = boot();
  const T = win.__test;
  T.S.organizer = false; T.S.code = "ABCDE"; T.S.selfId = "g";
  T.showSession();
  T.S.state = stateMsg({ participants: [
    { id: "o", name: "Ada", organizer: true, submitted: false },
    { id: "g", name: "Lin", organizer: false, submitted: false },
  ] });
  T.render();

  check("mode switch offered to participants", shown(win, "mode-switch"));
  check("shape mode shows the chart", shown(win, "plot-wrap"));
  check("shape mode hides the slider", !shown(win, "simple-wrap"));

  win.document.getElementById("btn-mode-simple").click();
  check("simple mode hides the chart", !shown(win, "plot-wrap"));
  check("simple mode shows the slider", shown(win, "simple-wrap"));
  check("the slider uses the aspect scale",
    win.document.getElementById("simple-slider").max === "8",
    win.document.getElementById("simple-slider").max);

  T.setSimple(6);
  check("the reading follows the slider",
    win.document.getElementById("simple-value").textContent === "6",
    win.document.getElementById("simple-value").textContent);
  check("state records the composite score", T.S.simple === 6, T.S.simple);
  const simpleWrap = win.document.getElementById("simple-wrap");
  check("single-score value drives its shared slider colour",
    /score-mid/.test(simpleWrap.style.getPropertyValue("--score-color"))
    && simpleWrap.style.getPropertyValue("--score-percent") === "71%");
  T.setSimple(8);
  check("high single score reaches bright red", /score-high/.test(simpleWrap.style.getPropertyValue("--score-color")));
  const css = read("style.css");
  check("single-score slider runs pale white through yellow to red",
    /--score-low: #F4F1E8/.test(css)
    && /--score-mid: #FFD166/.test(css)
    && /--score-high: #FF6464/.test(css));
  check("participant submit fills the available row with taller padding",
    /\.submit-row \{[^}]*align-items: stretch[^}]*width: 100%/.test(css)
    && /\.submit-row \.btn \{[^}]*padding-bottom: 15px[^}]*width: 100%/.test(css));
  check("participants do not see vote progress", !shown(win, "progress"));

  win.document.getElementById("btn-mode-shape").click();
  check("switching back restores the chart", shown(win, "plot-wrap"));

  // The organizer contributes no estimate, so there is no mode to choose.
  const org = boot();
  org.__test.S.organizer = true; org.__test.S.code = "ABCDE"; org.__test.S.selfId = "o";
  org.__test.showSession();
  org.__test.S.state = stateMsg();
  org.__test.render();
  check("organizer gets no mode switch", !shown(org, "mode-switch"));
}

/* ── 21. The clock floats for the whole room ──────────────────────────── */
{
  const win = boot();
  const T = win.__test;
  T.S.organizer = false; T.S.code = "ABCDE"; T.S.selfId = "g";
  T.showSession();

  T.S.state = stateMsg();
  T.render();
  check("no clock without a deadline", !shown(win, "timer-float"));

  T.S.state = stateMsg({ round: { number: 1, title: "PROJ-1", open: true, submittedCount: 0,
    deadlineMs: Date.now() + 60000 } });
  T.render();
  check("a running clock is visible to participants", shown(win, "timer-float"));
  check("participants get no timer controls", !shown(win, "timer-controls"));
  const css = read("style.css");
  check("the clock is fixed to the viewport",
    /\.timer-float \{[^}]*position: fixed/.test(css));
  check("the clock sits in the upper right",
    /\.timer-float \{[^}]*right: \d+px/.test(css) && /\.timer-float \{[^}]*top: \d+px/.test(css),
    (/\.timer-float \{[^}]*\}/.exec(css) || [""])[0].slice(0, 120));
  check("the clock is not inside the issue card",
    !win.document.querySelector(".round-card #timer-float"));

  const org = boot();
  org.__test.S.organizer = true; org.__test.S.code = "ABCDE"; org.__test.S.selfId = "o";
  org.__test.showSession();
  org.__test.S.state = stateMsg({ round: { number: 1, title: "PROJ-1", open: true, submittedCount: 0,
    deadlineMs: Date.now() + 60000 } });
  org.__test.render();
  check("the organizer can pause and remove from the clock", shown(org, "timer-controls"));
  check("a running clock offers to pause",
    org.document.getElementById("btn-timer-toggle").textContent === "Pause",
    org.document.getElementById("btn-timer-toggle").textContent);
}

/* ── 22. Optional controls say what they apply to ─────────────────────── */
{
  const win = boot();
  const T = win.__test;
  T.S.organizer = true; T.S.code = "ABCDE"; T.S.selfId = "o";
  T.showSession();
  T.S.state = stateMsg();
  T.render();

  // The timer is the one shelf control that still says what it applies to.
  const scope = win.document.getElementById("timer-scope");
  const values = Array.from(scope.options).map((o) => o.value);
  check("timer-scope offers both scopes", values.includes("issue") && values.includes("remaining"), values);
  const labels = Array.from(scope.options).map((o) => o.textContent);
  check("timer-scope spells the scope out",
    labels.some((l) => /this issue/.test(l)) && labels.some((l) => /all remaining issues/.test(l)), labels);
  check("the timer scope is offered while a round runs", shown(win, "timer-scope"));
}

/* ── 23. Privacy mode anonymizes the organizer's live screen ─────────── */
{
  const win = boot();
  const T = win.__test;
  T.S.organizer = true; T.S.code = "ABCDE"; T.S.selfId = "o";
  T.showSession();

  T.S.state = stateMsg();
  T.render();
  check("no privacy badge by default", !shown(win, "privacy-badge"));
  check("privacy toggle offered to the organizer", shown(win, "privacy-group"));

  // The server masks names while retaining the group information the
  // organizer needs to discuss the work on a shared screen.
  T.S.state = stateMsg({ privacy: true, participants: [
    { id: "o", name: "Ada", organizer: true, submitted: false },
    { id: "g", name: "Participant 1", organizer: false, submitted: true },
  ], round: { number: 1, title: "PROJ-1", open: true, submittedCount: 1,
    axes: ["Uncertainty", "Complexity", "Toil"], axisMins: [1, 1, 1], axisMaxes: [8, 8, 8],
    liveShapes: [{ id: "g", name: "Participant 1", values: [4, 4, 4] }],
    liveScores: [{ id: "g", name: "Participant 1", score: 5 }] } });
  T.render();
  check("privacy is visibly on", shown(win, "privacy-badge"));
  check("the toggle reflects the session", win.document.getElementById("in-privacy").checked);
  check("privacy copy describes aliases, not hidden charts", /aliases/.test(win.document.querySelector("#privacy-group label span").textContent));
  check("no real names on the roster",
    !/Lin/.test(win.document.getElementById("people").textContent),
    win.document.getElementById("people").textContent);
  check("live charts and scalar lines remain available under aliases",
    win.document.getElementById("live-overlay").querySelectorAll(".live-shape").length === 1
    && /Participant 1/.test(win.document.getElementById("live-scores").textContent));

  // A participant is never affected by the organizer's privacy setting.
  const guest = boot();
  guest.__test.S.organizer = false; guest.__test.S.code = "ABCDE"; guest.__test.S.selfId = "g";
  guest.__test.showSession();
  guest.__test.S.state = stateMsg({ privacy: true });
  guest.__test.render();
  check("participants see no privacy badge", !shown(guest, "privacy-badge"));
  check("participants keep their own chart", shown(guest, "plot-wrap"));
}

/* ── 24. Process feedback is retained for internal use, not shown in UI ─ */
{
  const win = boot();
  check("participants are not prompted for process feedback", !win.document.getElementById("feedback-card"));
  check("organizers have no process-feedback shelf section", !win.document.getElementById("feedback-group"));
}

/* ── 25. A round is drawn against its own aspects ─────────────────────── */
{
  const win = boot();
  const T = win.__test;
  T.S.organizer = false; T.S.code = "ABCDE"; T.S.selfId = "g";
  T.showSession();

  // The organizer added an aspect for this issue only, so the round carries
  // four axes while the session default still carries three.
  T.S.state = stateMsg({
    axes: ["Uncertainty", "Complexity", "Toil"],
    round: { number: 1, title: "PROJ-1", open: true, submittedCount: 0,
      axes: ["Uncertainty", "Complexity", "Toil", "Risk"],
      axisMins: [1, 1, 1, 1], axisMaxes: [8, 8, 8, 8] },
  });
  T.render();
  check("the round's aspects win over the session default", T.S.axes.length === 4, T.S.axes);
  check("the chart is drawn with the extra axis",
    win.document.querySelectorAll("#plot .handle").length === 4,
    win.document.querySelectorAll("#plot .handle").length);
  check("the estimate covers every axis of this round", T.S.my.length === 4, T.S.my);

  const resolved = T.roundAxes({ axes: ["A", "B"], axisMins: [1, 1], axisMaxes: [8, 8] });
  check("with no round the session default applies", resolved.axes.length === 2, resolved.axes);
}


/* ── 26. A score-only round reports honestly, not as zeroes ───────────── */
{
  const win = boot();
  const T = win.__test;
  T.S.organizer = false; T.S.code = "ABCDE"; T.S.selfId = "g";
  T.showSession();

  // The server sends no averages when nobody drew a shape.
  T.S.state = stateMsg({ round: { number: 1, title: "PROJ-1", open: false, submittedCount: 2,
    axes: ["Uncertainty", "Complexity", "Toil"], axisMins: [1, 1, 1], axisMaxes: [8, 8, 8],
    summary: { storyPoints: 5, observations: [], outliers: [], shapes: [],
      scores: [{ name: "Anonymous score 1", score: 5 }] } } });
  T.render();

  check("the result still shows", shown(win, "summary-card"));
  check("story points survive a score-only round",
    win.document.getElementById("points-num").textContent === "5");
  check("no aspect bars invented from nothing",
    win.document.querySelectorAll("#axis-stats .axis-row").length === 0,
    win.document.getElementById("axis-stats").innerHTML.slice(0, 80));
  check("the gap is explained rather than left blank",
    /single score/.test(win.document.getElementById("axis-stats").textContent),
    win.document.getElementById("axis-stats").textContent);
}

/* ── 27. History draws each issue with the aspects it was pointed on ──── */
{
  const win = boot();
  const T = win.__test;
  T.S.organizer = true; T.S.code = "ABCDE"; T.S.selfId = "o";
  T.showSession();

  const withRisk = historyEntry(1, "PROJ-1");
  withRisk.axes = ["Uncertainty", "Complexity", "Toil", "Risk"];
  withRisk.axisMins = [1, 1, 1, 1];
  withRisk.axisMaxes = [8, 8, 8, 8];
  withRisk.summary.averages = [5, 4, 3, 6];
  withRisk.summary.spread = [1, 1, 1, 1];
  withRisk.summary.shapes = [{ name: "Lin", values: [5, 4, 3, 6] }];

  T.S.state = stateMsg({ history: [withRisk], round: { number: 1, title: "PROJ-1", open: false,
    submittedCount: 1, summary: withRisk.summary } });
  T.render();

  check("history shows the issue's own aspect count",
    win.document.querySelectorAll("#history-stats .axis-row").length === 4,
    win.document.querySelectorAll("#history-stats .axis-row").length);
  check("the extra aspect is named",
    /Risk/.test(win.document.getElementById("history-stats").textContent));
}

/* ── 28. Launch uses defaults unless settings were deliberately changed ─ */
{
  const win = boot();
  const T = win.__test;
  T.S.organizer = true; T.S.code = "ABCDE"; T.S.selfId = "o";
  T.showIntake("first");
  const title = win.document.querySelector(".intake-title-input");
  title.value = "PROJ-1";
  title.oninput();
  const sent = [];
  T.S.ws = { readyState: win.WebSocket.OPEN, send: (message) => sent.push(JSON.parse(message)) };
  win.document.getElementById("btn-launch").click();
  check("default launch loads without custom aspects", sent[0].type === "load_items" && sent[0].aspects.length === 0, sent);
  check("default launch immediately starts pointing", sent[1].type === "start_round", sent);
  T.showSettings("session");
  check("live settings retain the initially entered issue", Array.from(win.document.querySelectorAll("#settings-items .intake-title-input"))
    .some((input) => input.value === "PROJ-1"));

  T.showIntake("first");
  T.addDraftItem({ title: "PROJ-2" });
  T.showSettings("intake");
  Array.from(win.document.querySelectorAll("#draft-aspects .row-minus")).forEach((button) => button.click());
  win.document.getElementById("btn-launch").click();
  check("deliberately removing every aspect blocks launch", shown(win, "view-settings")
    && shown(win, "setup-aspect-warning"));
  check("prelaunch settings says it launches", win.document.getElementById("btn-close-settings").textContent === "Launch pointing session");
  T.showSettings("session");
  check("live session settings returns instead of relaunching", !shown(win, "btn-close-settings")
    && win.document.getElementById("btn-settings-back").textContent === "Back to session");
}

/* ── 28b. Settings put issues first and use shared row controls ──────── */
{
  const win = boot();
  const T = win.__test;
  T.S.organizer = true; T.S.code = "ABCDE"; T.S.selfId = "o";
  T.showIntake("first");
  T.showSettings("intake");
  const firstCard = win.document.querySelector("#view-settings .card");
  check("issue details are the first settings container", /Issue details/.test(firstCard.textContent));
  check("settings offers Back beside Launch", !!win.document.getElementById("btn-settings-back")
    && shown(win, "btn-close-settings"));
  let pointRows = Array.from(win.document.querySelectorAll("#setup-point-labels .point-label-row"));
  check("point range starts with eight inline rows", pointRows.length === 8
    && pointRows.every((row) => !!row.querySelector(".row-minus"))
    && !!pointRows.at(-1).querySelector(".row-plus"));

  pointRows.at(-1).querySelector(".row-plus").click();
  pointRows = Array.from(win.document.querySelectorAll("#setup-point-labels .point-label-row"));
  check("last point row plus appends the next label row", pointRows.length === 9
    && !!pointRows.at(-1).querySelector(".row-plus"));
  pointRows[2].querySelector("input").value = "remove me";
  pointRows[2].querySelector(".row-minus").click();
  pointRows = Array.from(win.document.querySelectorAll("#setup-point-labels .point-label-row"));
  check("point row minus removes and renumbers a point", pointRows.length === 8
    && pointRows[2].querySelector("span").textContent === "3");

  const initialAspects = win.document.querySelectorAll("#draft-aspects .draft-item").length;
  let aspectRows = Array.from(win.document.querySelectorAll("#draft-aspects .draft-item"));
  aspectRows.at(-1).querySelector(".row-plus").click();
  aspectRows = Array.from(win.document.querySelectorAll("#draft-aspects .draft-item"));
  check("aspects use a plus control", win.document.querySelectorAll("#draft-aspects .draft-item").length === initialAspects + 1
    && !!aspectRows.at(-1).querySelector(".row-plus"));
  check("aspect rows use matching inline minus controls", win.document.querySelectorAll("#draft-aspects .row-minus").length === initialAspects + 1);
  const css = read("style.css");
  check("aspect rows use the neutral card surface", !/#draft-aspects \.draft-item:nth-child/.test(css));
  check("aspect rows stay full width while inputs flex around controls",
    /\.draft-item \{[^}]*width: 100%/.test(css)
    && /\.draft-item input \{[^}]*flex: 1 1 auto[^}]*min-width: 0/.test(css));
  check("point-label rows stay full width while inputs flex around controls",
    /\.point-label-row \{[^}]*display: flex[^}]*width: 100%/.test(css)
    && /\.point-label-row input \{[^}]*flex: 1 1 auto[^}]*min-width: 0/.test(css));

  win.document.getElementById("btn-close-settings").click();
  const warning = win.document.getElementById("settings-items-warning");
  check("settings launch validates its own issue details", shown(win, "view-settings") && shown(win, "settings-items-warning")
    && /at least one issue/.test(warning.textContent) && warning.closest(".card") === firstCard);
  win.document.getElementById("btn-settings-back").click();
  check("settings Back returns to the launch intake", shown(win, "view-intake"));
}

/* ── 29. Individual view explains an empty room ──────────────────────── */
{
  const win = boot();
  const T = win.__test;
  T.S.organizer = true; T.S.code = "ABCDE"; T.S.selfId = "o";
  T.showSession();
  T.S.state = stateMsg({ participants: [{ id: "o", name: "Ada", organizer: true, submitted: false }] });
  T.render();
  check("empty Sum view shows only its centered explanation", shown(win, "live-empty")
    && !visible(win, "live-overlay") && !visible(win, "live-grid"));
  win.document.getElementById("btn-live-grid").click();
  check("empty individual view names the missing participants", /No participants/.test(win.document.getElementById("live-empty").textContent));
  check("empty individual view keeps the centered stage clear", win.document.getElementById("live-stage").classList.contains("has-empty")
    && !visible(win, "live-overlay") && !visible(win, "live-grid"));
}

/* ── 30. Browser history and the wordmark leave deliberately ─────────── */
{
  const win = boot();
  const T = win.__test;
  T.S.organizer = true;
  T.showIntake("first", true);
  check("intake navigation is recorded", win.history.state && win.history.state.view === "intake", win.history.state);
  T.showSettings("intake", true);
  check("settings navigation is recorded", win.history.state && win.history.state.view === "settings", win.history.state);
  check("wordmark is a root hyperlink", win.document.getElementById("home-link").getAttribute("href") === "/");

  T.S.code = "ABCDE";
  win.confirm = () => false;
  win.dispatchEvent(new win.PopStateEvent("popstate", { state: { view: "landing" } }));
  check("back navigation can keep an active session", T.S.view === "settings" && win.history.state.view === "settings",
    { view: T.S.view, state: win.history.state });

  T.S.state = stateMsg();
  T.showSession();
  win.dispatchEvent(new win.PopStateEvent("popstate", { state: { view: "intake" } }));
  check("back never reopens pre-launch intake during a live round", T.S.view === "session",
    { view: T.S.view, state: win.history.state });
}

/* ── 31. Guided demos use the real views without creating a session ───── */
{
  const win = boot();
  const T = win.__test;
  check("guided demo launcher is available", !!win.document.getElementById("btn-demo"));
  T.startDemo("organizer");
  check("organizer demo opens the real session view", shown(win, "view-session") && T.S.organizer);
  check("organizer demo explains the participant perspective", shown(win, "demo-peer-preview")
    && /Participant view/.test(win.document.getElementById("demo-peer-preview").textContent));
  check("demo hides production organizer controls", !shown(win, "organizer-shelf")
    && !shown(win, "end-rail") && !shown(win, "code-chip"));
  check("demo guide is anchored to its highlighted control", win.document.querySelector(".demo-target").hasAttribute("data-demo-tooltip")
    && win.document.querySelector(".demo-target").getAttribute("aria-describedby") === "demo-guide");
  check("demo begins on a manual first frame", T.S.demo.step === 0
    && win.document.getElementById("btn-demo-prev").disabled
    && !win.document.getElementById("btn-demo-next").disabled
    && /Use Next/.test(win.document.getElementById("demo-progress").textContent));

  win.document.getElementById("btn-demo-next").click();
  check("organizer demo simulates live participant charts", T.S.state.round.liveShapes.length === 2
    && shown(win, "live-inputs"));
  check("demo hides live-view switches", !visible(win, "btn-live-overlay") && !visible(win, "btn-live-grid"));
  win.document.getElementById("btn-demo-prev").click();
  check("demo can manually return to a prior frame", T.S.demo.step === 0);
  T.runDemoStep("organizer", 1);
  T.runDemoStep("organizer", 2);
  check("organizer demo simulates a concluded issue", shown(win, "history-card")
    && /Finish the round/.test(win.document.getElementById("demo-title").textContent));
  T.runDemoStep("organizer", 3);
  check("organizer demo reaches session results", shown(win, "final-summary-card")
    && /Wrap up/.test(win.document.getElementById("demo-title").textContent));
  T.stopDemo();
  check("exiting organizer demo returns to landing", shown(win, "view-landing") && !shown(win, "demo-guide"));

  const pending = { close() { this.closed = true; }, onopen() {}, onmessage() {}, onclose() {} };
  T.S.ws = pending;
  T.startDemo("participant");
  check("demo disconnects any pending real connection", pending.closed && T.S.ws === null);
  check("participant demo begins waiting for the organizer", !T.S.organizer
    && /Join and wait/.test(win.document.getElementById("demo-title").textContent));
  T.runDemoStep("participant", 1);
  check("participant demo shows the private chart after organizer launch", shown(win, "plot-wrap")
    && /Make a private estimate/.test(win.document.getElementById("demo-title").textContent));
  T.runDemoStep("participant", 2);
  check("participant demo displays a read-only submitted estimate", !shown(win, "submit-row")
    && /Submission recorded/.test(win.document.getElementById("demo-title").textContent));
  T.runDemoStep("participant", 3);
  check("participant demo receives an anonymized result", shown(win, "summary-card")
    && /Anonymous response/.test(win.document.getElementById("minis").textContent));
  T.stopDemo();
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
