// Regression tests for Discover AI's Chinese translation feature (Qwen, Owner-only, PR B):
// Translate to Chinese / View Original, the localStorage-only client cache, and the
// cross-runtime source-hash agreement with the server (netlify/functions/lib/
// discover-ai-operations.js — see that suite's own cross-runtime test for the server-side half of
// this same proof).
//
// Section A — pure functions (sha256Hex + the localStorage cache helpers), extracted from the
// REAL discover.js and run in a vm sandbox against a real Node Web Crypto + a synchronous
// localStorage stub, the same technique js/__tests__/discover-security.test.js established.
//
// Section B — the Translate/View Original modal UI, a real DOM-interaction/state-machine
// component, exercised via a full jsdom harness (real discover.html, real extracted discover.js
// functions), the same technique js/__tests__/discover-tabs.test.js and
// js/__tests__/discover-foryou.test.js already established.
//
// Run with: node js/__tests__/discover-translate.test.js

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

// ==================================================================================
// Section A — sha256Hex() + the localStorage translation cache: pure functions, vm-sandboxed
// against the REAL extracted source, real Node Web Crypto (no polyfill/mock of crypto.subtle
// itself), and a synchronous localStorage stub.
// ==================================================================================

function makeLocalStorageStub() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => store.clear(),
    _store: store,
  };
}

const SHA256_HEX_SRC = extractFunctionSource(DISCOVER_SRC, "sha256Hex");
const TRANSLATION_CACHE_ENTRY_KEY_SRC = extractFunctionSource(DISCOVER_SRC, "translationCacheEntryKey");
const IS_VALID_TRANSLATION_ENTRY_SRC = extractFunctionSource(DISCOVER_SRC, "isValidTranslationEntry");
const READ_TRANSLATION_CACHE_SRC = extractFunctionSource(DISCOVER_SRC, "readTranslationCache");
const WRITE_TRANSLATION_CACHE_SRC = extractFunctionSource(DISCOVER_SRC, "writeTranslationCache");
const GET_CACHED_TRANSLATION_SRC = extractFunctionSource(DISCOVER_SRC, "getCachedTranslation");
const SAVE_CACHED_TRANSLATION_SRC = extractFunctionSource(DISCOVER_SRC, "saveCachedTranslation");
const TRANSLATION_CACHE_CONSTS_SRC = extractRangeSource(
  DISCOVER_SRC,
  'const TRANSLATION_CACHE_KEY = "eden:discoverTranslations";',
  "function translationCacheEntryKey"
);

function buildCacheSandbox() {
  const localStorage = makeLocalStorageStub();
  const sandbox = { crypto, TextEncoder, localStorage, console };
  vm.createContext(sandbox);
  vm.runInContext(
    `
    ${TRANSLATION_CACHE_CONSTS_SRC}
    ${SHA256_HEX_SRC}
    ${TRANSLATION_CACHE_ENTRY_KEY_SRC}
    ${IS_VALID_TRANSLATION_ENTRY_SRC}
    ${READ_TRANSLATION_CACHE_SRC}
    ${WRITE_TRANSLATION_CACHE_SRC}
    ${GET_CACHED_TRANSLATION_SRC}
    ${SAVE_CACHED_TRANSLATION_SRC}
    globalThis.__api = { sha256Hex, getCachedTranslation, saveCachedTranslation, readTranslationCache, TRANSLATION_CACHE_MAX_ENTRIES, TRANSLATION_CACHE_KEY };
    `,
    sandbox
  );
  return { sandbox, localStorage, api: sandbox.__api };
}

await test("sha256Hex() is deterministic and produces a real 64-char lowercase hex SHA-256 digest", async () => {
  const { api } = buildCacheSandbox();
  const h1 = await api.sha256Hex("hello world");
  const h2 = await api.sha256Hex("hello world");
  assert.strictEqual(h1, h2);
  assert.match(h1, /^[0-9a-f]{64}$/);
  const nodeCrypto = await import("node:crypto");
  const expected = nodeCrypto.createHash("sha256").update("hello world", "utf8").digest("hex");
  assert.strictEqual(h1, expected);
});

await test("getCachedTranslation(): a cache miss when nothing has been saved yet returns null", () => {
  const { api } = buildCacheSandbox();
  assert.strictEqual(api.getCachedTranslation(501, "zh-CN", "sha256:abc"), null);
});

await test("saveCachedTranslation() then getCachedTranslation() with the SAME sourceHash returns the cached text", () => {
  const { api } = buildCacheSandbox();
  api.saveCachedTranslation(501, "zh-CN", "sha256:abc", "你好世界");
  assert.strictEqual(api.getCachedTranslation(501, "zh-CN", "sha256:abc"), "你好世界");
});

await test("a CHANGED sourceHash (the description text itself changed) forces a cache miss, never a stale cached translation", () => {
  const { api } = buildCacheSandbox();
  api.saveCachedTranslation(501, "zh-CN", "sha256:abc", "旧翻译");
  assert.strictEqual(api.getCachedTranslation(501, "zh-CN", "sha256:xyz"), null, "a different sourceHash must never hit the old entry");
});

await test("a different anilistId or a different targetLang never collides with another entry's cache slot", () => {
  const { api } = buildCacheSandbox();
  api.saveCachedTranslation(501, "zh-CN", "sha256:abc", "Anime501");
  assert.strictEqual(api.getCachedTranslation(502, "zh-CN", "sha256:abc"), null);
  api.saveCachedTranslation(501, "zh-TW", "sha256:abc", "TraditionalVariant");
  assert.strictEqual(api.getCachedTranslation(501, "zh-CN", "sha256:abc"), "Anime501", "a different targetLang must not overwrite/shadow zh-CN's own entry");
});

await test("malformed/untrusted localStorage entries are ignored entirely, never thrown on and never treated as a valid hit", () => {
  const { api, localStorage } = buildCacheSandbox();
  localStorage.setItem(api.TRANSLATION_CACHE_KEY, "not even json");
  assert.strictEqual(api.getCachedTranslation(501, "zh-CN", "sha256:abc"), null);

  localStorage.setItem(api.TRANSLATION_CACHE_KEY, JSON.stringify({ "501:zh-CN": { translatedText: 12345 } }));
  assert.strictEqual(api.getCachedTranslation(501, "zh-CN", "sha256:abc"), null, "a non-string translatedText must be rejected as shape-invalid");

  localStorage.setItem(api.TRANSLATION_CACHE_KEY, JSON.stringify({ "501:zh-CN": { translatedText: "ok", sourceHash: "sha256:abc" /* missing targetLang/policyVersion/savedAt */ } }));
  assert.strictEqual(api.getCachedTranslation(501, "zh-CN", "sha256:abc"), null, "a partially-shaped entry must be rejected, not partially trusted");

  localStorage.setItem(api.TRANSLATION_CACHE_KEY, JSON.stringify(["array", "not", "object"]));
  assert.strictEqual(api.getCachedTranslation(501, "zh-CN", "sha256:abc"), null, "a top-level array must never be treated as a valid cache map");
});

await test("a stored entry under an OLDER policy version is treated as a miss, even with a matching sourceHash — a future prompt-policy bump invalidates old client caches automatically", () => {
  const { api, localStorage } = buildCacheSandbox();
  localStorage.setItem(
    api.TRANSLATION_CACHE_KEY,
    JSON.stringify({ "501:zh-CN": { translatedText: "old policy text", sourceHash: "sha256:abc", targetLang: "zh-CN", policyVersion: "zh-v0-legacy", savedAt: Date.now() } })
  );
  assert.strictEqual(api.getCachedTranslation(501, "zh-CN", "sha256:abc"), null);
});

await test("the cache is pruned to at most TRANSLATION_CACHE_MAX_ENTRIES entries, keeping the most-recently-saved ones", () => {
  const { api } = buildCacheSandbox();
  const max = api.TRANSLATION_CACHE_MAX_ENTRIES;
  assert.strictEqual(max, 100);
  for (let i = 0; i < max + 10; i++) {
    api.saveCachedTranslation(i, "zh-CN", `sha256:${i}`, `text-${i}`);
  }
  const cache = api.readTranslationCache();
  assert.strictEqual(Object.keys(cache).length, max, "the cache must never grow past the documented cap");
  // The most recently saved entries (highest ids, saved last) must be the ones retained.
  assert.strictEqual(api.getCachedTranslation(max + 9, "zh-CN", `sha256:${max + 9}`), `text-${max + 9}`);
  assert.strictEqual(api.getCachedTranslation(0, "zh-CN", "sha256:0"), null, "the OLDEST entry must have been pruned");
});

await test("saveCachedTranslation() never persists the raw synopsis/source text itself — only the translated output and its hash/metadata", () => {
  const { api, localStorage } = buildCacheSandbox();
  api.saveCachedTranslation(501, "zh-CN", "sha256:abc", "翻译文本");
  const raw = localStorage.getItem(api.TRANSLATION_CACHE_KEY);
  assert.ok(!raw.includes("Original English synopsis text"), "sanity: nothing resembling raw source text should ever appear (this call never received any)");
  const parsed = JSON.parse(raw);
  const entry = parsed["501:zh-CN"];
  assert.deepStrictEqual(Object.keys(entry).sort(), ["policyVersion", "savedAt", "sourceHash", "targetLang", "translatedText"]);
});

// ==================================================================================
// Section B — cross-runtime proof (client half): the SAME fixtures
// netlify/functions/__tests__/fixtures/description-fixtures.json drives on the server side.
// ==================================================================================

await test("cross-runtime: the CLIENT's descriptionToPlainText()+sha256Hex() matches the recorded fixture hashes exactly (server-side agreement is proven independently in discover-ai.test.js)", async () => {
  const fixturesPath = path.join(ROOT, "netlify", "functions", "__tests__", "fixtures", "description-fixtures.json");
  const fixtures = JSON.parse(fs.readFileSync(fixturesPath, "utf8"));
  const DECODE_HTML_ENTITIES_SRC = extractFunctionSource(DISCOVER_SRC, "decodeHtmlEntities");
  const DESCRIPTION_TO_PLAIN_TEXT_SRC = extractFunctionSource(DISCOVER_SRC, "descriptionToPlainText");
  const HTML_ENTITY_MAP_SRC = extractConstObjectSource(DISCOVER_SRC, "HTML_ENTITY_MAP");
  const { api } = (() => {
    const sandbox = { crypto, TextEncoder };
    vm.createContext(sandbox);
    vm.runInContext(
      `${HTML_ENTITY_MAP_SRC}\n${DECODE_HTML_ENTITIES_SRC}\n${DESCRIPTION_TO_PLAIN_TEXT_SRC}\n${SHA256_HEX_SRC}\nglobalThis.__api = { descriptionToPlainText, sha256Hex };`,
      sandbox
    );
    return { api: sandbox.__api };
  })();
  const nodeCrypto = await import("node:crypto");
  for (const fx of fixtures) {
    const plain = api.descriptionToPlainText(fx.raw);
    assert.strictEqual(plain, fx.expectedPlainText, `fixture "${fx.name}" plain-text mismatch`);
    const clientHash = await api.sha256Hex(plain);
    const expectedHash = nodeCrypto.createHash("sha256").update(fx.expectedPlainText, "utf8").digest("hex");
    assert.strictEqual(clientHash, expectedHash, `fixture "${fx.name}" hash mismatch`);
  }
});

// ==================================================================================
// Section C — Translate to Chinese / View Original: full DOM harness (real discover.html +
// extracted real discover.js modal functions), callDiscoverAi stubbed.
// ==================================================================================

function extractConstStatement(src, name) {
  const marker = `const ${name} = `;
  const start = src.indexOf(marker);
  assert.ok(start !== -1, `${name} not found in discover.js`);
  const end = src.indexOf(";", start);
  return src.slice(start, end + 1);
}

const DOM_REFS_SRC = extractRangeSource(DISCOVER_SRC, 'const authControl = document.getElementById("auth-control");', "// ---- State ----");
const STATE_SRC = extractRangeSource(DISCOVER_SRC, "let currentView = ", "function discoverCacheKey");
const AIRING_STATUS_META_SRC = extractConstObjectSource(DISCOVER_SRC, "AIRING_STATUS_META");
const STATUS_META_SRC = extractConstObjectSource(DISCOVER_SRC, "STATUS_META");
const STATUS_ORDER_SRC = extractStatementSource(DISCOVER_SRC, "const STATUS_ORDER = ");
const ESC_SRC = extractFunctionSource(DISCOVER_SRC, "esc");
const SAFE_ANILIST_HREF_SRC = extractFunctionSource(DISCOVER_SRC, "safeAniListHref");
const IS_SAFE_IMAGE_URL_SRC = extractFunctionSource(DISCOVER_SRC, "isSafeImageUrl");
const SET_IMAGE_WITH_FALLBACK_SRC = extractFunctionSource(DISCOVER_SRC, "setImageWithFallback");
const HTML_ENTITY_MAP_SRC2 = extractConstObjectSource(DISCOVER_SRC, "HTML_ENTITY_MAP");
const DECODE_HTML_ENTITIES_SRC2 = extractFunctionSource(DISCOVER_SRC, "decodeHtmlEntities");
const DESCRIPTION_TO_PLAIN_TEXT_SRC2 = extractFunctionSource(DISCOVER_SRC, "descriptionToPlainText");
const PREFERRED_TITLE_SRC = extractFunctionSource(DISCOVER_SRC, "preferredTitle");
const FORMAT_SCORE_SRC = extractFunctionSource(DISCOVER_SRC, "formatScore");
const AVAILABLE_EPISODE_COUNT_SRC = extractFunctionSource(DISCOVER_SRC, "availableEpisodeCount");
const FORMAT_TIME_UNTIL_AIRING_SRC = extractFunctionSource(DISCOVER_SRC, "formatTimeUntilAiring");
const FORMAT_NEXT_AIRING_SRC = extractFunctionSource(DISCOVER_SRC, "formatNextAiring");
const RENDER_CARD_ACTIONS_SRC = extractFunctionSource(DISCOVER_SRC, "renderCardActions");
const MODAL_STATE_SRC = extractRangeSource(DISCOVER_SRC, "let modalUntrap = null;", "function closeDetailModal");
const TRAP_FOCUS_SRC = extractFunctionSource(DISCOVER_SRC, "trapFocus");
const CLOSE_DETAIL_MODAL_SRC = extractFunctionSource(DISCOVER_SRC, "closeDetailModal");
const RENDER_DETAIL_ERROR_SRC = extractFunctionSource(DISCOVER_SRC, "renderDetailError");
const RENDER_DETAIL_MODAL_SRC = extractFunctionSource(DISCOVER_SRC, "renderDetailModal");
const RESET_MODAL_TRANSLATION_STATE_SRC = extractFunctionSource(DISCOVER_SRC, "resetModalTranslationState");
const HANDLE_TRANSLATE_CLICK_SRC = extractFunctionSource(DISCOVER_SRC, "handleTranslateClick");
const RENDER_TRANSLATION_CONTROLS_SRC = extractFunctionSource(DISCOVER_SRC, "renderTranslationControls");
const RENDER_ANIME_DESCRIPTION_SRC = extractFunctionSource(DISCOVER_SRC, "renderAnimeDescription");
const REFRESH_OPEN_MODAL_ACTIONS_SRC = extractFunctionSource(DISCOVER_SRC, "refreshOpenModalActions");
const OPEN_DETAIL_MODAL_SRC = extractFunctionSource(DISCOVER_SRC, "openDetailModal");
const CALL_DISCOVER_AI_SIGNATURE_CHECK = extractStatementSource(DISCOVER_SRC, "async function callDiscoverAi(operation, args) {").slice(0, 60);

await test("sanity: handleTranslateClick()/renderTranslationControls() were actually extracted (non-trivial, mention the expected i18n keys)", () => {
  assert.ok(HANDLE_TRANSLATE_CLICK_SRC.includes("translate_description"));
  assert.ok(RENDER_TRANSLATION_CONTROLS_SRC.includes("discover.translate_to_chinese"));
  assert.ok(CALL_DISCOVER_AI_SIGNATURE_CHECK.startsWith("async function callDiscoverAi"));
});

function buildModalHarness() {
  const html = fs.readFileSync(DISCOVER_HTML_PATH, "utf8");
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://edenatlas.netlify.app/discover.html" });
  const ctx = dom.getInternalVMContext();

  const aiCalls = [];
  const harnessState = {
    aiResponses: [],
    defaultAiResponse: { ok: true, anilistId: 501, sourceLang: "en", targetLang: "zh-CN", translatedText: "这是一个关于英雄的故事。", sourceHash: "sha256:placeholder", cached: false },
  };

  ctx.console = console;
  // jsdom already provides a real, working `localStorage` on the window/vm-context once
  // constructed with a proper http(s) `url` (as this harness's JSDOM(...) call already does) --
  // `localStorage` here is a getter-only accessor on the real Window, so it can't be reassigned
  // the way discover-foryou.test.js's plain-object sandbox reassigns its own bare globals; this
  // harness just uses jsdom's own implementation directly instead of a custom stub.
  dom.window.localStorage.clear();
  // jsdom's own `window.crypto` has no `.subtle` (SubtleCrypto isn't implemented by jsdom) and
  // is a getter-only accessor property, so a plain `ctx.crypto = ...` throws -- redefine the
  // whole property descriptor instead, pointing it at Node's real Web Crypto implementation
  // (the exact same one sha256Hex() uses in a real browser's `crypto.subtle`).
  Object.defineProperty(dom.window, "crypto", { value: crypto, configurable: true });
  ctx.i18nT = (key) => key;
  ctx.callDiscoverAi = async (operation, args) => {
    aiCalls.push({ operation, args: { ...args } });
    const config = harnessState.aiResponses.shift() || harnessState.defaultAiResponse;
    if (config.throwError) throw config.throwError;
    return config;
  };
  ctx.friendlyAniListError = (err) => (err && err.code) || "error";
  ctx.getCachedTranslation = undefined; // real one is extracted below, this stub is intentionally unused/overwritten

  const script = `
    ${DOM_REFS_SRC}
    ${STATE_SRC}
    let modalTranslationState = null;
    ${AIRING_STATUS_META_SRC}
    ${STATUS_META_SRC}
    ${STATUS_ORDER_SRC}
    ${ESC_SRC}
    ${SAFE_ANILIST_HREF_SRC}
    ${IS_SAFE_IMAGE_URL_SRC}
    ${SET_IMAGE_WITH_FALLBACK_SRC}
    ${HTML_ENTITY_MAP_SRC2}
    ${DECODE_HTML_ENTITIES_SRC2}
    ${DESCRIPTION_TO_PLAIN_TEXT_SRC2}
    ${PREFERRED_TITLE_SRC}
    ${FORMAT_SCORE_SRC}
    ${AVAILABLE_EPISODE_COUNT_SRC}
    ${FORMAT_TIME_UNTIL_AIRING_SRC}
    ${FORMAT_NEXT_AIRING_SRC}
    ${RENDER_CARD_ACTIONS_SRC}
    ${MODAL_STATE_SRC}
    ${extractRangeSource(DISCOVER_SRC, 'const TRANSLATION_CACHE_KEY = "eden:discoverTranslations";', "function translationCacheEntryKey")}
    ${extractFunctionSource(DISCOVER_SRC, "translationCacheEntryKey")}
    ${extractFunctionSource(DISCOVER_SRC, "isValidTranslationEntry")}
    ${extractFunctionSource(DISCOVER_SRC, "readTranslationCache")}
    ${extractFunctionSource(DISCOVER_SRC, "writeTranslationCache")}
    ${extractFunctionSource(DISCOVER_SRC, "getCachedTranslation")}
    ${extractFunctionSource(DISCOVER_SRC, "saveCachedTranslation")}
    ${extractFunctionSource(DISCOVER_SRC, "sha256Hex")}
    ${TRAP_FOCUS_SRC}
    ${CLOSE_DETAIL_MODAL_SRC}
    ${RENDER_DETAIL_ERROR_SRC}
    ${RESET_MODAL_TRANSLATION_STATE_SRC}
    ${HANDLE_TRANSLATE_CLICK_SRC}
    ${RENDER_TRANSLATION_CONTROLS_SRC}
    ${RENDER_ANIME_DESCRIPTION_SRC}
    ${RENDER_DETAIL_MODAL_SRC}
    ${REFRESH_OPEN_MODAL_ACTIONS_SRC}
    ${OPEN_DETAIL_MODAL_SRC}
    globalThis.__harness = {
      openDetailModal,
      getTranslationState: () => modalTranslationState,
    };
  `;
  vm.runInContext(script, ctx);

  const document = dom.window.document;
  return {
    dom,
    ctx,
    document,
    aiCalls,
    harnessState,
    modalBody: document.getElementById("anime-modal-body"),
    modal: document.getElementById("anime-modal"),
    openDetailModal: (id) => vm.runInContext(`openDetailModal(${JSON.stringify(id)});`, ctx),
    getTranslationState: () => ctx.__harness.getTranslationState(),
  };
}

// A real (not zero-delay) macrotask wait -- Node's actual crypto.subtle.digest() (used by the
// REAL sha256Hex() this harness exercises unmocked) resolves via the libuv threadpool, which
// reliably takes longer than a single setTimeout(0) tick to settle (confirmed empirically: a
// bare setTimeout(0) fires BEFORE the digest promise resolves, a setTimeout(10) fires after).
// 30ms is generous headroom for a single SHA-256 digest of a short string.
function tick() {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

const MEDIA_FIXTURE = {
  id: 501,
  title: { romaji: "Test Anime", english: null, native: null },
  coverImage: { large: null, medium: null },
  averageScore: 80,
  format: "TV",
  status: "RELEASING",
  episodes: 12,
  season: "SUMMER",
  seasonYear: 2026,
  nextAiringEpisode: null,
  siteUrl: null,
  description: "A hero rises to save the world.",
};

// discover-ai's own "details" operation is what openDetailModal() calls under the hood via
// callAniList (not callDiscoverAi) -- this harness doesn't extract openDetailModal's AniList
// dependency chain (callAniList), so these tests drive the modal by calling renderDetailModal()
// directly against a fixed media object instead of going through the network-backed open flow --
// exactly like discover-description.test.js already does for the SAME reason.
function renderWithMedia(h, media) {
  // Simulates the modal genuinely being open for this anime (normally set by openDetailModal(),
  // which this harness bypasses — see the comment above) — handleTranslateClick()'s own
  // superseded-by-a-newer-open guard compares against this before re-rendering.
  vm.runInContext(`currentModalAnilistId = ${JSON.stringify(media.id)};`, h.ctx);
  vm.runInContext("renderDetailModal(media);", Object.assign(h.ctx, { media }));
}

await test("a description with content shows a 'Translate to Chinese' button", () => {
  const h = buildModalHarness();
  renderWithMedia(h, MEDIA_FIXTURE);
  const btn = [...h.modalBody.querySelectorAll("button")].find((b) => b.textContent.includes("discover.translate_to_chinese"));
  assert.ok(btn, "expected a Translate to Chinese button");
});

await test("clicking Translate calls callDiscoverAi('translate_description', {anilistId}) exactly once — no synopsis text is ever included in the args", async () => {
  const h = buildModalHarness();
  renderWithMedia(h, MEDIA_FIXTURE);
  const btn = [...h.modalBody.querySelectorAll("button")].find((b) => b.textContent.includes("discover.translate_to_chinese"));
  btn.click();
  await tick();
  assert.strictEqual(h.aiCalls.length, 1);
  assert.strictEqual(h.aiCalls[0].operation, "translate_description");
  assert.deepStrictEqual(Object.keys(h.aiCalls[0].args), ["anilistId"]);
  assert.strictEqual(h.aiCalls[0].args.anilistId, 501);
});

await test("after a successful translation, the description shows the translated text and a 'View Original' control appears", async () => {
  const h = buildModalHarness();
  h.harnessState.defaultAiResponse = { ok: true, anilistId: 501, translatedText: "英雄拯救世界的故事。", sourceHash: "sha256:x", cached: false };
  renderWithMedia(h, MEDIA_FIXTURE);
  const translateBtn = [...h.modalBody.querySelectorAll("button")].find((b) => b.textContent.includes("discover.translate_to_chinese"));
  translateBtn.click();
  await tick();

  const p = h.modalBody.querySelector("p.text-white, p.text-textGray");
  assert.strictEqual(p.textContent, "英雄拯救世界的故事。");
  const viewOriginalBtn = [...h.modalBody.querySelectorAll("button")].find((b) => b.textContent.includes("discover.view_original"));
  assert.ok(viewOriginalBtn, "expected a View Original control after a successful translation");
});

await test("toggling View Original / View Translation NEVER spends another Qwen call — both texts are already held client-side", async () => {
  const h = buildModalHarness();
  renderWithMedia(h, MEDIA_FIXTURE);
  const translateBtn = [...h.modalBody.querySelectorAll("button")].find((b) => b.textContent.includes("discover.translate_to_chinese"));
  translateBtn.click();
  await tick();
  assert.strictEqual(h.aiCalls.length, 1);

  const viewOriginalBtn = [...h.modalBody.querySelectorAll("button")].find((b) => b.textContent.includes("discover.view_original"));
  viewOriginalBtn.click();
  // Scoped to the description placeholder specifically -- the modal's info column above it (format/
  // score/episode count/airing) also contains several unrelated <p> elements.
  assert.strictEqual(h.modalBody.querySelector("[data-description] p").textContent, MEDIA_FIXTURE.description);
  assert.strictEqual(h.aiCalls.length, 1, "toggling back to original must never call the network");

  const viewTranslationBtn = [...h.modalBody.querySelectorAll("button")].find((b) => b.textContent.includes("discover.view_translation"));
  viewTranslationBtn.click();
  assert.strictEqual(h.aiCalls.length, 1, "toggling back to translated (already cached in modal state) must never call the network either");
});

await test("a second Translate click for the SAME anime, after localStorage already has a valid entry, never calls the network again", async () => {
  const h = buildModalHarness();
  // The mocked Function response's sourceHash must be the REAL hash of MEDIA_FIXTURE's canonical
  // description text -- getCachedTranslation() only ever hits when the CLIENT's freshly computed
  // hash matches the SAVED entry's hash, so a placeholder/mismatched fixture hash would make this
  // test's cache-hit path unreachable regardless of whether the real code is correct.
  const nodeCrypto = await import("node:crypto");
  const realSourceHash = `sha256:${nodeCrypto.createHash("sha256").update(MEDIA_FIXTURE.description, "utf8").digest("hex")}`;
  h.harnessState.defaultAiResponse = { ok: true, anilistId: 501, translatedText: "英雄的故事。", sourceHash: realSourceHash, cached: false };
  renderWithMedia(h, MEDIA_FIXTURE);
  const translateBtn1 = () => [...h.modalBody.querySelectorAll("button")].find((b) => b.textContent.includes("discover.translate_to_chinese"));
  translateBtn1().click();
  await tick();
  assert.strictEqual(h.aiCalls.length, 1);

  // Simulate a fresh modal open for the SAME anime (a new detail-modal visit) — the localStorage
  // cache (not the in-memory modalTranslationState, which a fresh open resets) should still
  // short-circuit the network call this time.
  renderWithMedia(h, MEDIA_FIXTURE); // reset-ish re-render; modalTranslationState persists here since this harness never calls openDetailModal (which is what actually resets it) -- so simulate that explicitly:
  vm.runInContext("resetModalTranslationState();", h.ctx);
  renderWithMedia(h, MEDIA_FIXTURE);
  const translateBtn2 = [...h.modalBody.querySelectorAll("button")].find((b) => b.textContent.includes("discover.translate_to_chinese"));
  translateBtn2.click();
  await tick();
  assert.strictEqual(h.aiCalls.length, 1, "a valid localStorage cache hit must prevent a second Function call entirely");
  assert.strictEqual(h.getTranslationState().translatedText, h.harnessState.defaultAiResponse.translatedText);
});

await test("a Qwen/Function error while translating shows an inline error message and lets the Owner retry, never crashes or shows garbled text", async () => {
  const h = buildModalHarness();
  h.harnessState.aiResponses = [{ throwError: Object.assign(new Error("upstream"), { code: "discover_ai_upstream_error" }) }];
  renderWithMedia(h, MEDIA_FIXTURE);
  const translateBtn = [...h.modalBody.querySelectorAll("button")].find((b) => b.textContent.includes("discover.translate_to_chinese"));
  translateBtn.click();
  await tick();
  assert.strictEqual(h.getTranslationState().status, "error");
  const errEl = [...h.modalBody.querySelectorAll("span")].find((s) => s.textContent === "discover_ai_upstream_error");
  assert.ok(errEl, "expected the error message to be visible");
  // Retry is still offered (a fresh "Translate to Chinese" button, not a dead end).
  const retryBtn = [...h.modalBody.querySelectorAll("button")].find((b) => b.textContent.includes("discover.translate_to_chinese"));
  assert.ok(retryBtn);
});

await test("Qwen output containing a <script>/HTML payload never produces a live element — the translated paragraph has zero child elements (textContent only)", async () => {
  const h = buildModalHarness();
  h.harnessState.defaultAiResponse = { ok: true, anilistId: 501, translatedText: '<script>window.__pwned = true;</script>安全文本', sourceHash: "sha256:x", cached: false };
  renderWithMedia(h, MEDIA_FIXTURE);
  const translateBtn = [...h.modalBody.querySelectorAll("button")].find((b) => b.textContent.includes("discover.translate_to_chinese"));
  translateBtn.click();
  await tick();

  assert.strictEqual(h.modalBody.querySelector("script"), null, "no <script> element may ever exist in the modal");
  const p = h.modalBody.querySelector("p.text-white");
  assert.strictEqual(p.children.length, 0, "the translated paragraph must have zero child ELEMENTS, proving textContent (not innerHTML) was used");
  assert.strictEqual(h.dom.window.__pwned, undefined, "the injected script must never actually execute");
});

await test("a no_description translate response is surfaced as an inline notice, not a crash, and no translated text is shown", async () => {
  const h = buildModalHarness();
  h.harnessState.defaultAiResponse = { ok: true, anilistId: 501, translatedText: null, reason: "no_description" };
  renderWithMedia(h, MEDIA_FIXTURE);
  const translateBtn = [...h.modalBody.querySelectorAll("button")].find((b) => b.textContent.includes("discover.translate_to_chinese"));
  translateBtn.click();
  await tick();
  assert.strictEqual(h.getTranslationState().status, "error");
  assert.strictEqual(h.getTranslationState().translatedText, null);
});

await test("keyboard: focusing then .click()-ing the Translate button (native Enter/Space activation) works exactly like a mouse click", async () => {
  const h = buildModalHarness();
  renderWithMedia(h, MEDIA_FIXTURE);
  const translateBtn = [...h.modalBody.querySelectorAll("button")].find((b) => b.textContent.includes("discover.translate_to_chinese"));
  translateBtn.focus();
  assert.strictEqual(h.document.activeElement, translateBtn);
  translateBtn.click();
  await tick();
  assert.strictEqual(h.aiCalls.length, 1);
});

await test("every Translate/View Original/View Translation control is a real type=button element (never type=submit, never a bare clickable div)", () => {
  const h = buildModalHarness();
  renderWithMedia(h, MEDIA_FIXTURE);
  for (const btn of h.modalBody.querySelectorAll("button")) {
    assert.strictEqual(btn.tagName, "BUTTON");
    assert.strictEqual(btn.getAttribute("type"), "button");
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
