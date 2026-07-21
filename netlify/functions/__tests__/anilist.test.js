// Deterministic tests for the Owner-only AniList proxy Function — mocked Firebase Admin, a mocked
// fetchImpl for the upstream AniList call, no network access, no real Firestore, no real AniList
// endpoint. Run with: node netlify/functions/__tests__/anilist.test.js (or `npm run
// test:functions`). Exits non-zero on any failure. Mirrors assistant.test.js's/weather.test.js's
// own createHandler(deps) testing style.

const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");
const vm = require("node:vm");

const { createHandler } = require("../anilist.js");
const {
  OPERATIONS, AniListValidationError, currentSeason, sanitizeMediaListItem, sanitizeMediaDetail, isAniListSiteUrl,
  MAX_BATCH_IDS, MAX_SEARCH_LEN, EXCLUDED_GENRES, hasExcludedGenre, CONTENT_FILTER_POLICY_VERSION,
} = require("../lib/anilist-operations.js");
const { getCached, setCached, _resetCacheForTests } = require("../lib/anilist-cache.js");
const { FirebaseConfigError } = require("../lib/firebase-admin.js");
const { _resetBurstStateForTests } = require("../lib/rate-limit.js");

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

const PROD_ORIGIN = "https://edenatlas.netlify.app";
const OWNER_UID = "owner-uid-123";
const OWNER_EMAIL = "jjun8647@gmail.com";
const FRIEND_UID = "friend-uid-456";
const VIEWER_UID = "viewer-uid-789";

function baseEnv(overrides = {}) {
  return {
    FIREBASE_PROJECT_ID: "lfj-profolio",
    FIREBASE_SERVICE_ACCOUNT: '{"project_id":"lfj-profolio"}',
    ALLOWED_ORIGIN: PROD_ORIGIN,
    ...overrides,
  };
}

function baseEvent({ httpMethod = "POST", headers = {}, body } = {}) {
  return {
    httpMethod,
    headers: { origin: PROD_ORIGIN, authorization: "Bearer valid-token", ...headers },
    body: body === undefined ? JSON.stringify({ operation: "browse", args: { mode: "trending" } }) : body,
  };
}

function makeMediaFixture(overrides = {}) {
  return {
    id: 101,
    title: { romaji: "Test Anime", english: "Test Anime EN", native: "テストアニメ" },
    coverImage: { large: "https://s4.anilist.co/file/cover.jpg", medium: "https://s4.anilist.co/file/cover-m.jpg" },
    averageScore: 78,
    format: "TV",
    status: "RELEASING",
    episodes: null,
    season: "SUMMER",
    seasonYear: 2026,
    nextAiringEpisode: { airingAt: 1234567890, timeUntilAiring: 3600, episode: 5 },
    siteUrl: "https://anilist.co/anime/101",
    isAdult: false,
    ...overrides,
  };
}

function makeFakeFetch({ status = 200, data = null, malformedJson = false, throwAbort = false, throwNetwork = false } = {}) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
    if (throwAbort) {
      const err = new Error("simulated abort");
      err.name = "AbortError";
      throw err;
    }
    if (throwNetwork) throw new Error("simulated network failure");
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (malformedJson) throw new Error("not json");
        return { data };
      },
    };
  };
  impl.calls = calls;
  return impl;
}

function makeDeps(overrides = {}) {
  _resetBurstStateForTests();
  _resetCacheForTests();
  return {
    env: baseEnv(),
    now: () => new Date("2026-07-20T04:00:00Z"),
    ensureFirebaseAdmin: async () => {},
    verifyIdToken: async () => ({ uid: OWNER_UID, email: OWNER_EMAIL }),
    getUserDoc: async () => ({ role: "owner", email: OWNER_EMAIL }),
    checkBurst: () => ({ allowed: true }),
    getCached,
    setCached,
    fetchImpl: makeFakeFetch({ data: { Page: { media: [makeMediaFixture()] } } }),
    ...overrides,
  };
}

async function run() {
  // ---- Config / origin / method ----

  await test("missing required env vars fails closed with 500, before touching Firebase Admin", async () => {
    let ensureCalled = false;
    const deps = makeDeps({ env: baseEnv({ ALLOWED_ORIGIN: undefined }), ensureFirebaseAdmin: async () => { ensureCalled = true; } });
    const res = await createHandler(deps)(baseEvent());
    assert.strictEqual(res.statusCode, 500);
    assert.strictEqual(JSON.parse(res.body).error, "anilist_not_configured");
    assert.strictEqual(ensureCalled, false);
  });

  await test("a FirebaseConfigError from ensureFirebaseAdmin is a 500, never a 401, and verifyIdToken is never called", async () => {
    let verifyCalled = false;
    const deps = makeDeps({
      ensureFirebaseAdmin: async () => { throw new FirebaseConfigError("bad key", "admin_initialization", "config/invalid-private-key"); },
      verifyIdToken: async () => { verifyCalled = true; return { uid: OWNER_UID }; },
    });
    const res = await createHandler(deps)(baseEvent());
    assert.strictEqual(res.statusCode, 500);
    assert.strictEqual(verifyCalled, false);
  });

  await test("OPTIONS from an allowed origin returns 204 with CORS headers", async () => {
    const res = await createHandler(makeDeps())(baseEvent({ httpMethod: "OPTIONS" }));
    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(res.headers["Access-Control-Allow-Origin"], PROD_ORIGIN);
  });

  await test("OPTIONS from a disallowed origin returns 403", async () => {
    const res = await createHandler(makeDeps())(baseEvent({ httpMethod: "OPTIONS", headers: { origin: "https://evil.example" } }));
    assert.strictEqual(res.statusCode, 403);
  });

  // ---- Deploy Preview origin allowlist (production regression: 403 origin_not_allowed on a
  // Netlify Deploy Preview even though Owner login + Discover both worked). DEPLOY_PRIME_URL/
  // DEPLOY_URL are read here exactly the way production reads them: as RAW env values (in
  // production, sourced from the build-time snapshot lib/deploy-origin.js reads — see
  // buildProductionDeps() — never from process.env directly, since Netlify doesn't expose those
  // two at Function runtime). Every test below drives real values through env into
  // resolveAllowedOrigins()/normalizeExactOrigin(), not a mocked/bypassed version of that logic. ----

  const PREVIEW_PRIME_ORIGIN = "https://deploy-preview-12--edenatlas.netlify.app";
  const PREVIEW_BUILD_ORIGIN = "https://64f3a9c1b2d8e7f001a2b3c4--edenatlas.netlify.app";

  await test("the production edenatlas origin is still allowed with no DEPLOY_PRIME_URL/DEPLOY_URL set at all", async () => {
    const deps = makeDeps({ env: baseEnv({ DEPLOY_PRIME_URL: undefined, DEPLOY_URL: undefined }) });
    const res = await createHandler(deps)(baseEvent({ httpMethod: "OPTIONS" }));
    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(res.headers["Access-Control-Allow-Origin"], PROD_ORIGIN);
  });

  await test("an exact DEPLOY_PRIME_URL origin is allowed (POST reaches auth, not rejected at CORS)", async () => {
    const deps = makeDeps({ env: baseEnv({ DEPLOY_PRIME_URL: PREVIEW_PRIME_ORIGIN }) });
    const res = await createHandler(deps)(baseEvent({ headers: { origin: PREVIEW_PRIME_ORIGIN } }));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers["Access-Control-Allow-Origin"], PREVIEW_PRIME_ORIGIN);
    assert.strictEqual(res.headers.Vary, "Origin");
  });

  await test("OPTIONS from an exact DEPLOY_PRIME_URL origin returns 204 with that exact origin echoed back", async () => {
    const deps = makeDeps({ env: baseEnv({ DEPLOY_PRIME_URL: PREVIEW_PRIME_ORIGIN }) });
    const res = await createHandler(deps)(baseEvent({ httpMethod: "OPTIONS", headers: { origin: PREVIEW_PRIME_ORIGIN } }));
    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(res.headers["Access-Control-Allow-Origin"], PREVIEW_PRIME_ORIGIN);
    assert.strictEqual(res.headers["Access-Control-Allow-Methods"], "POST, OPTIONS");
    assert.strictEqual(res.headers.Vary, "Origin");
  });

  await test("an exact DEPLOY_URL origin is allowed independently of DEPLOY_PRIME_URL", async () => {
    const deps = makeDeps({ env: baseEnv({ DEPLOY_PRIME_URL: PREVIEW_PRIME_ORIGIN, DEPLOY_URL: PREVIEW_BUILD_ORIGIN }) });
    const res = await createHandler(deps)(baseEvent({ headers: { origin: PREVIEW_BUILD_ORIGIN } }));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers["Access-Control-Allow-Origin"], PREVIEW_BUILD_ORIGIN);
  });

  await test("DEPLOY_URL alone (no DEPLOY_PRIME_URL) is still allowed", async () => {
    const deps = makeDeps({ env: baseEnv({ DEPLOY_PRIME_URL: undefined, DEPLOY_URL: PREVIEW_BUILD_ORIGIN }) });
    const res = await createHandler(deps)(baseEvent({ headers: { origin: PREVIEW_BUILD_ORIGIN } }));
    assert.strictEqual(res.statusCode, 200);
  });

  await test("a DIFFERENT project's Deploy Preview origin is rejected — not a suffix/wildcard netlify.app match", async () => {
    const deps = makeDeps({ env: baseEnv({ DEPLOY_PRIME_URL: PREVIEW_PRIME_ORIGIN }) });
    const res = await createHandler(deps)(baseEvent({ headers: { origin: "https://deploy-preview-12--some-other-project.netlify.app" } }));
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(JSON.parse(res.body).error, "origin_not_allowed");
  });

  await test("a forged unrelated *.netlify.app origin is rejected even with a Deploy Preview configured", async () => {
    const deps = makeDeps({ env: baseEnv({ DEPLOY_PRIME_URL: PREVIEW_PRIME_ORIGIN, DEPLOY_URL: PREVIEW_BUILD_ORIGIN }) });
    const res = await createHandler(deps)(baseEvent({ headers: { origin: "https://totally-unrelated-site.netlify.app" } }));
    assert.strictEqual(res.statusCode, 403);
  });

  await test("a prefix-bypass attempt (extra text glued in front, no separator) is rejected", async () => {
    const deps = makeDeps({ env: baseEnv({ DEPLOY_PRIME_URL: PREVIEW_PRIME_ORIGIN }) });
    const res = await createHandler(deps)(baseEvent({ headers: { origin: "https://evildeploy-preview-12--edenatlas.netlify.app" } }));
    assert.strictEqual(res.statusCode, 403);
  });

  await test("a suffix-bypass attempt (allowed origin as a prefix of a longer attacker-controlled host) is rejected", async () => {
    const deps = makeDeps({ env: baseEnv({ DEPLOY_PRIME_URL: PREVIEW_PRIME_ORIGIN }) });
    const res = await createHandler(deps)(baseEvent({ headers: { origin: "https://deploy-preview-12--edenatlas.netlify.app.evil.com" } }));
    assert.strictEqual(res.statusCode, 403);
  });

  await test("a trailing-dot FQDN bypass attempt is rejected (exact string match, no DNS-style normalization)", async () => {
    const deps = makeDeps({ env: baseEnv({ DEPLOY_PRIME_URL: PREVIEW_PRIME_ORIGIN }) });
    const res = await createHandler(deps)(baseEvent({ headers: { origin: "https://deploy-preview-12--edenatlas.netlify.app." } }));
    assert.strictEqual(res.statusCode, 403);
  });

  await test("a userinfo-smuggling incoming Origin header is rejected — the raw header is never re-parsed/host-extracted, only exact-string-compared", async () => {
    // The actual attack surface for a userinfo trick is the INCOMING (attacker-controlled)
    // Origin header, not env.DEPLOY_PRIME_URL (a Netlify build-injected, trusted value — not
    // something an external caller can influence). A naive implementation that re-parsed the
    // incoming header and checked only its hostname could be fooled by
    // "https://attacker.example@edenatlas.netlify.app" (userinfo=attacker.example,
    // host=edenatlas.netlify.app) into treating it as the real edenatlas.netlify.app origin. This
    // Function never does that — it does a plain `Set.has(rawOriginHeaderString)` — so the exact
    // literal string below, which is not itself a member of the allowed set, must be rejected.
    const deps = makeDeps(); // PROD_ORIGIN allowed via default ALLOWED_ORIGIN
    const res = await createHandler(deps)(baseEvent({ httpMethod: "OPTIONS", headers: { origin: "https://attacker.example@edenatlas.netlify.app" } }));
    assert.strictEqual(res.statusCode, 403);
  });

  await test("a malformed DEPLOY_PRIME_URL/DEPLOY_URL is ignored, never crashes the handler", async () => {
    const deps = makeDeps({ env: baseEnv({ DEPLOY_PRIME_URL: "not a valid url", DEPLOY_URL: "also-not::valid" }) });
    const res = await createHandler(deps)(baseEvent({ httpMethod: "OPTIONS" }));
    assert.strictEqual(res.statusCode, 204); // production origin still works
    assert.strictEqual(res.headers["Access-Control-Allow-Origin"], PROD_ORIGIN);
    const rejected = await createHandler(deps)(baseEvent({ httpMethod: "OPTIONS", headers: { origin: "not a valid url" } }));
    assert.strictEqual(rejected.statusCode, 403);
  });

  await test("an empty-string DEPLOY_PRIME_URL/DEPLOY_URL is ignored, never crashes the handler", async () => {
    const deps = makeDeps({ env: baseEnv({ DEPLOY_PRIME_URL: "", DEPLOY_URL: "" }) });
    const res = await createHandler(deps)(baseEvent({ httpMethod: "OPTIONS" }));
    assert.strictEqual(res.statusCode, 204);
  });

  await test("localhost dev origins are unaffected by a Deploy Preview being configured", async () => {
    const deps = makeDeps({ env: baseEnv({ DEPLOY_PRIME_URL: PREVIEW_PRIME_ORIGIN }) });
    const res = await createHandler(deps)(baseEvent({ httpMethod: "OPTIONS", headers: { origin: "http://localhost:8888" } }));
    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(res.headers["Access-Control-Allow-Origin"], "http://localhost:8888");
  });

  await test("localhost dev origins still work with no Deploy Preview configured at all (unchanged baseline)", async () => {
    const deps = makeDeps({ env: baseEnv({ DEPLOY_PRIME_URL: undefined, DEPLOY_URL: undefined }) });
    const res = await createHandler(deps)(baseEvent({ httpMethod: "OPTIONS", headers: { origin: "http://127.0.0.1:3000" } }));
    assert.strictEqual(res.statusCode, 204);
  });

  await test("GET is rejected with 405 and an Allow header", async () => {
    const res = await createHandler(makeDeps())(baseEvent({ httpMethod: "GET" }));
    assert.strictEqual(res.statusCode, 405);
    assert.strictEqual(res.headers.Allow, "POST, OPTIONS");
  });

  await test("a disallowed origin on POST is rejected with 403 before auth is even checked", async () => {
    let verifyCalled = false;
    const deps = makeDeps({ verifyIdToken: async () => { verifyCalled = true; return { uid: OWNER_UID }; } });
    const res = await createHandler(deps)(baseEvent({ headers: { origin: "https://evil.example", authorization: "Bearer t" } }));
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(verifyCalled, false);
  });

  // ---- Auth + Owner-only authorization (the actual security boundary) ----

  await test("missing Authorization header is rejected with 401", async () => {
    const res = await createHandler(makeDeps())(baseEvent({ headers: { origin: PROD_ORIGIN, authorization: undefined } }));
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(JSON.parse(res.body).error, "missing_bearer_token");
  });

  await test("anonymous (no token at all, verifyIdToken never even reaches a real check) is rejected with 401", async () => {
    const deps = makeDeps({ verifyIdToken: async () => { const e = new Error("no token"); e.code = "auth/argument-error"; throw e; } });
    const res = await createHandler(deps)(baseEvent({ headers: { origin: PROD_ORIGIN, authorization: undefined } }));
    assert.strictEqual(res.statusCode, 401);
  });

  await test("a genuinely invalid/expired token is 401, never 500", async () => {
    const deps = makeDeps({ verifyIdToken: async () => { const e = new Error("bad token"); e.code = "auth/id-token-expired"; throw e; } });
    const res = await createHandler(deps)(baseEvent());
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(JSON.parse(res.body).error, "invalid_or_expired_token");
  });

  await test("a signed-in Friend (role=friend) is rejected with 403 owner_only, and never reaches the upstream fetch", async () => {
    const fetchImpl = makeFakeFetch({ data: { Page: { media: [] } } });
    const deps = makeDeps({
      verifyIdToken: async () => ({ uid: FRIEND_UID, email: "friend@example.com" }),
      getUserDoc: async () => ({ role: "friend", email: "friend@example.com" }),
      fetchImpl,
    });
    const res = await createHandler(deps)(baseEvent());
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(JSON.parse(res.body).error, "owner_only");
    assert.strictEqual(fetchImpl.calls.length, 0, "a Friend's request must never reach AniList");
  });

  await test("a signed-in Viewer (role=viewer, no whitelist doc shape) is rejected with 403 owner_only", async () => {
    const deps = makeDeps({
      verifyIdToken: async () => ({ uid: VIEWER_UID, email: "viewer@example.com" }),
      getUserDoc: async () => ({ role: "viewer", email: "viewer@example.com" }),
    });
    const res = await createHandler(deps)(baseEvent());
    assert.strictEqual(res.statusCode, 403);
  });

  await test("a users/{uid} doc with role=owner but a MISMATCHED email is still rejected — AND, not OR, across the two signals", async () => {
    const deps = makeDeps({
      verifyIdToken: async () => ({ uid: OWNER_UID, email: "attacker@example.com" }),
      getUserDoc: async () => ({ role: "owner", email: OWNER_EMAIL }),
    });
    const res = await createHandler(deps)(baseEvent());
    assert.strictEqual(res.statusCode, 403);
  });

  await test("a verified token with the Owner's own email but role!=owner on users/{uid} is still rejected", async () => {
    const deps = makeDeps({
      verifyIdToken: async () => ({ uid: OWNER_UID, email: OWNER_EMAIL }),
      getUserDoc: async () => ({ role: "friend", email: OWNER_EMAIL }),
    });
    const res = await createHandler(deps)(baseEvent());
    assert.strictEqual(res.statusCode, 403);
  });

  await test("a missing users/{uid} doc entirely is rejected, not treated as owner by default", async () => {
    const deps = makeDeps({ getUserDoc: async () => null });
    const res = await createHandler(deps)(baseEvent());
    assert.strictEqual(res.statusCode, 403);
  });

  await test("the real Owner (role=owner, matching email on both signals) is accepted", async () => {
    const res = await createHandler(makeDeps())(baseEvent());
    assert.strictEqual(res.statusCode, 200);
  });

  // ---- Operation allowlist ----

  await test("an unknown operation name is rejected with 400 unknown_operation, before args are ever inspected", async () => {
    const res = await createHandler(makeDeps())(baseEvent({ body: JSON.stringify({ operation: "deleteEverything", args: {} }) }));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(JSON.parse(res.body).error, "unknown_operation");
  });

  await test("a raw GraphQL document supplied by the client is never accepted — only the fixed operation/args shape", async () => {
    const fetchImpl = makeFakeFetch({ data: { Page: { media: [] } } });
    const deps = makeDeps({ fetchImpl });
    const res = await createHandler(deps)(
      baseEvent({ body: JSON.stringify({ operation: "browse", args: { mode: "trending" }, query: "mutation { DeleteAll }" }) })
    );
    // The extra top-level `query` field is itself rejected (unknown_field) -- proving there is no
    // code path that reads a client-supplied query string at all.
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(JSON.parse(res.body).error, "unknown_field");
    assert.strictEqual(fetchImpl.calls.length, 0);
  });

  await test("an unknown top-level field alongside a valid operation/args is rejected", async () => {
    const res = await createHandler(makeDeps())(baseEvent({ body: JSON.stringify({ operation: "browse", args: { mode: "trending" }, extra: 1 }) }));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(JSON.parse(res.body).error, "unknown_field");
  });

  await test("an unknown field inside args is rejected (per-operation rejectUnknownKeys)", async () => {
    const res = await createHandler(makeDeps())(baseEvent({ body: JSON.stringify({ operation: "browse", args: { mode: "trending", isAdult: true } }) }));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(JSON.parse(res.body).error, "unknown_field");
  });

  await test("invalid JSON body is rejected with 400", async () => {
    const res = await createHandler(makeDeps())(baseEvent({ body: "{not json" }));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(JSON.parse(res.body).error, "invalid_json");
  });

  await test("an oversized body is rejected with 400 before JSON parsing", async () => {
    const res = await createHandler(makeDeps())(baseEvent({ body: JSON.stringify({ operation: "search", args: { query: "x".repeat(3000) } }) }));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(JSON.parse(res.body).error, "request_too_large");
  });

  // ---- isAdult:false forced, unconditionally, for every operation ----

  await test("browse: a client-supplied isAdult is rejected as unknown_field, never merged into the request", async () => {
    const res = await createHandler(makeDeps())(baseEvent({ body: JSON.stringify({ operation: "browse", args: { mode: "this_season", isAdult: true } }) }));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(JSON.parse(res.body).error, "unknown_field");
  });

  for (const [name, args] of [
    ["browse", { mode: "trending" }],
    ["search", { query: "naruto" }],
    ["details", { id: 1 }],
    ["batch", { ids: [1, 2] }],
  ]) {
    await test(`${name}: the upstream variables object always sends isAdult:false`, async () => {
      const fetchImpl = makeFakeFetch({
        data: name === "details" ? { Media: makeMediaFixture({ id: 1 }) } : { Page: { media: [] } },
      });
      const deps = makeDeps({ fetchImpl });
      const res = await createHandler(deps)(baseEvent({ body: JSON.stringify({ operation: name, args }) }));
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(fetchImpl.calls.length, 1);
      assert.strictEqual(fetchImpl.calls[0].body.variables.isAdult, false);
      assert.ok(!("isAdult" in args), "sanity: the test's own input never set isAdult, proving it was force-added server-side");
    });
  }

  await test("an adult media item returned by (a buggy/compromised) upstream is dropped, never passed through to the client — list operations", async () => {
    const fetchImpl = makeFakeFetch({ data: { Page: { media: [makeMediaFixture({ id: 1, isAdult: false }), makeMediaFixture({ id: 2, isAdult: true })] } } });
    const deps = makeDeps({ fetchImpl });
    const res = await createHandler(deps)(baseEvent({ body: JSON.stringify({ operation: "browse", args: { mode: "trending" } }) }));
    const body = JSON.parse(res.body);
    assert.strictEqual(body.results.length, 1);
    assert.strictEqual(body.results[0].id, 1);
  });

  await test("an adult detail result cannot pass through — details returns { result: null }, not the adult item", async () => {
    const fetchImpl = makeFakeFetch({ data: { Media: makeMediaFixture({ id: 999, isAdult: true }) } });
    const deps = makeDeps({ fetchImpl });
    const res = await createHandler(deps)(baseEvent({ body: JSON.stringify({ operation: "details", args: { id: 999 } }) }));
    const body = JSON.parse(res.body);
    assert.strictEqual(body.result, null);
  });

  await test("a null/missing Media (AniList's own isAdult:false filter already excluded it) returns { result: null }, not a crash", async () => {
    const fetchImpl = makeFakeFetch({ data: { Media: null } });
    const deps = makeDeps({ fetchImpl });
    const res = await createHandler(deps)(baseEvent({ body: JSON.stringify({ operation: "details", args: { id: 999 } }) }));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(JSON.parse(res.body).result, null);
  });

  // ---- Excluded-genre content-filter policy: isAdult:false alone does not guarantee a
  // general-audience catalogue. See lib/anilist-operations.js's header comment for the live-
  // verified evidence (AniList id 178789 is isAdult:false and still carries the "Ecchi" genre). ----

  for (const [label, operation, args] of [
    ["browse (this_season)", "browse", { mode: "this_season" }],
    ["browse (trending)", "browse", { mode: "trending" }],
    ["search", "search", { query: "naruto" }],
    ["batch", "batch", { ids: [1, 2] }],
  ]) {
    await test(`${label}: the upstream variables object always sends genre_not_in via genreNotIn: EXCLUDED_GENRES`, async () => {
      const fetchImpl = makeFakeFetch({ data: { Page: { media: [] } } });
      const deps = makeDeps({ fetchImpl });
      const res = await createHandler(deps)(baseEvent({ body: JSON.stringify({ operation, args }) }));
      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(fetchImpl.calls[0].body.variables.genreNotIn, EXCLUDED_GENRES);
      assert.ok(fetchImpl.calls[0].body.query.includes("genre_not_in"), "the query text itself must reference genre_not_in");
    });
  }

  await test("details: the upstream variables object never includes genreNotIn -- query-level exclusion is deliberately not used for the singular Media lookup (see lib/anilist-operations.js's DETAILS_QUERY comment: AniList itself returns HTTP 404, not a clean empty result, for an excluded id at the query level)", async () => {
    const fetchImpl = makeFakeFetch({ data: { Media: makeMediaFixture({ id: 1, genres: ["Action"] }) } });
    const deps = makeDeps({ fetchImpl });
    const res = await createHandler(deps)(baseEvent({ body: JSON.stringify({ operation: "details", args: { id: 1 } }) }));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual("genreNotIn" in fetchImpl.calls[0].body.variables, false);
    assert.ok(!fetchImpl.calls[0].body.query.includes("genre_not_in"));
  });

  for (const [label, operation, args] of [
    ["browse (this_season)", "browse", { mode: "this_season" }],
    ["browse (trending)", "browse", { mode: "trending" }],
    ["search", "search", { query: "romance" }],
  ]) {
    await test(`${label}: an Ecchi-genre item (isAdult:false) is excluded from results server-side; an ordinary-genre item alongside it is unaffected`, async () => {
      const clean = makeMediaFixture({ id: 1, genres: ["Action", "Comedy"] });
      const excluded = makeMediaFixture({ id: 2, genres: ["Romance", "Ecchi"] });
      const fetchImpl = makeFakeFetch({ data: { Page: { media: [clean, excluded] } } });
      const deps = makeDeps({ fetchImpl });
      const res = await createHandler(deps)(baseEvent({ body: JSON.stringify({ operation, args }) }));
      const body = JSON.parse(res.body);
      assert.strictEqual(body.results.length, 1, "the Ecchi-tagged item must be excluded");
      assert.strictEqual(body.results[0].id, 1);
    });
  }

  await test("details: an item that is isAdult:false but carries the Ecchi genre is rejected -- { result: null }, the exact same controlled 'not found' shape as a genuinely missing id, never the record (or its description) itself", async () => {
    const fetchImpl = makeFakeFetch({
      data: { Media: makeMediaFixture({ id: 999, isAdult: false, genres: ["Drama", "Ecchi"], description: "a sensitive synopsis that must never leak" }) },
    });
    const deps = makeDeps({ fetchImpl });
    const res = await createHandler(deps)(baseEvent({ body: JSON.stringify({ operation: "details", args: { id: 999 } }) }));
    assert.strictEqual(res.statusCode, 200, "must be the ordinary not-found shape, never a 4xx/5xx error");
    const body = JSON.parse(res.body);
    assert.strictEqual(body.result, null);
    assert.ok(!JSON.stringify(body).includes("sensitive synopsis"), "the description must never leak, even on this rejection path");
  });

  await test("batch: an Ecchi-genre item among several requested ids is omitted from the response; the rest are returned normally", async () => {
    const items = [
      makeMediaFixture({ id: 1, genres: ["Action"] }),
      makeMediaFixture({ id: 2, genres: ["Ecchi", "Comedy"] }),
      makeMediaFixture({ id: 3, genres: ["Fantasy"] }),
    ];
    const fetchImpl = makeFakeFetch({ data: { Page: { media: items } } });
    const deps = makeDeps({ fetchImpl });
    const res = await createHandler(deps)(baseEvent({ body: JSON.stringify({ operation: "batch", args: { ids: [1, 2, 3] } }) }));
    const body = JSON.parse(res.body);
    assert.deepStrictEqual(body.results.map((r) => r.id).sort(), [1, 3]);
  });

  await test("hasExcludedGenre(): exact value only, case-insensitive, whitespace-trimmed -- never a substring match", () => {
    assert.strictEqual(hasExcludedGenre(["Ecchi"]), true);
    assert.strictEqual(hasExcludedGenre(["ECCHI"]), true);
    assert.strictEqual(hasExcludedGenre(["ecchi"]), true);
    assert.strictEqual(hasExcludedGenre(["  Ecchi  "]), true);
    assert.strictEqual(hasExcludedGenre(["EcChI"]), true);
    assert.strictEqual(hasExcludedGenre(["Action", "Comedy"]), false, "ordinary genres must never be caught");
    assert.strictEqual(hasExcludedGenre(["Ecchiness"]), false, "a genre that merely CONTAINS the excluded word must not match -- exact value only, never substring");
    assert.strictEqual(hasExcludedGenre(["Not Ecchi At All"]), false);
    assert.strictEqual(hasExcludedGenre([]), false);
    assert.strictEqual(hasExcludedGenre(undefined), false);
    assert.strictEqual(hasExcludedGenre(null), false);
    assert.strictEqual(hasExcludedGenre("Ecchi"), false, "a bare string (not an array) must never be treated as a genre list");
  });

  for (const variant of ["ECCHI", "ecchi", "  Ecchi  ", "EcChI"]) {
    await test(`browse: a case/whitespace variant of the excluded genre ("${variant}") is still caught by the server-side record-level check end-to-end`, async () => {
      const fetchImpl = makeFakeFetch({ data: { Page: { media: [makeMediaFixture({ id: 1, genres: [variant] })] } } });
      const deps = makeDeps({ fetchImpl });
      const res = await createHandler(deps)(baseEvent({ body: JSON.stringify({ operation: "browse", args: { mode: "trending" } }) }));
      assert.strictEqual(JSON.parse(res.body).results.length, 0);
    });
  }

  // ---- The client cannot override or disable the excluded-genre policy ----

  await test("browse: a client-supplied genreNotIn is rejected as unknown_field before it ever reaches AniList -- there is no code path for the client to override or empty the policy", async () => {
    const fetchImpl = makeFakeFetch({ data: { Page: { media: [] } } });
    const deps = makeDeps({ fetchImpl });
    const res = await createHandler(deps)(baseEvent({ body: JSON.stringify({ operation: "browse", args: { mode: "trending", genreNotIn: [] } }) }));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(JSON.parse(res.body).error, "unknown_field");
    assert.strictEqual(fetchImpl.calls.length, 0);
  });

  await test("search: client attempts to disable the policy via 'excludedGenres'/'genres'/'genre_not_in'/a null override are all rejected as unknown_field", async () => {
    for (const attempt of [{ excludedGenres: [] }, { genres: [] }, { genre_not_in: [] }, { genreNotIn: null }]) {
      const res = await createHandler(makeDeps())(baseEvent({ body: JSON.stringify({ operation: "search", args: { query: "naruto", ...attempt } }) }));
      assert.strictEqual(res.statusCode, 400, `expected the client-supplied override attempt ${JSON.stringify(attempt)} to be rejected`);
      assert.strictEqual(JSON.parse(res.body).error, "unknown_field");
    }
  });

  await test("batch: a client-supplied genreNotIn alongside valid ids is rejected outright, never silently merged or ignored", async () => {
    const fetchImpl = makeFakeFetch({ data: { Page: { media: [] } } });
    const deps = makeDeps({ fetchImpl });
    const res = await createHandler(deps)(baseEvent({ body: JSON.stringify({ operation: "batch", args: { ids: [1, 2], genreNotIn: ["nothing"] } }) }));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(fetchImpl.calls.length, 0, "a rejected request must never reach AniList at all");
  });

  // ---- Cached responses cannot bypass the policy ----

  await test("the cache key is namespaced with CONTENT_FILTER_POLICY_VERSION -- a stale entry cached under the bare pre-policy key shape is never served, and never leaks into a real response", async () => {
    const staleUnfilteredResults = {
      results: [{
        id: 2, title: { romaji: "Stale Unfiltered Ecchi Result", english: null, native: null },
        coverImage: { large: null, medium: null }, averageScore: null, format: null, status: null,
        episodes: null, season: null, seasonYear: null, nextAiringEpisode: null, siteUrl: null,
      }],
    };
    // Simulates exactly what a PRE-policy deploy would have cached: keyed by the bare operation
    // name (no CONTENT_FILTER_POLICY_VERSION suffix) with the OLD variables shape (no genreNotIn).
    const staleVariables = { page: 1, perPage: 20, isAdult: false };
    setCached("browse", staleVariables, staleUnfilteredResults, new Date("2026-07-20T04:00:00Z").getTime());

    const freshItems = [makeMediaFixture({ id: 1, genres: ["Action"] }), makeMediaFixture({ id: 2, genres: ["Ecchi"] })];
    const fetchImpl = makeFakeFetch({ data: { Page: { media: freshItems } } });
    const deps = makeDeps({ fetchImpl });
    const res = await createHandler(deps)(baseEvent({ body: JSON.stringify({ operation: "browse", args: { mode: "trending" } }) }));
    const body = JSON.parse(res.body);

    assert.strictEqual(fetchImpl.calls.length, 1, "the stale, differently-keyed cache entry must never be matched -- a real upstream call must still happen");
    assert.strictEqual(body.results.length, 1, "the fresh, correctly-filtered response must be returned, not the stale unfiltered one");
    assert.strictEqual(body.results[0].id, 1);
    assert.ok(!JSON.stringify(body).includes("Stale Unfiltered Ecchi Result"), "the stale cache entry's content must never leak into a real response");
  });

  await test("a response is only ever cached AFTER filtering -- the cached value itself never contains an excluded-genre item, retrievable directly via the real versioned cache key", async () => {
    const items = [makeMediaFixture({ id: 1, genres: ["Action"] }), makeMediaFixture({ id: 2, genres: ["Ecchi"] })];
    const fetchImpl = makeFakeFetch({ data: { Page: { media: items } } });
    const deps = makeDeps({ fetchImpl });
    await createHandler(deps)(baseEvent({ body: JSON.stringify({ operation: "browse", args: { mode: "trending" } }) }));

    const cachedValue = getCached(
      `browse:${CONTENT_FILTER_POLICY_VERSION}`,
      { page: 1, perPage: 20, isAdult: false, genreNotIn: EXCLUDED_GENRES },
      new Date("2026-07-20T04:00:00Z").getTime()
    );
    assert.ok(cachedValue, "expected a populated cache entry under the real versioned key");
    assert.strictEqual(cachedValue.results.length, 1);
    assert.strictEqual(cachedValue.results[0].id, 1);
  });

  // ---- Input validation and bounds ----

  await test("search: an empty/whitespace-only query is rejected", async () => {
    const res = await createHandler(makeDeps())(baseEvent({ body: JSON.stringify({ operation: "search", args: { query: "   " } }) }));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(JSON.parse(res.body).error, "query_required");
  });

  await test(`search: a query longer than ${MAX_SEARCH_LEN} chars is rejected`, async () => {
    const res = await createHandler(makeDeps())(baseEvent({ body: JSON.stringify({ operation: "search", args: { query: "a".repeat(MAX_SEARCH_LEN + 1) } }) }));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(JSON.parse(res.body).error, "query_too_long");
  });

  await test("browse: an invalid mode is rejected", async () => {
    const res = await createHandler(makeDeps())(baseEvent({ body: JSON.stringify({ operation: "browse", args: { mode: "everything" } }) }));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(JSON.parse(res.body).error, "invalid_mode");
  });

  await test("page/perPage: a non-integer is rejected", async () => {
    const res = await createHandler(makeDeps())(baseEvent({ body: JSON.stringify({ operation: "browse", args: { mode: "trending", perPage: 3.5 } }) }));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(JSON.parse(res.body).error, "invalid_integer");
  });

  await test("page/perPage: an out-of-range value is rejected (not silently clamped)", async () => {
    const res = await createHandler(makeDeps())(baseEvent({ body: JSON.stringify({ operation: "browse", args: { mode: "trending", perPage: 999 } }) }));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(JSON.parse(res.body).error, "integer_out_of_range");
  });

  await test("page/perPage: missing values fall back to sane defaults (1-based page, a bounded perPage), not undefined", async () => {
    const fetchImpl = makeFakeFetch({ data: { Page: { media: [] } } });
    const deps = makeDeps({ fetchImpl });
    await createHandler(deps)(baseEvent({ body: JSON.stringify({ operation: "browse", args: { mode: "trending" } }) }));
    assert.strictEqual(fetchImpl.calls[0].body.variables.page, 1);
    assert.ok(Number.isInteger(fetchImpl.calls[0].body.variables.perPage) && fetchImpl.calls[0].body.variables.perPage > 0);
  });

  await test("details: id=0, a negative id, and a non-integer id are all rejected", async () => {
    for (const id of [0, -5, 1.5, "1"]) {
      const res = await createHandler(makeDeps())(baseEvent({ body: JSON.stringify({ operation: "details", args: { id } }) }));
      assert.strictEqual(res.statusCode, 400, `expected 400 for id=${JSON.stringify(id)}`);
      assert.strictEqual(JSON.parse(res.body).error, "invalid_id");
    }
  });

  // ---- Batch: deduplication, max size, no N+1 ----

  await test("batch: duplicate ids are deduplicated before being sent upstream", async () => {
    const fetchImpl = makeFakeFetch({ data: { Page: { media: [] } } });
    const deps = makeDeps({ fetchImpl });
    await createHandler(deps)(baseEvent({ body: JSON.stringify({ operation: "batch", args: { ids: [1, 2, 2, 1, 3] } }) }));
    assert.deepStrictEqual(fetchImpl.calls[0].body.variables.ids, [1, 2, 3]);
  });

  await test(`batch: more than ${MAX_BATCH_IDS} unique ids is rejected with too_many_ids`, async () => {
    const ids = Array.from({ length: MAX_BATCH_IDS + 1 }, (_, i) => i + 1);
    const res = await createHandler(makeDeps())(baseEvent({ body: JSON.stringify({ operation: "batch", args: { ids } }) }));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(JSON.parse(res.body).error, "too_many_ids");
  });

  await test("batch: an empty ids array is rejected", async () => {
    const res = await createHandler(makeDeps())(baseEvent({ body: JSON.stringify({ operation: "batch", args: { ids: [] } }) }));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(JSON.parse(res.body).error, "ids_required");
  });

  await test("batch: any non-positive-integer id anywhere in the array rejects the whole request", async () => {
    const res = await createHandler(makeDeps())(baseEvent({ body: JSON.stringify({ operation: "batch", args: { ids: [1, 2, -3] } }) }));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(JSON.parse(res.body).error, "invalid_id");
  });

  await test("batch: a My-List-shaped request (many ids) issues exactly ONE upstream fetch call, never N — no N+1 behavior", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => i + 1);
    const fetchImpl = makeFakeFetch({ data: { Page: { media: ids.map((id) => makeMediaFixture({ id })) } } });
    const deps = makeDeps({ fetchImpl });
    const res = await createHandler(deps)(baseEvent({ body: JSON.stringify({ operation: "batch", args: { ids } }) }));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(fetchImpl.calls.length, 1, "batch must be a single id_in request, not one call per id");
    assert.strictEqual(JSON.parse(res.body).results.length, 12);
    assert.strictEqual(fetchImpl.calls[0].body.variables.perPage, 12);
  });

  // ---- Response field allowlist (never externalLinks/streamingEpisodes/characters/staff) ----

  await test("the GraphQL query text never mentions externalLinks/streamingEpisodes/characters/staff/tags for any operation", () => {
    for (const def of Object.values(OPERATIONS)) {
      const { query } = def.buildRequest(def.validate(def === OPERATIONS.details ? { id: 1 } : def === OPERATIONS.search ? { query: "x" } : def === OPERATIONS.batch ? { ids: [1] } : { mode: "trending" }), { now: new Date() });
      for (const forbidden of ["externalLinks", "streamingEpisodes", "characters", "staff", "tags"]) {
        assert.ok(!query.includes(forbidden), `query must not request "${forbidden}": ${query}`);
      }
    }
  });

  await test("the sanitized response never carries an isAdult field", async () => {
    const fetchImpl = makeFakeFetch({ data: { Page: { media: [makeMediaFixture()] } } });
    const deps = makeDeps({ fetchImpl });
    const res = await createHandler(deps)(baseEvent({ body: JSON.stringify({ operation: "browse", args: { mode: "trending" } }) }));
    const body = JSON.parse(res.body);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(body.results[0], "isAdult"), false);
  });

  // ---- Upstream error handling / sanitization ----

  await test("a provider timeout (AbortError) maps to 504 anilist_upstream_timeout", async () => {
    const deps = makeDeps({ fetchImpl: makeFakeFetch({ throwAbort: true }) });
    const res = await createHandler(deps)(baseEvent());
    assert.strictEqual(res.statusCode, 504);
    assert.strictEqual(JSON.parse(res.body).error, "anilist_upstream_timeout");
  });

  await test("a non-2xx upstream response maps to 502, never echoing the raw AniList error body", async () => {
    const deps = makeDeps({ fetchImpl: makeFakeFetch({ status: 400, data: null }) });
    const res = await createHandler(deps)(baseEvent());
    assert.strictEqual(res.statusCode, 502);
    assert.strictEqual(JSON.parse(res.body).error, "anilist_upstream_error");
  });

  await test("a malformed (non-JSON) upstream body maps to 502, not a crash", async () => {
    const deps = makeDeps({ fetchImpl: makeFakeFetch({ malformedJson: true }) });
    const res = await createHandler(deps)(baseEvent());
    assert.strictEqual(res.statusCode, 502);
  });

  await test("a network-level fetch failure maps to 502", async () => {
    const deps = makeDeps({ fetchImpl: makeFakeFetch({ throwNetwork: true }) });
    const res = await createHandler(deps)(baseEvent());
    assert.strictEqual(res.statusCode, 502);
  });

  await test("upstream error details are never logged verbatim", async () => {
    const originalError = console.error;
    const logged = [];
    console.error = (...args) => logged.push(args.join(" "));
    try {
      const deps = makeDeps({ fetchImpl: makeFakeFetch({ status: 500, data: null }) });
      await createHandler(deps)(baseEvent());
    } finally {
      console.error = originalError;
    }
    const combined = logged.join("\n");
    assert.ok(!combined.includes("500 Internal"), "raw upstream body/status text must not be logged verbatim");
  });

  // ---- Rate limiting ----

  await test("a burst-rejected request returns 429 with Retry-After and never calls AniList", async () => {
    const fetchImpl = makeFakeFetch({ data: { Page: { media: [] } } });
    const deps = makeDeps({ checkBurst: () => ({ allowed: false, retryAfterMs: 9000 }), fetchImpl });
    const res = await createHandler(deps)(baseEvent());
    assert.strictEqual(res.statusCode, 429);
    assert.strictEqual(res.headers["Retry-After"], "9");
    assert.strictEqual(fetchImpl.calls.length, 0);
  });

  await test("checkBurst is called with an 'anilist:'-prefixed key so it never shares assistant.js's/weather.js's per-uid burst budget", async () => {
    let receivedKey = null;
    const deps = makeDeps({ checkBurst: (key) => { receivedKey = key; return { allowed: true }; } });
    await createHandler(deps)(baseEvent());
    assert.strictEqual(receivedKey, `anilist:${OWNER_UID}`);
  });

  // ---- Short-lived bounded cache (never a persistent catalog store) ----

  await test("an identical operation+variables within the cache TTL is served from cache — the second call never hits AniList again", async () => {
    const fetchImpl = makeFakeFetch({ data: { Page: { media: [makeMediaFixture()] } } });
    const deps = makeDeps({ fetchImpl });
    const handler = createHandler(deps);
    const res1 = await handler(baseEvent({ body: JSON.stringify({ operation: "browse", args: { mode: "trending" } }) }));
    const res2 = await handler(baseEvent({ body: JSON.stringify({ operation: "browse", args: { mode: "trending" } }) }));
    assert.strictEqual(res1.statusCode, 200);
    assert.strictEqual(res2.statusCode, 200);
    assert.strictEqual(fetchImpl.calls.length, 1, "the second identical request must be served from the short-lived cache");
    assert.deepStrictEqual(JSON.parse(res1.body), JSON.parse(res2.body));
  });

  await test("a different operation/variables is never served from another entry's cache slot", async () => {
    const fetchImpl = makeFakeFetch({ data: { Page: { media: [makeMediaFixture({ id: 1 })] } } });
    const deps = makeDeps({ fetchImpl });
    const handler = createHandler(deps);
    await handler(baseEvent({ body: JSON.stringify({ operation: "browse", args: { mode: "trending" } }) }));
    await handler(baseEvent({ body: JSON.stringify({ operation: "browse", args: { mode: "this_season" } }) }));
    assert.strictEqual(fetchImpl.calls.length, 2);
  });

  // ---- Operations-module unit tests (pure, no HTTP wiring) ----

  await test("currentSeason() maps months to the correct MediaSeason quarter deterministically", () => {
    assert.deepStrictEqual(currentSeason(new Date("2026-01-15T00:00:00Z")), { season: "WINTER", seasonYear: 2026 });
    assert.deepStrictEqual(currentSeason(new Date("2026-04-01T00:00:00Z")), { season: "SPRING", seasonYear: 2026 });
    assert.deepStrictEqual(currentSeason(new Date("2026-07-20T00:00:00Z")), { season: "SUMMER", seasonYear: 2026 });
    assert.deepStrictEqual(currentSeason(new Date("2026-12-31T00:00:00Z")), { season: "FALL", seasonYear: 2026 });
  });

  await test("sanitizeMediaListItem drops an adult item and never spreads unexpected fields", () => {
    assert.strictEqual(sanitizeMediaListItem(makeMediaFixture({ isAdult: true })), null);
    assert.strictEqual(sanitizeMediaListItem(null), null);
    const clean = sanitizeMediaListItem(makeMediaFixture({ maliciousExtraField: "<script>alert(1)</script>" }));
    assert.strictEqual(Object.prototype.hasOwnProperty.call(clean, "maliciousExtraField"), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(clean, "isAdult"), false);
  });

  await test("sanitizeMediaDetail includes description/genres but sanitizeMediaListItem does not", () => {
    const media = makeMediaFixture({ description: "A story about...", genres: ["Action", "Comedy"] });
    const list = sanitizeMediaListItem(media);
    const detail = sanitizeMediaDetail(media);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(list, "description"), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(list, "genres"), false);
    assert.strictEqual(detail.description, "A story about...");
    assert.deepStrictEqual(detail.genres, ["Action", "Comedy"]);
  });

  await test("isAniListSiteUrl only accepts https://anilist.co (or a subdomain) — rejects javascript:/data:/off-site URLs", () => {
    assert.strictEqual(isAniListSiteUrl("https://anilist.co/anime/101"), true);
    assert.strictEqual(isAniListSiteUrl("https://staging.anilist.co/anime/101"), true);
    assert.strictEqual(isAniListSiteUrl("javascript:alert(1)"), false);
    assert.strictEqual(isAniListSiteUrl("data:text/html,<script>alert(1)</script>"), false);
    assert.strictEqual(isAniListSiteUrl("https://evil.example/anilist.co"), false);
    assert.strictEqual(isAniListSiteUrl("http://anilist.co/anime/101"), false, "plain http is rejected, only https");
    assert.strictEqual(isAniListSiteUrl(123), false);
    assert.strictEqual(isAniListSiteUrl(null), false);
  });

  await test("a siteUrl that fails isAniListSiteUrl is nulled out in the sanitized item, never passed through", () => {
    const clean = sanitizeMediaListItem(makeMediaFixture({ siteUrl: "javascript:alert(document.cookie)" }));
    assert.strictEqual(clean.siteUrl, null);
  });

  await test("OPERATIONS.details/search/browse/batch .validate() throw AniListValidationError instances with stable .code values", () => {
    assert.throws(() => OPERATIONS.details.validate({ id: -1 }), AniListValidationError);
    assert.throws(() => OPERATIONS.search.validate({ query: "" }), AniListValidationError);
    assert.throws(() => OPERATIONS.browse.validate({ mode: "bogus" }), AniListValidationError);
    assert.throws(() => OPERATIONS.batch.validate({ ids: "not-an-array" }), AniListValidationError);
  });

  // ---- Service worker: /.netlify/functions/anilist is never cached ----

  await test("service-worker.js: /.netlify/functions/anilist is never written to Cache Storage (same generic bypass as /assistant, /weather, /health)", async () => {
    const root = path.resolve(__dirname, "..", "..", "..");
    const src = fs.readFileSync(path.join(root, "service-worker.js"), "utf8");
    const cachePutCalls = [];
    const listeners = {};
    const sandbox = {
      self: { addEventListener: (name, fn) => { listeners[name] = fn; }, skipWaiting: () => {}, clients: { claim: async () => {} } },
      caches: {
        open: async () => ({ addAll: async () => {}, put: async (req) => { cachePutCalls.push(req.url || req); }, match: async () => undefined }),
        keys: async () => [],
        delete: async () => {},
      },
      fetch: async () => ({ clone: () => ({}) }),
      location: { origin: PROD_ORIGIN },
      URL,
      console,
    };
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { filename: "service-worker.js" });
    let responded = null;
    listeners.fetch({
      request: { url: `${PROD_ORIGIN}/.netlify/functions/anilist`, method: "POST" },
      respondWith: (p) => { responded = p; },
    });
    await responded;
    assert.strictEqual(cachePutCalls.length, 0);
  });

  await test("service-worker.js precaches discover.html/discover.js and its CACHE version is at least v33", async () => {
    const root = path.resolve(__dirname, "..", "..", "..");
    const src = fs.readFileSync(path.join(root, "service-worker.js"), "utf8");
    assert.ok(/"discover\.html"/.test(src));
    assert.ok(/"discover\.js"/.test(src));
    const match = /const CACHE = "eden-shell-v(\d+)"/.exec(src);
    assert.ok(match, "CACHE constant not found");
    assert.ok(Number(match[1]) >= 33, `expected CACHE version >= 33, got v${match[1]}`);
  });

  // ---- Summary ----
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    process.exitCode = 1;
  }
}

run();
