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
const { OPERATIONS, AniListValidationError, currentSeason, sanitizeMediaListItem, sanitizeMediaDetail, isAniListSiteUrl, MAX_BATCH_IDS, MAX_SEARCH_LEN } = require("../lib/anilist-operations.js");
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
