// Behavioral + structural regression tests for the Discover (anime, Phase 1, Owner-only) feature.
//
// Covers: XSS payloads in AniList-sourced title/description/genres/image/link fields (extracted
// from the REAL discover.js source via the same extractFunctionSource()/vm-sandbox technique
// js/__tests__/xss-security.test.js already established — see that file's own header comment for
// why this is behavioral, not a source-regex check); a hand-translated JS simulation of the new
// `followed_anime` Firestore rule (same technique as the "Trash privacy + ownership-merge fix"
// pass documented in CLAUDE.md — NOT a live rules-engine run; this sandboxed environment has no
// Java runtime to run the real Firestore emulator, a pre-existing, already-documented limitation,
// not new to this pass); locale key parity for the new `discover.*`/`nav.discover` keys; and
// static-file invariants for Owner-only navigation placement, the auth-guard convention, the
// build allowlist, and service-worker precache/cache-version.
//
// Run with: node js/__tests__/discover-security.test.js

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

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

function extractFunctionSource(src, name) {
  const marker = `function ${name}(`;
  const start = src.indexOf(marker);
  assert.ok(start !== -1, `${name}() not found in source`);
  const braceStart = src.indexOf("{", start);
  let depth = 0;
  let i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  return src.slice(start, i);
}

function readSrc(file) {
  return fs.readFileSync(path.join(ROOT, file), "utf8");
}

const DISCOVER_SRC = readSrc("discover.js");
const DISCOVER_HTML = readSrc("discover.html");
const SIDEBAR_SRC = readSrc(path.join("js", "sidebar.js"));
const MOBILE_NAV_SRC = readSrc(path.join("js", "mobile-nav.js"));
const BUILD_SITE_SRC = readSrc(path.join("scripts", "build-site.js"));
const SW_SRC = readSrc("service-worker.js");
const FIRESTORE_RULES_SRC = readSrc("firestore.rules");

function loadFn(src, name) {
  const fnSrc = extractFunctionSource(src, name);
  // URL is needed by safeAniListHref()/isSafeImageUrl(); `location` is needed by
  // safeAniListHref()'s relative-URL base — a minimal stand-in, not a real browser.
  const sandbox = { URL, location: { href: "https://edenatlas.netlify.app/discover.html" } };
  vm.createContext(sandbox);
  vm.runInContext(`${fnSrc}\nglobalThis.__fn = ${name};`, sandbox);
  return sandbox.__fn;
}

// esc() depends on nothing else — load it standalone.
const esc = loadFn(DISCOVER_SRC, "esc");
// safeAniListHref() calls esc() internally, so both must be defined together in one sandbox.
function loadSafeAniListHref() {
  const escSrc = extractFunctionSource(DISCOVER_SRC, "esc");
  const fnSrc = extractFunctionSource(DISCOVER_SRC, "safeAniListHref");
  const sandbox = { URL, location: { href: "https://edenatlas.netlify.app/discover.html" } };
  vm.createContext(sandbox);
  vm.runInContext(`${escSrc}\n${fnSrc}\nglobalThis.__fn = safeAniListHref;`, sandbox);
  return sandbox.__fn;
}
const safeAniListHref = loadSafeAniListHref();
const isSafeImageUrl = loadFn(DISCOVER_SRC, "isSafeImageUrl");

// ==================================================================================
// Section A — esc() on AniList-sourced fields (title/description/genres)
// ==================================================================================

await test("esc() neutralizes a <script> tag in an AniList title/description: zero <script> substrings survive", () => {
  const escaped = esc("<script>alert(document.cookie)</script>");
  assert.ok(!escaped.includes("<script>"));
  assert.ok(escaped.includes("&lt;script&gt;"));
});

await test("esc() neutralizes an <img onerror> payload embedded in a description", () => {
  const escaped = esc('<img src=x onerror=alert(1)>');
  // esc() escapes &<>" only -- the literal word "onerror=" is expected to survive as inert text
  // (it's just letters), but every `<`/`>` must be escaped so the payload can never re-parse as
  // a real element: no live <img ...> tag, and no bare `<`/`>` character, can survive.
  assert.ok(!escaped.includes("<img"), "no live <img tag substring may survive escaping");
  assert.ok(!escaped.includes("<") && !escaped.includes(">"), "every angle bracket must be escaped");
});

await test("esc() escapes quotes so a genre string can't break out of an attribute context", () => {
  const escaped = esc('Action" onmouseover="alert(1)');
  assert.ok(!escaped.includes('"'));
  assert.strictEqual(escaped, "Action&quot; onmouseover=&quot;alert(1)");
});

await test("esc() handles null/undefined (a missing AniList title/description) without throwing", () => {
  assert.strictEqual(esc(undefined), "");
  assert.strictEqual(esc(null), "");
});

await test("discover.js's esc() matches the established per-file convention (journal.js's esc()), modulo line-ending style", () => {
  // Normalizes CRLF/LF before comparing -- this repo's tracked files are checked out with CRLF
  // (Windows core.autocrlf) while a freshly-authored file may be written with plain LF; the
  // point of this check is logical/behavioral identity of the implementation, not literal byte
  // identity across two different, otherwise-irrelevant line-ending conventions.
  const norm = (s) => s.replace(/\r\n/g, "\n");
  const journalEsc = extractFunctionSource(readSrc("journal.js"), "esc");
  const discoverEsc = extractFunctionSource(DISCOVER_SRC, "esc");
  assert.strictEqual(norm(discoverEsc), norm(journalEsc), "discover.js's esc() must match the established implementation exactly");
});

// ==================================================================================
// Section B — safeAniListHref() / isSafeImageUrl(): the only external link (AniList siteUrl) and
// image URLs must never accept javascript:/data: schemes or a non-AniList host.
// ==================================================================================

await test("safeAniListHref() accepts a real https://anilist.co URL", () => {
  const href = safeAniListHref("https://anilist.co/anime/101/Some-Title/");
  assert.ok(href.startsWith("https://anilist.co/"));
});

await test("safeAniListHref() rejects javascript: URLs", () => {
  assert.strictEqual(safeAniListHref("javascript:alert(document.cookie)"), "");
});

await test("safeAniListHref() rejects data: URLs", () => {
  assert.strictEqual(safeAniListHref("data:text/html,<script>alert(1)</script>"), "");
});

await test("safeAniListHref() rejects an off-site host even if it mentions anilist.co in the path", () => {
  assert.strictEqual(safeAniListHref("https://evil.example/redirect?to=anilist.co"), "");
});

await test("safeAniListHref() rejects a bare protocol-relative or malformed string", () => {
  assert.strictEqual(safeAniListHref(""), "");
  assert.strictEqual(safeAniListHref(null), "");
  assert.strictEqual(safeAniListHref(123), "");
});

await test("isSafeImageUrl() accepts https:// only", () => {
  assert.strictEqual(isSafeImageUrl("https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/x.jpg"), true);
  assert.strictEqual(isSafeImageUrl("http://s4.anilist.co/file/x.jpg"), false);
});

await test("isSafeImageUrl() rejects javascript:/data: URLs disguised as an image source", () => {
  assert.strictEqual(isSafeImageUrl("javascript:alert(1)"), false);
  assert.strictEqual(isSafeImageUrl("data:image/svg+xml,<svg onload=alert(1)>"), false);
});

await test("isSafeImageUrl() rejects a non-string/missing value without throwing", () => {
  assert.strictEqual(isSafeImageUrl(undefined), false);
  assert.strictEqual(isSafeImageUrl(null), false);
});

// ==================================================================================
// Section C — image src / description rendering must never use raw innerHTML interpolation for
// the src attribute itself (structural check: setImageWithFallback assigns the DOM property).
// ==================================================================================

await test("setImageWithFallback() assigns `.src` as a DOM property, never interpolates the URL into an innerHTML template string", () => {
  const fnSrc = extractFunctionSource(DISCOVER_SRC, "setImageWithFallback");
  assert.ok(/imgEl\.src\s*=\s*url/.test(fnSrc), "expected a direct DOM property assignment (imgEl.src = url)");
  assert.ok(!/innerHTML[^;]*\$\{url\}/.test(fnSrc), "the URL must never be interpolated into an innerHTML template");
});

await test("mediaCard()/renderDetailModal() never build an <img src=...> tag by string-interpolating a cover URL — the <img> is always the static template with no src, filled in later via setImageWithFallback()", () => {
  // The static template markup for the cover image must never contain a template-literal
  // interpolation inside a src="" attribute — every card image starts with no src and gets one
  // assigned as a DOM property only after passing isSafeImageUrl().
  assert.ok(!/<img[^>]*src="\$\{/.test(DISCOVER_SRC), "no <img src=\"${...}\"> pattern should exist anywhere in discover.js");
});

// ==================================================================================
// Section D — hand-translated Firestore rules simulation for `followed_anime`
// (NOT a live rules-engine run — see this file's header comment for why, and the "Trash privacy
// + ownership-merge fix" pass's identical documented limitation).
// ==================================================================================

const OWNER_EMAIL = "jjun8647@gmail.com";
const STATUS_ALLOWLIST = ["planning", "watching", "completed", "paused", "dropped"];
const ALLOWED_KEYS = ["uid", "anilistId", "mediaType", "title", "coverImage", "format", "status", "isAdult", "followedAt", "updatedAt"];
const REQUEST_TIME = Symbol("request.time"); // stand-in for Firestore's serverTimestamp()/request.time equality check

function isOwnerAuth(auth) {
  return !!auth && auth.email === OWNER_EMAIL;
}

function hasOnlyAllowedKeys(data, allowed) {
  return Object.keys(data).every((k) => allowed.includes(k));
}

function ruleRead(auth, resourceData) {
  return isOwnerAuth(auth) && !!resourceData && resourceData.uid === auth.uid;
}
const ruleDelete = ruleRead;

function ruleCreate(auth, docId, newData) {
  if (!isOwnerAuth(auth)) return false;
  if (newData.uid !== auth.uid) return false;
  if (docId !== `${auth.uid}_${newData.anilistId}`) return false;
  if (!hasOnlyAllowedKeys(newData, ALLOWED_KEYS)) return false;
  if (!(Number.isInteger(newData.anilistId) && newData.anilistId > 0)) return false;
  if (newData.mediaType !== "ANIME") return false;
  if (typeof newData.title !== "string") return false;
  if (!(newData.coverImage === null || typeof newData.coverImage === "string")) return false;
  if (!(newData.format === null || typeof newData.format === "string")) return false;
  if (!STATUS_ALLOWLIST.includes(newData.status)) return false;
  if (newData.isAdult !== false) return false;
  if (newData.followedAt !== REQUEST_TIME) return false;
  if (newData.updatedAt !== REQUEST_TIME) return false;
  return true;
}

function ruleUpdate(auth, resourceData, newData) {
  if (!isOwnerAuth(auth)) return false;
  if (!resourceData || resourceData.uid !== auth.uid) return false;
  if (newData.uid !== resourceData.uid) return false;
  if (newData.anilistId !== resourceData.anilistId) return false;
  if (newData.mediaType !== resourceData.mediaType) return false;
  if (!hasOnlyAllowedKeys(newData, ALLOWED_KEYS)) return false;
  if (typeof newData.title !== "string") return false;
  if (!(newData.coverImage === null || typeof newData.coverImage === "string")) return false;
  if (!(newData.format === null || typeof newData.format === "string")) return false;
  if (!STATUS_ALLOWLIST.includes(newData.status)) return false;
  if (newData.isAdult !== false) return false;
  if (newData.followedAt !== resourceData.followedAt) return false; // immutable / preserved
  if (newData.updatedAt !== REQUEST_TIME) return false; // must be freshly stamped every update
  return true;
}

const OWNER_AUTH = { uid: "owner-uid", email: OWNER_EMAIL };
const FRIEND_AUTH = { uid: "friend-uid", email: "friend@example.com" };

function validCreatePayload(overrides = {}) {
  return {
    uid: OWNER_AUTH.uid,
    anilistId: 101,
    mediaType: "ANIME",
    title: "Test Anime",
    coverImage: "https://s4.anilist.co/file/x.jpg",
    format: "TV",
    status: "planning",
    isAdult: false,
    followedAt: REQUEST_TIME,
    updatedAt: REQUEST_TIME,
    ...overrides,
  };
}

await test("firestore.rules literal text actually contains the followed_anime match block this simulation models", () => {
  assert.ok(FIRESTORE_RULES_SRC.includes("match /followed_anime/{id}"), "firestore.rules must declare the followed_anime collection");
  assert.ok(/anilistId\s+is\s+int/.test(FIRESTORE_RULES_SRC));
  assert.ok(FIRESTORE_RULES_SRC.includes("'planning', 'watching', 'completed', 'paused', 'dropped'"));
  assert.ok(FIRESTORE_RULES_SRC.includes("mediaType == 'ANIME'"));
  assert.ok(FIRESTORE_RULES_SRC.includes("isAdult == false"));
});

await test("rules: create — a fully valid Owner payload with the correct deterministic doc ID is allowed", () => {
  assert.strictEqual(ruleCreate(OWNER_AUTH, "owner-uid_101", validCreatePayload()), true);
});

await test("rules: create — Owner-only. A Friend (or any non-owner) can never create a followed_anime doc, even for their own uid", () => {
  const payload = validCreatePayload({ uid: FRIEND_AUTH.uid });
  assert.strictEqual(ruleCreate(FRIEND_AUTH, `${FRIEND_AUTH.uid}_101`, payload), false);
});

await test("rules: create — a signed-out caller (auth=null) is always rejected", () => {
  assert.strictEqual(ruleCreate(null, "owner-uid_101", validCreatePayload()), false);
});

await test("rules: create — the document ID must exactly equal `${uid}_${anilistId}` (deterministic ID)", () => {
  assert.strictEqual(ruleCreate(OWNER_AUTH, "owner-uid_999", validCreatePayload({ anilistId: 101 })), false);
  assert.strictEqual(ruleCreate(OWNER_AUTH, "some-other-uid_101", validCreatePayload()), false);
  assert.strictEqual(ruleCreate(OWNER_AUTH, "owner-uid_101", validCreatePayload()), true);
});

await test("rules: create — an out-of-allowlist status is rejected (score/notes-shaped extension is not a valid status either)", () => {
  for (const status of ["dropped_forever", "SCORE:9", "", null, undefined]) {
    assert.strictEqual(ruleCreate(OWNER_AUTH, "owner-uid_101", validCreatePayload({ status })), false, `status=${JSON.stringify(status)} must be rejected`);
  }
  for (const status of STATUS_ALLOWLIST) {
    assert.strictEqual(ruleCreate(OWNER_AUTH, "owner-uid_101", validCreatePayload({ status })), true, `status=${status} must be allowed`);
  }
});

await test("rules: create — isAdult must be exactly false; true or a truthy non-boolean is rejected", () => {
  assert.strictEqual(ruleCreate(OWNER_AUTH, "owner-uid_101", validCreatePayload({ isAdult: true })), false);
  assert.strictEqual(ruleCreate(OWNER_AUTH, "owner-uid_101", validCreatePayload({ isAdult: "false" })), false);
});

await test("rules: create — mediaType must be exactly 'ANIME' (Phase 1 has no other value)", () => {
  assert.strictEqual(ruleCreate(OWNER_AUTH, "owner-uid_101", validCreatePayload({ mediaType: "TV_DRAMA" })), false);
});

await test("rules: create — an extra/unlisted field (e.g. a Phase-1-excluded personal score or notes) is rejected outright", () => {
  assert.strictEqual(ruleCreate(OWNER_AUTH, "owner-uid_101", validCreatePayload({ score: 9 })), false);
  assert.strictEqual(ruleCreate(OWNER_AUTH, "owner-uid_101", validCreatePayload({ notes: "great show" })), false);
  assert.strictEqual(ruleCreate(OWNER_AUTH, "owner-uid_101", validCreatePayload({ description: "full AniList synopsis" })), false, "the rule must reject a client trying to persist description/genres too");
});

await test("rules: create — anilistId must be a positive integer", () => {
  for (const anilistId of [0, -1, 1.5, "101"]) {
    assert.strictEqual(ruleCreate(OWNER_AUTH, `owner-uid_${anilistId}`, validCreatePayload({ anilistId })), false);
  }
});

await test("rules: read/delete — Owner reading/deleting their own doc is allowed; a Friend or Viewer is always denied", () => {
  const resourceData = validCreatePayload();
  resourceData.followedAt = "2026-07-01T00:00:00Z";
  assert.strictEqual(ruleRead(OWNER_AUTH, resourceData), true);
  assert.strictEqual(ruleDelete(OWNER_AUTH, resourceData), true);
  assert.strictEqual(ruleRead(FRIEND_AUTH, resourceData), false);
  assert.strictEqual(ruleRead(null, resourceData), false);
});

await test("rules: update — a plain status change preserving followedAt and re-stamping updatedAt is allowed", () => {
  const resourceData = validCreatePayload({ followedAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-01T00:00:00Z" });
  const newData = { ...resourceData, status: "watching", updatedAt: REQUEST_TIME };
  assert.strictEqual(ruleUpdate(OWNER_AUTH, resourceData, newData), true);
});

await test("rules: update — uid/anilistId/mediaType are immutable", () => {
  const resourceData = validCreatePayload({ followedAt: "t0", updatedAt: "t0" });
  assert.strictEqual(ruleUpdate(OWNER_AUTH, resourceData, { ...resourceData, uid: "someone-else", updatedAt: REQUEST_TIME }), false);
  assert.strictEqual(ruleUpdate(OWNER_AUTH, resourceData, { ...resourceData, anilistId: 202, updatedAt: REQUEST_TIME }), false);
  assert.strictEqual(ruleUpdate(OWNER_AUTH, resourceData, { ...resourceData, mediaType: "TV_DRAMA", updatedAt: REQUEST_TIME }), false);
});

await test("rules: update — followedAt must be preserved exactly (cannot be changed, including to a fresh timestamp)", () => {
  const resourceData = validCreatePayload({ followedAt: "t0", updatedAt: "t0" });
  assert.strictEqual(ruleUpdate(OWNER_AUTH, resourceData, { ...resourceData, followedAt: "t1", updatedAt: REQUEST_TIME }), false);
  assert.strictEqual(ruleUpdate(OWNER_AUTH, resourceData, { ...resourceData, followedAt: REQUEST_TIME, updatedAt: REQUEST_TIME }), false);
});

await test("rules: update — updatedAt must always be freshly stamped (re-sending the old value is rejected)", () => {
  const resourceData = validCreatePayload({ followedAt: "t0", updatedAt: "t0" });
  assert.strictEqual(ruleUpdate(OWNER_AUTH, resourceData, { ...resourceData, status: "watching", updatedAt: "t0" }), false);
});

await test("rules: update — a Friend/Viewer, or the Owner acting on someone else's doc, is always denied", () => {
  const resourceData = validCreatePayload({ followedAt: "t0", updatedAt: "t0" });
  assert.strictEqual(ruleUpdate(FRIEND_AUTH, resourceData, { ...resourceData, status: "watching", updatedAt: REQUEST_TIME }), false);
  const someoneElsesDoc = validCreatePayload({ uid: "someone-else-uid", followedAt: "t0", updatedAt: "t0" });
  assert.strictEqual(ruleUpdate(OWNER_AUTH, someoneElsesDoc, { ...someoneElsesDoc, status: "watching", updatedAt: REQUEST_TIME }), false);
});

// ==================================================================================
// Section E — Owner-only enforcement at the navigation layer (structural, not behavioral: these
// assert on the real array literals/markup so a future accidental addition to a Light/Friend nav
// array is caught immediately).
// ==================================================================================

await test("discover.html carries data-owner-only=\"true\", the exact auth-guard convention every other Owner-only page uses", () => {
  assert.ok(/<body[^>]*data-owner-only="true"/.test(DISCOVER_HTML));
});

function arraySourceBetween(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  assert.ok(start !== -1, `"${startMarker}" not found`);
  const end = src.indexOf(endMarker, start);
  assert.ok(end !== -1, `"${endMarker}" not found after "${startMarker}"`);
  return src.slice(start, end);
}

await test("js/sidebar.js: PRIMARY_LINKS+SECONDARY_LINKS include discover.html; LIGHT_LINKS does not", () => {
  const ownerLinks = arraySourceBetween(SIDEBAR_SRC, "const PRIMARY_LINKS", "const here =");
  const lightLinks = arraySourceBetween(SIDEBAR_SRC, "const LIGHT_LINKS", "const here =");
  assert.ok(ownerLinks.includes('href: "discover.html"'), "discover.html must be reachable from the Owner sidebar");
  assert.ok(!lightLinks.includes('href: "discover.html"'), "discover.html must NEVER appear in the Friend/Viewer sidebar");
});

await test("js/mobile-nav.js: DRAWER_LINKS includes discover.html; LIGHT_DRAWER_LINKS and QUICK_ADD_ITEMS do not", () => {
  const drawerLinks = arraySourceBetween(MOBILE_NAV_SRC, "const DRAWER_LINKS", "const OWNER_ONLY_HREFS");
  const lightDrawerLinks = arraySourceBetween(MOBILE_NAV_SRC, "const LIGHT_DRAWER_LINKS", "const BOTTOM_ITEMS");
  const quickAddItems = arraySourceBetween(MOBILE_NAV_SRC, "const QUICK_ADD_ITEMS", "const here =");
  assert.ok(drawerLinks.includes('href: "discover.html"'), "discover.html must be reachable from the Owner drawer");
  assert.ok(!lightDrawerLinks.includes('href: "discover.html"'), "discover.html must NEVER appear in the Friend/Viewer drawer");
  assert.ok(!quickAddItems.includes("discover.html"), "Discover must not be a Quick Add shortcut in Phase 1");
});

await test("auth-guard.js's data-owner-only redirect target is home.html — discover.html relies on this existing, unmodified backstop", () => {
  const authGuardSrc = readSrc("auth-guard.js");
  assert.ok(/data-owner-only.*=.*"true"/.test(authGuardSrc) || authGuardSrc.includes('dataset.ownerOnly === "true"'));
  assert.ok(authGuardSrc.includes('"home.html?notice=private_space"'));
});

// ==================================================================================
// Section F — Build allowlist / service-worker precache / cache-version invariants
// ==================================================================================

await test("scripts/build-site.js's ALLOW_FILES includes discover.html and discover.js", () => {
  const allowFiles = arraySourceBetween(BUILD_SITE_SRC, "const ALLOW_FILES", "const ALLOW_DIRS");
  assert.ok(allowFiles.includes('"discover.html"'));
  assert.ok(allowFiles.includes('"discover.js"'));
});

await test("scripts/build-site.js's ALLOW_FILES never lists a netlify/ Function path (Function source stays structurally excluded from the deployed site)", () => {
  const allowFiles = arraySourceBetween(BUILD_SITE_SRC, "const ALLOW_FILES", "const ALLOW_DIRS");
  assert.ok(!allowFiles.includes("netlify/"));
  assert.ok(!allowFiles.includes("anilist.js") || !allowFiles.includes('"anilist.js"'), "the Function source file name itself must not be allowlisted for static publish");
});

await test("service-worker.js precaches discover.html/discover.js and CACHE is bumped to at least eden-shell-v33", () => {
  assert.ok(/"discover\.html"/.test(SW_SRC));
  assert.ok(/"discover\.js"/.test(SW_SRC));
  const match = /const CACHE = "eden-shell-v(\d+)"/.exec(SW_SRC);
  assert.ok(match);
  assert.ok(Number(match[1]) >= 33);
});

await test("service-worker.js's NEVER_CACHE_PATH_PREFIXES already covers /.netlify/functions/ generically — no per-Function entry was (or needs to be) added for /anilist", () => {
  assert.ok(SW_SRC.includes('NEVER_CACHE_PATH_PREFIXES = ["/.netlify/functions/"]'));
});

// ==================================================================================
// Section G — Locale key parity (discover.* namespace + nav.discover), both directions
// ==================================================================================

function flattenKeys(obj, prefix = "") {
  let keys = [];
  for (const [k, v] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) keys = keys.concat(flattenKeys(v, full));
    else keys.push(full);
  }
  return keys;
}

const EN = JSON.parse(readSrc(path.join("locales", "en.json")));
const ZH = JSON.parse(readSrc(path.join("locales", "zh-CN.json")));

await test("locales/en.json and locales/zh-CN.json have exactly the same discover.* + nav.discover keys (both directions)", () => {
  const enKeys = flattenKeys(EN).filter((k) => k === "nav.discover" || k.startsWith("discover."));
  const zhKeys = flattenKeys(ZH).filter((k) => k === "nav.discover" || k.startsWith("discover."));
  assert.ok(enKeys.length > 0, "expected at least one discover.* key in en.json");
  const missingInZh = enKeys.filter((k) => !zhKeys.includes(k));
  const missingInEn = zhKeys.filter((k) => !enKeys.includes(k));
  assert.deepStrictEqual(missingInZh, [], `keys present in en.json but missing in zh-CN.json: ${missingInZh.join(", ")}`);
  assert.deepStrictEqual(missingInEn, [], `keys present in zh-CN.json but missing in en.json: ${missingInEn.join(", ")}`);
});

await test("every discover.* value used by discover.html/discover.js as a data-i18n key or i18nT() call actually exists in en.json", () => {
  const dataI18nKeys = [...DISCOVER_HTML.matchAll(/data-i18n(?:-placeholder)?="([\w.]+)"/g)].map((m) => m[1]);
  const jsKeys = [...DISCOVER_SRC.matchAll(/i18nT\(\s*"([\w.]+)"/g)].map((m) => m[1]);
  const allUsed = [...new Set([...dataI18nKeys, ...jsKeys])];
  const enKeys = new Set(flattenKeys(EN));
  const missing = allUsed.filter((k) => !enKeys.has(k));
  assert.deepStrictEqual(missing, [], `i18n keys referenced by discover.html/discover.js but missing from en.json: ${missing.join(", ")}`);
});

// ---- Summary ----
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  process.exitCode = 1;
}
