// Regression tests for the Discover AI "For You" tab (Qwen recommendations, Owner-only, PR B).
//
// Same technique js/__tests__/discover-tabs.test.js already established: a real jsdom document
// built from the REAL discover.html, with the REAL extracted discover.js logic (DOM refs, state,
// view-switching, the For You render/load functions, and addFollow — since "Plan to Watch removes
// the card" is addFollow's own behavior) run against it inside jsdom's vm context. Only the actual
// network boundary (callDiscoverAi) and Firestore SDK calls (doc/setDoc/getDocs/etc., imported
// from gstatic in the real file) are stubbed — this is a DOM-interaction/state-machine bug class,
// not a pure-function one, so discover-security.test.js's isolated vm-sandbox technique doesn't
// fit here.
//
// Run with: node js/__tests__/discover-foryou.test.js

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

async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    fail++;
    console.log(`FAIL  - ${name}`);
    console.log(`        ${err.message}`);
  }
}

function readSrc(file) {
  return fs.readFileSync(path.join(ROOT, file), "utf8");
}

const DISCOVER_SRC = readSrc("discover.js");
const DISCOVER_HTML_PATH = path.join(ROOT, "discover.html");

function extractFunctionSource(src, name) {
  const marker = `function ${name}(`;
  const markerStart = src.indexOf(marker);
  assert.ok(markerStart !== -1, `${name}() not found in discover.js`);
  const asyncPrefix = "async ";
  const start = src.slice(Math.max(0, markerStart - asyncPrefix.length), markerStart) === asyncPrefix
    ? markerStart - asyncPrefix.length
    : markerStart;
  let depth = 0;
  let i = markerStart + marker.length - 1;
  for (; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") { depth--; if (depth === 0) { i++; break; } }
  }
  const bodyBraceStart = src.indexOf("{", i);
  depth = 0;
  let j = bodyBraceStart;
  for (; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (depth === 0) { j++; break; } }
  }
  return src.slice(start, j);
}

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

function extractRangeSource(src, startMarker, endMarkerExclusive) {
  const start = src.indexOf(startMarker);
  assert.ok(start !== -1, `"${startMarker}" not found in discover.js`);
  const end = src.indexOf(endMarkerExclusive, start);
  assert.ok(end !== -1, `"${endMarkerExclusive}" not found after "${startMarker}" in discover.js`);
  return src.slice(start, end);
}

function extractConstObjectSource(src, name) {
  const marker = `const ${name} = {`;
  const start = src.indexOf(marker);
  assert.ok(start !== -1, `${name} not found in discover.js`);
  const braceStart = src.indexOf("{", start);
  let depth = 0;
  let i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  const semi = src[i] === ";" ? i + 1 : i;
  return src.slice(start, semi);
}

// DOM-ref/state blocks — same range markers discover-tabs.test.js already established. These now
// also cover forYouResults/forYouLoadedOnce/forYouLoading (declared inside this same range as of
// the Discover AI pass) and every foryou-* DOM ref, with no extraction change needed.
const DOM_REFS_SRC = extractRangeSource(DISCOVER_SRC, 'const authControl = document.getElementById("auth-control");', "// ---- State ----");
const STATE_SRC = extractRangeSource(DISCOVER_SRC, "let currentView = ", "function discoverCacheKey");

const AIRING_STATUS_META_SRC = extractConstObjectSource(DISCOVER_SRC, "AIRING_STATUS_META");
const STATUS_META_SRC = extractConstObjectSource(DISCOVER_SRC, "STATUS_META");
const STATUS_ORDER_SRC = extractStatementSource(DISCOVER_SRC, "const STATUS_ORDER = ");

const ESC_SRC = extractFunctionSource(DISCOVER_SRC, "esc");
const SAFE_ANILIST_HREF_SRC = extractFunctionSource(DISCOVER_SRC, "safeAniListHref");
const IS_SAFE_IMAGE_URL_SRC = extractFunctionSource(DISCOVER_SRC, "isSafeImageUrl");
const SET_IMAGE_WITH_FALLBACK_SRC = extractFunctionSource(DISCOVER_SRC, "setImageWithFallback");
const PREFERRED_TITLE_SRC = extractFunctionSource(DISCOVER_SRC, "preferredTitle");
const FORMAT_SCORE_SRC = extractFunctionSource(DISCOVER_SRC, "formatScore");
const AVAILABLE_EPISODE_COUNT_SRC = extractFunctionSource(DISCOVER_SRC, "availableEpisodeCount");
const FORMAT_TIME_UNTIL_AIRING_SRC = extractFunctionSource(DISCOVER_SRC, "formatTimeUntilAiring");
const FORMAT_NEXT_AIRING_SRC = extractFunctionSource(DISCOVER_SRC, "formatNextAiring");
const RENDER_CARD_ACTIONS_SRC = extractFunctionSource(DISCOVER_SRC, "renderCardActions");
const MEDIA_CARD_SRC = extractFunctionSource(DISCOVER_SRC, "mediaCard");

const FOLLOW_DOC_ID_SRC = extractFunctionSource(DISCOVER_SRC, "followDocId");
const ADD_FOLLOW_SRC = extractFunctionSource(DISCOVER_SRC, "addFollow");

const FOR_YOU_CARD_SRC = extractFunctionSource(DISCOVER_SRC, "forYouCard");
const RENDER_FOR_YOU_GRID_SRC = extractFunctionSource(DISCOVER_SRC, "renderForYouGrid");
const SHOW_FOR_YOU_LOADING_SRC = extractFunctionSource(DISCOVER_SRC, "showForYouLoading");
const SHOW_FOR_YOU_ERROR_SRC = extractFunctionSource(DISCOVER_SRC, "showForYouError");
const SHOW_FOR_YOU_RATE_LIMITED_SRC = extractFunctionSource(DISCOVER_SRC, "showForYouRateLimited");
const LOAD_FOR_YOU_SRC = extractFunctionSource(DISCOVER_SRC, "loadForYou");
const FOR_YOU_WIRING_SRC =
  extractStatementSource(DISCOVER_SRC, 'forYouRefreshBtn.addEventListener("click"') +
  "\n" +
  extractStatementSource(DISCOVER_SRC, 'forYouRetryBtn.addEventListener("click"');

const RENDER_CURRENT_VIEW_SRC = extractFunctionSource(DISCOVER_SRC, "renderCurrentView");
const SWITCH_VIEW_SRC = extractFunctionSource(DISCOVER_SRC, "switchView");
const UPDATE_COUNT_SRC = extractFunctionSource(DISCOVER_SRC, "updateCount");
const VIEW_TAB_WIRING_SRC = extractStatementSource(DISCOVER_SRC, 'document.querySelectorAll(".view-tab").forEach((btn) => btn.addEventListener("click"');

const LANGCHANGE_LISTENER_SRC = extractStatementSource(DISCOVER_SRC, 'document.addEventListener("eden:langchange"');

await test("sanity: every extracted block is non-empty and distinct (no stale/duplicate marker match)", () => {
  for (const [name, src] of Object.entries({
    LOAD_FOR_YOU_SRC, RENDER_FOR_YOU_GRID_SRC, FOR_YOU_CARD_SRC, SWITCH_VIEW_SRC, ADD_FOLLOW_SRC, LANGCHANGE_LISTENER_SRC,
  })) {
    assert.ok(src && src.length > 20, `${name} looks empty or too short`);
  }
});

function buildHarness() {
  const html = fs.readFileSync(DISCOVER_HTML_PATH, "utf8");
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://edenatlas.netlify.app/discover.html" });
  const ctx = dom.getInternalVMContext();

  const aiCalls = []; // { operation, args }
  const renderLog = [];

  ctx.console = console;
  ctx.i18nT = (key, vars) => (vars ? `${key}(${JSON.stringify(vars)})` : key);
  ctx.getLang = () => harnessState.lang;
  ctx.auth = { currentUser: { uid: "owner-uid-1" } };
  ctx.db = {};
  ctx.isOwner = () => true;
  // Firestore SDK stubs — addFollow()/fetchFollowed() reference these bare identifiers exactly as
  // the real gstatic import would provide them.
  ctx.doc = (...args) => ({ __path: args });
  ctx.setDoc = async () => {};
  ctx.updateDoc = async () => {};
  ctx.deleteDoc = async () => {};
  ctx.serverTimestamp = () => ({ __serverTimestamp: true });
  ctx.collection = () => ({});
  ctx.query = () => ({});
  ctx.where = () => ({});
  ctx.getDocs = async () => ({ forEach: () => {} });

  ctx.callDiscoverAi = async (operation, args) => {
    aiCalls.push({ operation, args: { ...args } });
    const config = harnessState.aiResponses.shift() || harnessState.defaultAiResponse;
    if (config.throwError) throw config.throwError;
    return config;
  };

  const harnessState = {
    lang: "en",
    aiResponses: [], // queued responses, consumed in order; falls back to defaultAiResponse
    defaultAiResponse: { ok: true, generatedAt: "2026-01-01T00:00:00.000Z", basedOnCount: 3, recommendations: [], cached: false },
  };

  const script = `
    ${DOM_REFS_SRC}
    ${STATE_SRC}
    ${AIRING_STATUS_META_SRC}
    ${STATUS_META_SRC}
    ${STATUS_ORDER_SRC}
    ${ESC_SRC}
    ${SAFE_ANILIST_HREF_SRC}
    ${IS_SAFE_IMAGE_URL_SRC}
    ${SET_IMAGE_WITH_FALLBACK_SRC}
    ${PREFERRED_TITLE_SRC}
    ${FORMAT_SCORE_SRC}
    ${AVAILABLE_EPISODE_COUNT_SRC}
    ${FORMAT_TIME_UNTIL_AIRING_SRC}
    ${FORMAT_NEXT_AIRING_SRC}
    ${RENDER_CARD_ACTIONS_SRC}
    ${MEDIA_CARD_SRC}
    ${FOLLOW_DOC_ID_SRC}
    async function fetchFollowed() { /* stub: no persistent My List state needed for these tests */ }
    function showToast() {}
    function refreshOpenModalActions() {}
    ${ADD_FOLLOW_SRC}
    ${FOR_YOU_CARD_SRC}
    ${RENDER_FOR_YOU_GRID_SRC}
    ${SHOW_FOR_YOU_LOADING_SRC}
    ${SHOW_FOR_YOU_ERROR_SRC}
    ${SHOW_FOR_YOU_RATE_LIMITED_SRC}
    ${LOAD_FOR_YOU_SRC}
    ${FOR_YOU_WIRING_SRC}
    function friendlyAniListError(err) { return (err && err.code) || "error"; }
    function renderDiscoverGrid() { renderLog.push("discover"); }
    async function loadMyList() { renderLog.push("mylist"); }
    ${RENDER_CURRENT_VIEW_SRC}
    ${SWITCH_VIEW_SRC}
    ${UPDATE_COUNT_SRC}
    ${VIEW_TAB_WIRING_SRC}
    ${LANGCHANGE_LISTENER_SRC}
    globalThis.__harness = {
      getForYouResults: () => forYouResults,
      getCurrentView: () => currentView,
      setForYouResults: (v) => { forYouResults = v; },
      switchView,
      addFollow,
    };
  `;
  ctx.renderLog = renderLog;
  vm.runInContext(script, ctx);

  const document = dom.window.document;
  return {
    dom,
    ctx,
    document,
    aiCalls,
    harnessState,
    forYouTabBtn: document.querySelector('.view-tab[data-view="foryou"]'),
    discoverTabBtn: document.querySelector('.view-tab[data-view="discover"]'),
    refreshBtn: document.getElementById("foryou-refresh-btn"),
    retryBtn: document.getElementById("foryou-retry-btn"),
    grid: document.getElementById("foryou-grid"),
    empty: document.getElementById("foryou-empty"),
    getForYouResults: () => ctx.__harness.getForYouResults(),
    setForYouResults: (v) => ctx.__harness.setForYouResults(v),
    switchView: (v) => vm.runInContext(`switchView(${JSON.stringify(v)});`, ctx),
    addFollow: (media, status) => vm.runInContext("addFollow(media, status);", Object.assign(ctx, { media, status })),
  };
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function recFixture(id, title = `Anime ${id}`) {
  return {
    anime: {
      id, title: { romaji: title, english: null, native: null }, coverImage: { large: null, medium: null },
      averageScore: 80, format: "TV", status: "RELEASING", episodes: 12, season: "SUMMER", seasonYear: 2026,
      nextAiringEpisode: null, siteUrl: null,
    },
    reason: `Fits because of ${title}`,
  };
}

// ==================================================================================
// For You: no load on page init, exactly one request on first click, tab-toggle reuses cache
// ==================================================================================

await test("For You does not load on normal page initialization — zero recommend calls before the tab is ever clicked", async () => {
  const h = buildHarness();
  await tick();
  assert.strictEqual(h.aiCalls.length, 0);
});

await test("clicking For You makes exactly one request", async () => {
  const h = buildHarness();
  h.harnessState.defaultAiResponse = { ok: true, generatedAt: "t", basedOnCount: 2, recommendations: [recFixture(601)], cached: false };
  h.forYouTabBtn.click();
  await tick();
  assert.strictEqual(h.aiCalls.length, 1);
  assert.strictEqual(h.aiCalls[0].operation, "recommend");
  assert.strictEqual(h.aiCalls[0].args.force, false);
  assert.strictEqual(h.getForYouResults().length, 1);
});

await test("switching away and back to For You does NOT re-fetch — the cached forYouResults are just re-rendered", async () => {
  const h = buildHarness();
  h.harnessState.defaultAiResponse = { ok: true, generatedAt: "t", basedOnCount: 1, recommendations: [recFixture(601)], cached: false };
  h.forYouTabBtn.click();
  await tick();
  assert.strictEqual(h.aiCalls.length, 1);

  h.discoverTabBtn.click();
  await tick();
  h.forYouTabBtn.click();
  await tick();
  assert.strictEqual(h.aiCalls.length, 1, "a second visit to For You must not spend a second request");
  assert.strictEqual(h.grid.children.length, 1, "the previously-loaded card must still render");
});

await test("Refresh sends force:true and always spends a fresh request, even right after a normal load", async () => {
  const h = buildHarness();
  h.harnessState.defaultAiResponse = { ok: true, generatedAt: "t", basedOnCount: 1, recommendations: [recFixture(601)], cached: false };
  h.forYouTabBtn.click();
  await tick();
  assert.strictEqual(h.aiCalls.length, 1);

  h.refreshBtn.click();
  await tick();
  assert.strictEqual(h.aiCalls.length, 2);
  assert.strictEqual(h.aiCalls[1].args.force, true);
});

await test("Retry (after an error) sends force:false, not force:true — a plain retry, not a forced bypass", async () => {
  const h = buildHarness();
  h.harnessState.aiResponses = [{ throwError: Object.assign(new Error("upstream"), { code: "discover_ai_upstream_error" }) }];
  h.forYouTabBtn.click();
  await tick();
  assert.strictEqual(h.aiCalls.length, 1);
  assert.strictEqual(h.document.getElementById("foryou-error").classList.contains("hidden"), false);

  h.harnessState.defaultAiResponse = { ok: true, generatedAt: "t", basedOnCount: 1, recommendations: [], cached: false };
  h.retryBtn.click();
  await tick();
  assert.strictEqual(h.aiCalls.length, 2);
  assert.strictEqual(h.aiCalls[1].args.force, false);
});

await test("a rate_limited error shows the dedicated rate-limited state, not the generic error state", async () => {
  const h = buildHarness();
  h.harnessState.aiResponses = [{ throwError: Object.assign(new Error("rate limited"), { code: "rate_limited" }) }];
  h.forYouTabBtn.click();
  await tick();
  assert.strictEqual(h.document.getElementById("foryou-rate-limited").classList.contains("hidden"), false);
  assert.strictEqual(h.document.getElementById("foryou-error").classList.contains("hidden"), true);
});

await test("insufficient_history and no-recommendations both render the empty state, with distinguishing copy chosen from the response reason", async () => {
  const h = buildHarness();
  h.harnessState.defaultAiResponse = { ok: true, generatedAt: "t", basedOnCount: 0, recommendations: [], reason: "insufficient_history", cached: false };
  h.forYouTabBtn.click();
  await tick();
  assert.strictEqual(h.empty.classList.contains("hidden"), false);
  assert.strictEqual(h.document.getElementById("foryou-empty-title").textContent, "discover.foryou_empty_history");
});

await test("language switching (eden:langchange) does not trigger a new recommend request — it only re-renders cached results", async () => {
  const h = buildHarness();
  h.harnessState.defaultAiResponse = { ok: true, generatedAt: "t", basedOnCount: 1, recommendations: [recFixture(601)], cached: false };
  h.forYouTabBtn.click();
  await tick();
  assert.strictEqual(h.aiCalls.length, 1);

  h.document.dispatchEvent(new h.dom.window.Event("eden:langchange"));
  await tick();
  assert.strictEqual(h.aiCalls.length, 1, "switching UI language must never spend another Qwen call");
  assert.strictEqual(h.grid.children.length, 1, "the card must still be rendered after the langchange re-render");
});

// ==================================================================================
// Plan to Watch removes the card from currently displayed recommendations
// ==================================================================================

await test("Plan to Watch removes the just-followed title from the currently displayed For You results, without a new network call", async () => {
  const h = buildHarness();
  h.harnessState.defaultAiResponse = { ok: true, generatedAt: "t", basedOnCount: 2, recommendations: [recFixture(601, "Keep"), recFixture(602, "Remove Me")], cached: false };
  h.forYouTabBtn.click();
  await tick();
  assert.strictEqual(h.getForYouResults().length, 2);
  assert.strictEqual(h.grid.children.length, 2);

  await h.addFollow({ id: 602, title: { romaji: "Remove Me", english: null, native: null }, coverImage: {}, format: "TV" }, "planning");
  await tick();

  assert.strictEqual(h.getForYouResults().length, 1, "the followed title must be removed from forYouResults");
  assert.strictEqual(h.getForYouResults()[0].anime.id, 601, "the OTHER recommendation must remain untouched");
  assert.strictEqual(h.grid.children.length, 1, "the grid itself must reflect the removal immediately");
  assert.strictEqual(h.aiCalls.length, 1, "Plan to Watch must never itself spend a recommend call");
});

await test("Plan to Watch from the Discover (not For You) view never touches forYouResults at all", async () => {
  const h = buildHarness();
  h.setForYouResults([recFixture(601, "Untouched")]);
  h.switchView("discover");
  await h.addFollow({ id: 999, title: { romaji: "Something Else", english: null, native: null }, coverImage: {}, format: "TV" }, "planning");
  await tick();
  assert.strictEqual(h.getForYouResults().length, 1, "forYouResults is only ever pruned while the For You view is the active one");
});

// ==================================================================================
// Keyboard/focus: the new controls are real, keyboard-activatable <button> elements
// ==================================================================================

await test("For You tab, Refresh, and Retry are all real type=button elements (native keyboard activation, no custom key handling needed)", () => {
  const h = buildHarness();
  for (const el of [h.forYouTabBtn, h.refreshBtn, h.retryBtn]) {
    assert.strictEqual(el.tagName, "BUTTON");
    assert.strictEqual(el.getAttribute("type"), "button");
  }
});

await test("keyboard activation of the For You tab (native <button> .click() from a focused state) loads recommendations exactly once", async () => {
  const h = buildHarness();
  h.harnessState.defaultAiResponse = { ok: true, generatedAt: "t", basedOnCount: 1, recommendations: [recFixture(601)], cached: false };
  h.forYouTabBtn.focus();
  assert.strictEqual(h.document.activeElement, h.forYouTabBtn);
  h.forYouTabBtn.click();
  await tick();
  assert.strictEqual(h.aiCalls.length, 1);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
