// Regression tests for the PR #8 Live QA bug: clicking "Trending" or "Search" on Discover did
// nothing (This Season loaded fine because it's the default subtab, driven directly by
// initDiscoverPage() rather than a click). Root cause: discover.js defined switchDiscoverSubtab()
// and toggled `.discover-subtab` active-state classes from inside it, but never actually attached
// a click listener to those three buttons anywhere in the file -- unlike `.view-tab` and
// `.mylist-filter-tab`, which both had `document.querySelectorAll(...).forEach((btn) =>
// btn.addEventListener("click", ...))` wiring. The fix adds the missing wiring block for
// `.discover-subtab`.
//
// This is a DOM-interaction bug, not a pure-function bug, so (unlike
// js/__tests__/discover-security.test.js's vm-sandboxed pure-function extraction) this file loads
// the REAL discover.html markup into jsdom (already a devDependency, used by
// js/__tests__/xss-security.test.js) with `runScripts: "outside-only"` -- external <script> tags
// are never auto-executed -- then extracts the REAL relevant source blocks out of discover.js
// (the DOM-ref consts, the state vars, discoverCacheKey(), switchDiscoverSubtab(),
// loadDiscoverGrid(), and the two top-level click/submit wiring statements) and runs them against
// that real DOM inside jsdom's internal vm context. AniList network calls are the one thing
// stubbed (a `callAniList` recorder) -- the server-side operation contract itself is already
// exhaustively covered by netlify/functions/__tests__/anilist.test.js; this file is only
// responsible for proving the CLICK reaches the RIGHT operation exactly once.
//
// Run with: node js/__tests__/discover-tabs.test.js

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");

let pass = 0;
let fail = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    fail++;
    failures.push({ name, err });
    console.log(`FAIL  - ${name}`);
    console.log(`        ${err.message}`);
  }
}

function readSrc(file) {
  return fs.readFileSync(path.join(ROOT, file), "utf8");
}

const DISCOVER_SRC = readSrc("discover.js");
const DISCOVER_HTML_PATH = path.join(ROOT, "discover.html");

// ---- Extract a real top-level `[async ]function name(...) { ... }` declaration.
// Balances the PARAMETER LIST's parens first (skipping over any brace it contains, e.g.
// loadDiscoverGrid's `({ force = false } = {})` default-destructure -- a naive "find the first {
// and brace-balance from there" breaks on exactly this shape, since that first `{` belongs to the
// parameter, not the function body), then finds the body's own opening `{` and brace-balances
// that. Also restores a leading `async ` keyword if present, since the marker search below starts
// at the `function` keyword itself. ----
function extractFunctionSource(src, name) {
  const marker = `function ${name}(`;
  const markerStart = src.indexOf(marker);
  assert.ok(markerStart !== -1, `${name}() not found in discover.js`);
  const asyncPrefix = "async ";
  const start = src.slice(Math.max(0, markerStart - asyncPrefix.length), markerStart) === asyncPrefix
    ? markerStart - asyncPrefix.length
    : markerStart;

  // Balance the parameter list's own parens (ignore braces here -- they may belong to a default
  // destructured parameter, not the function body).
  let depth = 0;
  let i = markerStart + marker.length - 1; // the "(" itself
  for (; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }

  // Now find the body's opening "{" (the first one after the parameter list closes) and
  // brace-balance from there.
  const bodyBraceStart = src.indexOf("{", i);
  depth = 0;
  let j = bodyBraceStart;
  for (; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") {
      depth--;
      if (depth === 0) { j++; break; }
    }
  }
  return src.slice(start, j);
}

// ---- Extract a real top-level statement starting at `marker` (search begins at `fromIndex`, to
// disambiguate a marker text that also appears verbatim inside an earlier function body -- e.g.
// `.discover-subtab` is matched both by switchDiscoverSubtab()'s own internal
// querySelectorAll(...).forEach(...) class-toggle and by the new click-wiring statement this test
// is actually about), ending at the first paren/brace-balanced top-level `;` -- used for the
// click/submit wiring statements, which are bare expression statements, not named functions. ----
function extractStatementSource(src, marker, fromIndex = 0) {
  const start = src.indexOf(marker, fromIndex);
  assert.ok(start !== -1, `"${marker}" not found in discover.js (searching from index ${fromIndex})`);
  let depth = 0;
  let i = start;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "(" || c === "{") depth++;
    else if (c === ")" || c === "}") depth--;
    if (depth === 0 && c === ";" && i > start) { i++; break; }
  }
  return src.slice(start, i);
}

// ---- Extract a verbatim source range between two exact substrings (used for the DOM-ref consts
// and state-var blocks, which are a run of several `const`/`let` statements, not one function). ----
function extractRangeSource(src, startMarker, endMarkerExclusive) {
  const start = src.indexOf(startMarker);
  assert.ok(start !== -1, `"${startMarker}" not found in discover.js`);
  const end = src.indexOf(endMarkerExclusive, start);
  assert.ok(end !== -1, `"${endMarkerExclusive}" not found after "${startMarker}" in discover.js`);
  return src.slice(start, end);
}

// The exact DOM-ref const block discover.js declares (lines ~193-223 as of this pass) -- every
// element it references must exist in the real discover.html markup we load into jsdom below.
const DOM_REFS_SRC = extractRangeSource(
  DISCOVER_SRC,
  'const authControl = document.getElementById("auth-control");',
  "// ---- State ----"
);

// The exact module-state `let` declarations discover.js uses.
const STATE_SRC = extractRangeSource(
  DISCOVER_SRC,
  "let currentView = ",
  "function discoverCacheKey"
);

const DISCOVER_CACHE_KEY_SRC = extractFunctionSource(DISCOVER_SRC, "discoverCacheKey");
const SWITCH_DISCOVER_SUBTAB_SRC = extractFunctionSource(DISCOVER_SRC, "switchDiscoverSubtab");
const LOAD_DISCOVER_GRID_SRC = extractFunctionSource(DISCOVER_SRC, "loadDiscoverGrid");

// The fix under test: the click-wiring block for `.discover-subtab` (This Season / Trending /
// Search). Extracting this from the real file means a future accidental removal/re-break of this
// exact wiring fails this test immediately. The literal text
// `document.querySelectorAll(".discover-subtab").forEach((btn) => {` also appears earlier, inside
// switchDiscoverSubtab()'s own class-toggle loop -- searching from just past that function's
// extracted source finds the actual (second, distinct) click-wiring occurrence.
const SWITCH_DISCOVER_SUBTAB_END = DISCOVER_SRC.indexOf(SWITCH_DISCOVER_SUBTAB_SRC) + SWITCH_DISCOVER_SUBTAB_SRC.length;
const SUBTAB_CLICK_WIRING_SRC = extractStatementSource(
  DISCOVER_SRC,
  'document.querySelectorAll(".discover-subtab").forEach((btn) => {',
  SWITCH_DISCOVER_SUBTAB_END
);

const SEARCH_FORM_SUBMIT_WIRING_SRC = extractStatementSource(
  DISCOVER_SRC,
  'discoverSearchForm.addEventListener("submit", (event) => {'
);

await test("sanity: the fix's click-wiring block was actually extracted from the real file (not empty/stale, and distinct from switchDiscoverSubtab()'s own internal class-toggle loop)", () => {
  assert.ok(SUBTAB_CLICK_WIRING_SRC.includes("switchDiscoverSubtab(btn.dataset.subtab)"));
  assert.ok(SUBTAB_CLICK_WIRING_SRC.includes("addEventListener(\"click\""), "must be the click-registering block, not the class-toggle loop inside switchDiscoverSubtab()");
  assert.ok(SUBTAB_CLICK_WIRING_SRC.includes(".discover-subtab"));
});

await test("sanity: exactly two `.discover-subtab` querySelectorAll call sites exist -- one class-toggle loop inside switchDiscoverSubtab(), one click-wiring registration -- never a duplicate registration of the click listener itself", () => {
  const totalQuerySelectorAllSites = DISCOVER_SRC.split('document.querySelectorAll(".discover-subtab")').length - 1;
  assert.strictEqual(totalQuerySelectorAllSites, 2, "expected exactly two querySelectorAll(\".discover-subtab\") call sites in discover.js (class-toggle + click-wiring)");
  // Normalize CRLF/LF before matching -- this repo's tracked files are checked out with CRLF
  // (Windows core.autocrlf), same already-documented gotcha discover-security.test.js's own
  // norm() helper works around.
  const normalizedSrc = DISCOVER_SRC.replace(/\r\n/g, "\n");
  const clickRegistrationSites = normalizedSrc.split('btn.addEventListener("click", () => {\n    switchDiscoverSubtab(btn.dataset.subtab);').length - 1;
  assert.strictEqual(clickRegistrationSites, 1, "the actual click-listener registration for .discover-subtab must appear exactly once");
});

// ---- Harness: build a real jsdom document from the REAL discover.html, then run the REAL
// extracted discover.js logic above against it inside jsdom's own vm context, with only the
// network call (callAniList) and pure-render helpers (which mediaCard()'s huge dependency graph
// would otherwise drag in, irrelevant to this bug) stubbed. ----

function buildHarness() {
  const html = fs.readFileSync(DISCOVER_HTML_PATH, "utf8");
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://edenatlas.netlify.app/discover.html" });
  const ctx = dom.getInternalVMContext();

  const calls = []; // { operation, args } for every callAniList() invocation
  const renderLog = []; // records of stubbed render calls, for the "survives a re-render" test

  ctx.console = console;
  ctx.callAniList = async (operation, args) => {
    calls.push({ operation, args: { ...args } });
    return { results: [], result: null };
  };
  // Real renderDiscoverGrid()/mediaCard() pull in i18nT/cachedFollowed/esc/etc. -- none of that
  // is what this bug is about (the bug is "does a click reach loadDiscoverGrid() with the right
  // operation", not "does a card render correctly", which discover-security.test.js and manual
  // QA already cover). These stubs *do* touch the real DOM, so a re-render's effect on button
  // wiring is still genuinely exercised (see the "survives a re-render" test below).
  const script = `
    ${DOM_REFS_SRC}
    ${STATE_SRC}
    function showDiscoverLoading() { renderLog.push("loading"); }
    function showDiscoverError(err) { renderLog.push("error:" + (err && err.code)); }
    function renderDiscoverGrid() {
      renderLog.push("render:" + discoverResults.length);
      discoverGrid.replaceChildren();
      const marker = document.createElement("div");
      marker.className = "rendered-marker";
      discoverGrid.appendChild(marker);
    }
    function updateCount() {}
    ${DISCOVER_CACHE_KEY_SRC}
    ${SWITCH_DISCOVER_SUBTAB_SRC}
    ${LOAD_DISCOVER_GRID_SRC}
    ${SUBTAB_CLICK_WIRING_SRC}
    ${SEARCH_FORM_SUBMIT_WIRING_SRC}
    globalThis.__harness = {
      getCurrentSubtab: () => currentDiscoverSubtab,
      getLastSearchQuery: () => lastSearchQuery,
      switchDiscoverSubtab,
    };
  `;
  ctx.renderLog = renderLog;
  vm.runInContext(script, ctx);

  const document = dom.window.document;
  return {
    dom,
    ctx,
    calls,
    renderLog,
    document,
    thisSeasonBtn: document.querySelector('.discover-subtab[data-subtab="this_season"]'),
    trendingBtn: document.querySelector('.discover-subtab[data-subtab="trending"]'),
    searchBtn: document.querySelector('.discover-subtab[data-subtab="search"]'),
    searchBar: document.getElementById("discover-search-bar"),
    searchInput: document.getElementById("discover-search-input"),
    searchForm: document.getElementById("discover-search-form"),
    getCurrentSubtab: () => ctx.__harness.getCurrentSubtab(),
    getLastSearchQuery: () => ctx.__harness.getLastSearchQuery(),
    initThisSeasonView: () => vm.runInContext("switchDiscoverSubtab(currentDiscoverSubtab);", ctx), // mirrors initDiscoverPage()'s direct call
  };
}

// Wait for a microtask/macrotask tick so an async loadDiscoverGrid() (awaiting the stubbed
// callAniList) has a chance to resolve before assertions run.
function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ==================================================================================
// Section A — the reported bug: Trending/Search were unclickable; This Season worked only via
// direct initialization, never via its own click either.
// ==================================================================================

await test("after initial This Season render, Trending remains clickable and sends exactly one trending request", async () => {
  const h = buildHarness();
  h.initThisSeasonView(); // simulates initDiscoverPage()'s switchDiscoverSubtab("this_season")
  await tick();
  assert.strictEqual(h.calls.length, 1, "This Season's own initial load should fire exactly once");
  assert.strictEqual(h.calls[0].operation, "browse");
  assert.strictEqual(h.calls[0].args.mode, "this_season");

  h.trendingBtn.click();
  await tick();

  assert.strictEqual(h.getCurrentSubtab(), "trending", "Trending must become the active subtab on click");
  const trendingCalls = h.calls.filter((c) => c.args && c.args.mode === "trending");
  assert.strictEqual(trendingCalls.length, 1, "clicking Trending must send exactly one trending browse request");
  assert.strictEqual(trendingCalls[0].operation, "browse");
  assert.strictEqual(trendingCalls[0].args.perPage, 20, "page size must stay 20 (no Load More/infinite scroll change)");
});

await test("Trending tab visually becomes active (the same class-toggle switchDiscoverSubtab already used for This Season)", async () => {
  const h = buildHarness();
  h.initThisSeasonView();
  await tick();
  assert.ok(h.thisSeasonBtn.classList.contains("text-white"));

  h.trendingBtn.click();
  await tick();

  assert.ok(h.trendingBtn.classList.contains("text-white"));
  assert.ok(h.trendingBtn.classList.contains("bg-neonPurple/15"));
  assert.ok(!h.thisSeasonBtn.classList.contains("text-white"), "This Season must lose active styling once Trending is active");
});

await test("Search click displays the search UI and focuses the search input", async () => {
  const h = buildHarness();
  h.initThisSeasonView();
  await tick();
  assert.ok(h.searchBar.classList.contains("hidden"), "search bar must start hidden on This Season");

  h.searchBtn.click();
  await tick();

  assert.strictEqual(h.getCurrentSubtab(), "search");
  assert.ok(!h.searchBar.classList.contains("hidden"), "search bar must become visible when Search is clicked");
  assert.strictEqual(h.document.activeElement, h.searchInput, "the search input must receive focus when Search is clicked");
  // No query typed yet -- must not fire a network request with an empty query.
  const searchCalls = h.calls.filter((c) => c.operation === "search");
  assert.strictEqual(searchCalls.length, 0, "opening Search alone (no query) must not call the search operation");
});

await test("submitting a query performs the fixed 'search' operation exactly once", async () => {
  const h = buildHarness();
  h.initThisSeasonView();
  await tick();
  h.searchBtn.click();
  await tick();

  h.searchInput.value = "Naruto";
  h.searchForm.dispatchEvent(new h.dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await tick();

  const searchCalls = h.calls.filter((c) => c.operation === "search");
  assert.strictEqual(searchCalls.length, 1, "submitting a query must send exactly one search request");
  assert.strictEqual(searchCalls[0].args.query, "Naruto");
  assert.strictEqual(searchCalls[0].args.perPage, 20);
});

await test("switching back to This Season still works after visiting Trending and Search", async () => {
  const h = buildHarness();
  h.initThisSeasonView();
  await tick();
  h.trendingBtn.click();
  await tick();
  h.searchBtn.click();
  await tick();

  h.thisSeasonBtn.click();
  await tick();

  assert.strictEqual(h.getCurrentSubtab(), "this_season");
  assert.ok(h.searchBar.classList.contains("hidden"), "search bar must hide again once This Season is reselected");
  assert.ok(h.thisSeasonBtn.classList.contains("text-white"));
  // This Season was already cached from the initial load -- re-selecting it must be a cache hit,
  // not a second network call (requirement: no duplicated API requests).
  const thisSeasonCalls = h.calls.filter((c) => c.args && c.args.mode === "this_season");
  assert.strictEqual(thisSeasonCalls.length, 1, "re-selecting This Season must reuse the cached result, not re-fetch");
});

await test("switching between tabs after a re-render (grid content replaced) still works — the subtab buttons are never inside the re-rendered grid", async () => {
  const h = buildHarness();
  h.initThisSeasonView();
  await tick();
  // renderLog collects both the "loading" stub call and the eventual "render:N" call for one
  // full load cycle -- exactly one of each for the initial This Season load.
  assert.strictEqual(h.renderLog.filter((s) => s === "loading").length, 1, "one loading-state call after the initial load");
  assert.strictEqual(h.renderLog.filter((s) => s.startsWith("render:")).length, 1, "one grid render after the initial load");
  assert.ok(h.document.querySelector("#discover-grid .rendered-marker"), "grid was actually re-rendered by the stub");

  h.trendingBtn.click();
  await tick();
  assert.strictEqual(h.getCurrentSubtab(), "trending");

  h.searchBtn.click();
  await tick();
  assert.strictEqual(h.getCurrentSubtab(), "search");

  h.thisSeasonBtn.click();
  await tick();
  assert.strictEqual(h.getCurrentSubtab(), "this_season", "This Season must still be reachable after multiple re-renders");
});

await test("keyboard activation works (a native <button>'s Enter/Space always dispatches a real 'click' event per the HTML spec, so exercising .click() on a focused button is the standard way to test keyboard activation without a full browser)", async () => {
  const h = buildHarness();
  h.initThisSeasonView();
  await tick();

  h.trendingBtn.focus();
  assert.strictEqual(h.document.activeElement, h.trendingBtn);
  h.trendingBtn.click(); // == what the browser does natively when Enter/Space fires on a focused button
  await tick();

  assert.strictEqual(h.getCurrentSubtab(), "trending");
  const trendingCalls = h.calls.filter((c) => c.args && c.args.mode === "trending");
  assert.strictEqual(trendingCalls.length, 1);
});

await test("no duplicated listeners: a single click never produces more than one request (a double-bound listener would fire loadDiscoverGrid() twice synchronously, both missing the still-empty cache, and both would 1x-call the network before either resolves)", async () => {
  const h = buildHarness();
  h.initThisSeasonView();
  await tick();
  h.calls.length = 0; // clear the initial load's call

  h.trendingBtn.click();
  await tick();

  assert.strictEqual(h.calls.length, 1, "exactly one request must result from exactly one click");
});

await test("This Season's own button is independently clickable (not just reachable via direct init) — clicking it after switching away re-confirms the wiring, not just cache reuse", async () => {
  const h = buildHarness();
  h.initThisSeasonView();
  await tick();
  h.trendingBtn.click();
  await tick();
  assert.strictEqual(h.getCurrentSubtab(), "trending");

  h.thisSeasonBtn.click();
  await tick();
  assert.strictEqual(h.getCurrentSubtab(), "this_season", "This Season's button click handler must itself work, independent of the initial direct call");
});

// ---- Summary ----
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  process.exitCode = 1;
}
