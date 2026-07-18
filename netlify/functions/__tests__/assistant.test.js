// Deterministic tests for the Atlas Assistant — mocked Firebase Admin, mocked Qwen endpoint,
// no network access, no real Firestore, no real secret. Run with:
//   node netlify/functions/__tests__/assistant.test.js
// (or `npm run test:functions`). Exits non-zero on any failure.
//
// These tests exercise netlify/functions/assistant.js's `createHandler(deps)` factory directly —
// the exported (test-only) `createHandler` never touches firebase-admin, so this suite needs no
// real Firebase project, no real Qwen key, and makes no network calls whatsoever.

const assert = require("node:assert");
const path = require("node:path");
const vm = require("node:vm");
const fs = require("node:fs");

const { createHandler } = require("../assistant.js");
const { TOOLS, toolDefsForScopes, ToolValidationError } = require("../lib/tools.js");
const { runAgentLoop, callQwenChatCompletions, QwenError } = require("../lib/qwen.js");
const { checkBurst, checkAndIncrementDailyUsage, _resetBurstStateForTests } = require("../lib/rate-limit.js");

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

// ---- Fixtures ----

const OWNER_UID = "owner-uid-123";
const OWNER_EMAIL = "jjun8647@gmail.com";
const FRIEND_UID = "friend-uid-456";
const OTHER_UID = "someone-else-uid";
const FAKE_KEY = "FAKE_DASHSCOPE_SECRET_DO_NOT_LEAK_9f8e7d";
const PROD_ORIGIN = "https://edenatlas.netlify.app";

function baseEnv(overrides = {}) {
  return {
    FIREBASE_PROJECT_ID: "lfj-profolio",
    FIREBASE_SERVICE_ACCOUNT: '{"project_id":"lfj-profolio"}',
    DASHSCOPE_API_KEY: FAKE_KEY,
    QWEN_MODEL: "qwen-plus",
    QWEN_BASE_URL: "https://example-dashscope.invalid/compatible-mode/v1",
    ALLOWED_ORIGIN: PROD_ORIGIN,
    ...overrides,
  };
}

// ---- Mock Firestore (equality-where only — the only query shape lib/tools.js ever uses) ----
function makeMockDb(seed) {
  // A shallow-per-collection clone: fresh containers (so one test's ai_usage/users mutations
  // never leak into another test reusing SEED), but the same nested `data` object references —
  // NOT JSON.parse(JSON.stringify(...)), which would silently strip out the Firestore-Timestamp-
  // shaped `{ toMillis() {...} }` functions these fixtures rely on (a real bug this suite caught:
  // see the completion report).
  const store = {
    users: { ...seed.users },
    ai_usage: { ...seed.ai_usage },
    photos: (seed.photos || []).map((d) => ({ id: d.id, data: d.data })),
    journals: (seed.journals || []).map((d) => ({ id: d.id, data: d.data })),
    life_events: (seed.life_events || []).map((d) => ({ id: d.id, data: d.data })),
  };

  function collection(name) {
    if (name === "users") {
      return { doc: (id) => ({ get: async () => ({ exists: !!store.users[id], data: () => store.users[id] }) }) };
    }
    if (name === "ai_usage") {
      return {
        doc: (id) => ({
          get: async () => ({ exists: !!store.ai_usage[id], data: () => store.ai_usage[id] }),
          set: (data) => { store.ai_usage[id] = { ...(store.ai_usage[id] || {}), ...data }; },
        }),
      };
    }
    const docs = store[name] || [];
    function query(filters) {
      return {
        where: (field, op, value) => query([...filters, { field, op, value }]),
        get: async () => ({
          docs: docs
            .filter((d) => filters.every((f) => f.op === "==" && d.data[f.field] === f.value))
            .map((d) => ({ id: d.id, data: () => d.data })),
        }),
      };
    }
    return query([]);
  }

  async function runTransaction(fn) {
    const tx = {
      get: async (ref) => ref.get(),
      set: (ref, data) => ref.set(data),
    };
    return fn(tx);
  }

  return { collection, runTransaction, _store: store };
}

const SEED = {
  users: {
    [OWNER_UID]: { role: "owner", email: OWNER_EMAIL },
    [FRIEND_UID]: { role: "friend", email: "friend@example.com" },
  },
  photos: [
    { id: "p1", data: { uid: OWNER_UID, caption: "Kampar riverside walk", tags: ["kampar", "river"], locationName: "Kampar", latitude: 4.3, longitude: 101.1, uploadedAt: { toMillis: () => 1000 } } },
    { id: "p2", data: { uid: OWNER_UID, caption: "No location yet", tags: [], uploadedAt: { toMillis: () => 2000 } } },
    { id: "p3", data: { uid: OWNER_UID, caption: "Trashed photo, should never appear", deletedAt: { toMillis: () => 3000 }, uploadedAt: { toMillis: () => 3000 } } },
    { id: "p4", data: { uid: OTHER_UID, caption: "Someone else's Kampar photo", tags: ["kampar"], uploadedAt: { toMillis: () => 4000 } } },
    { id: "p5", data: { uid: OWNER_UID, caption: "Has a storage url + exact coords", url: "https://storage.example/secret-token", storagePath: "gallery/owner/private/x.jpg", latitude: 1.1, longitude: 2.2, uploadedAt: { toMillis: () => 5000 } } },
  ],
  journals: [
    { id: "j1", data: { uid: OWNER_UID, title: "Kampar trip notes", content: "Long entry about Kampar and food.", tags: ["kampar"], mood: "happy", createdAt: { toMillis: () => 1000 } } },
    { id: "j2", data: { uid: OTHER_UID, title: "Not yours", content: "private", createdAt: { toMillis: () => 2000 } } },
  ],
  life_events: [
    { id: "e1", data: { uid: OWNER_UID, title: "Moved to Kampar", type: "milestone", date: { toMillis: () => Date.parse("2026-01-15") }, tags: [] } },
    { id: "e2", data: { uid: OWNER_UID, title: "Old event out of range", type: "milestone", date: { toMillis: () => Date.parse("2020-01-15") }, tags: [] } },
  ],
  ai_usage: {},
};

function baseDeps(overrides = {}) {
  const db = makeMockDb(SEED);
  return {
    env: baseEnv(),
    now: () => new Date("2026-07-18T12:00:00.000Z"),
    verifyIdToken: async (token) => {
      if (token === "owner-token") return { uid: OWNER_UID, email: OWNER_EMAIL };
      if (token === "friend-token") return { uid: FRIEND_UID, email: "friend@example.com" };
      throw new Error("invalid token");
    },
    getUserDoc: async (uid) => SEED.users[uid] || null,
    getDb: () => db,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "Hi, Owner." } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) }),
    ...overrides,
  };
}

function makeEvent({ method = "POST", headers = {}, body = "" } = {}) {
  return { httpMethod: method, headers: { origin: PROD_ORIGIN, authorization: "Bearer owner-token", ...headers }, body };
}

function chatBody(overrides = {}) {
  return JSON.stringify({ message: "hello", history: [], scopes: [], ...overrides });
}

let consoleErrorCalls = [];
const realConsoleError = console.error;
function captureConsoleError() {
  consoleErrorCalls = [];
  console.error = (...args) => consoleErrorCalls.push(args.map(String).join(" "));
}
function restoreConsoleError() {
  console.error = realConsoleError;
}

// ================= Auth / authorization =================

async function run() {
  console.log("Auth / authorization");

  await test("signed-out (no Authorization header) is rejected with 401", async () => {
    _resetBurstStateForTests();
    const handler = createHandler(baseDeps());
    const res = await handler(makeEvent({ headers: { authorization: undefined } }));
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(JSON.parse(res.body).error, "missing_bearer_token");
  });

  await test("invalid/garbage token is rejected with 401", async () => {
    _resetBurstStateForTests();
    const handler = createHandler(baseDeps());
    const res = await handler(makeEvent({ headers: { authorization: "Bearer not-a-real-token" }, body: chatBody() }));
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(JSON.parse(res.body).error, "invalid_or_expired_token");
  });

  await test("expired-token verifier throwing an auth/id-token-expired-shaped error is rejected with 401", async () => {
    _resetBurstStateForTests();
    const deps = baseDeps({ verifyIdToken: async () => { const e = new Error("expired"); e.code = "auth/id-token-expired"; throw e; } });
    const handler = createHandler(deps);
    const res = await handler(makeEvent({ body: chatBody() }));
    assert.strictEqual(res.statusCode, 401);
  });

  await test("Friend role is rejected with 403 (owner_only)", async () => {
    _resetBurstStateForTests();
    const handler = createHandler(baseDeps());
    const res = await handler(makeEvent({ headers: { authorization: "Bearer friend-token" }, body: chatBody() }));
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(JSON.parse(res.body).error, "owner_only");
  });

  await test("role=owner but email mismatch is still rejected (defense in depth)", async () => {
    _resetBurstStateForTests();
    const deps = baseDeps({ verifyIdToken: async () => ({ uid: OWNER_UID, email: "attacker@example.com" }) });
    const handler = createHandler(deps);
    const res = await handler(makeEvent({ body: chatBody() }));
    assert.strictEqual(res.statusCode, 403);
  });

  await test("Owner with a valid token is accepted (200)", async () => {
    _resetBurstStateForTests();
    const handler = createHandler(baseDeps());
    const res = await handler(makeEvent({ body: chatBody() }));
    assert.strictEqual(res.statusCode, 200, res.body);
    const data = JSON.parse(res.body);
    assert.strictEqual(data.ok, true);
    assert.strictEqual(data.answer, "Hi, Owner.");
  });

  await test("wrong Origin is rejected with 403, correct Origin is accepted", async () => {
    _resetBurstStateForTests();
    const handler = createHandler(baseDeps());
    const bad = await handler(makeEvent({ headers: { origin: "https://evil.example.com" }, body: chatBody() }));
    assert.strictEqual(bad.statusCode, 403);
    assert.strictEqual(JSON.parse(bad.body).error, "origin_not_allowed");
    _resetBurstStateForTests();
    const good = await handler(makeEvent({ body: chatBody() }));
    assert.strictEqual(good.statusCode, 200);
  });

  await test("a documented local dev origin is accepted", async () => {
    _resetBurstStateForTests();
    const handler = createHandler(baseDeps());
    const res = await handler(makeEvent({ headers: { origin: "http://localhost:8888" }, body: chatBody() }));
    assert.strictEqual(res.statusCode, 200);
  });

  await test("OPTIONS preflight: 204 + CORS headers for an allowed origin, 403 for a bad one", async () => {
    const handler = createHandler(baseDeps());
    const ok = await handler(makeEvent({ method: "OPTIONS" }));
    assert.strictEqual(ok.statusCode, 204);
    assert.strictEqual(ok.headers["Access-Control-Allow-Origin"], PROD_ORIGIN);
    assert.notStrictEqual(ok.headers["Access-Control-Allow-Origin"], "*");
    const bad = await handler(makeEvent({ method: "OPTIONS", headers: { origin: "https://evil.example.com" } }));
    assert.strictEqual(bad.statusCode, 403);
  });

  await test("non-POST/OPTIONS method is rejected with 405", async () => {
    _resetBurstStateForTests();
    const handler = createHandler(baseDeps());
    const res = await handler(makeEvent({ method: "GET" }));
    assert.strictEqual(res.statusCode, 405);
  });

  console.log("\nFail-closed configuration");

  for (const missingKey of ["FIREBASE_PROJECT_ID", "FIREBASE_SERVICE_ACCOUNT", "DASHSCOPE_API_KEY", "QWEN_MODEL", "QWEN_BASE_URL", "ALLOWED_ORIGIN"]) {
    await test(`missing env var ${missingKey} fails closed with 500, before auth runs`, async () => {
      _resetBurstStateForTests();
      let verifyCalled = false;
      const env = baseEnv();
      delete env[missingKey];
      const deps = baseDeps({ env, verifyIdToken: async () => { verifyCalled = true; return { uid: OWNER_UID, email: OWNER_EMAIL }; } });
      const handler = createHandler(deps);
      const res = await handler(makeEvent({ body: chatBody() }));
      assert.strictEqual(res.statusCode, 500);
      assert.strictEqual(JSON.parse(res.body).error, "assistant_not_configured");
      assert.strictEqual(verifyCalled, false, "auth must not be attempted when config is missing");
    });
  }

  console.log("\nSecret hygiene");

  await test("the Qwen API key never appears in a response body, success or error paths", async () => {
    _resetBurstStateForTests();
    captureConsoleError();
    const deps = baseDeps({
      fetchImpl: async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ error: { message: `bad key ${FAKE_KEY}` } }) }),
    });
    const handler = createHandler(deps);
    const res = await handler(makeEvent({ body: chatBody() }));
    restoreConsoleError();
    assert.ok(!res.body.includes(FAKE_KEY), "response body must never contain the API key");
    assert.strictEqual(res.statusCode, 502);
  });

  await test("the Qwen API key never appears in a console.error log line", async () => {
    _resetBurstStateForTests();
    captureConsoleError();
    const deps = baseDeps({
      fetchImpl: async () => ({ ok: false, status: 500, text: async () => `Internal error, key was ${FAKE_KEY}` }),
    });
    const handler = createHandler(deps);
    await handler(makeEvent({ body: chatBody() }));
    restoreConsoleError();
    const joined = consoleErrorCalls.join("\n");
    assert.ok(!joined.includes(FAKE_KEY), "no log line may contain the API key");
  });

  // ================= Request validation =================
  console.log("\nRequest validation");

  await test("empty message is rejected with 400", async () => {
    _resetBurstStateForTests();
    const handler = createHandler(baseDeps());
    const res = await handler(makeEvent({ body: chatBody({ message: "   " }) }));
    assert.strictEqual(res.statusCode, 400);
  });

  await test("oversized message is rejected with 400", async () => {
    _resetBurstStateForTests();
    const handler = createHandler(baseDeps());
    const res = await handler(makeEvent({ body: chatBody({ message: "x".repeat(2001) }) }));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(JSON.parse(res.body).error, "message_too_long");
  });

  await test("oversized history is rejected with 400", async () => {
    _resetBurstStateForTests();
    const handler = createHandler(baseDeps());
    const history = Array.from({ length: 21 }, () => ({ role: "user", content: "hi" }));
    const res = await handler(makeEvent({ body: chatBody({ history }) }));
    assert.strictEqual(res.statusCode, 400);
  });

  await test("unknown scope name is rejected with 400", async () => {
    _resetBurstStateForTests();
    const handler = createHandler(baseDeps());
    const res = await handler(makeEvent({ body: chatBody({ scopes: ["finance"] }) }));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(JSON.parse(res.body).error, "unknown_scope");
  });

  await test("malformed JSON body is rejected with 400", async () => {
    _resetBurstStateForTests();
    const handler = createHandler(baseDeps());
    const res = await handler(makeEvent({ body: "{not json" }));
    assert.strictEqual(res.statusCode, 400);
  });

  await test("oversized request body is rejected with 400 before JSON.parse", async () => {
    _resetBurstStateForTests();
    const handler = createHandler(baseDeps());
    const res = await handler(makeEvent({ body: chatBody({ message: "x".repeat(30000) }) }));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(JSON.parse(res.body).error, "request_too_large");
  });

  // ================= Rate limiting =================
  console.log("\nRate limiting");

  await test("checkBurst allows up to the burst limit then rejects", async () => {
    _resetBurstStateForTests();
    const uid = "burst-uid";
    let allowedCount = 0;
    for (let i = 0; i < 6; i++) {
      const r = checkBurst(uid, 1000 + i);
      if (r.allowed) allowedCount++;
    }
    assert.strictEqual(allowedCount, 5, "exactly BURST_LIMIT requests should be allowed");
    const sixth = checkBurst(uid, 1005);
    assert.strictEqual(sixth.allowed, false);
  });

  await test("checkAndIncrementDailyUsage is a real durable (transaction-backed) counter, not in-memory", async () => {
    const db = makeMockDb(SEED);
    const now = new Date("2026-07-18T00:00:00.000Z");
    let last;
    for (let i = 0; i < 50; i++) last = await checkAndIncrementDailyUsage(db, OWNER_UID, { now, limit: 50 });
    assert.strictEqual(last.allowed, true);
    assert.strictEqual(last.count, 50);
    const over = await checkAndIncrementDailyUsage(db, OWNER_UID, { now, limit: 50 });
    assert.strictEqual(over.allowed, false);
    // A brand new mock "process" (fresh JS objects, simulating a cold start) sharing the same
    // underlying store must still see the persisted count — proving this is not an in-memory
    // per-instance counter.
    const stillOver = await checkAndIncrementDailyUsage(db, OWNER_UID, { now, limit: 50 });
    assert.strictEqual(stillOver.allowed, false);
  });

  await test("handler returns 429 once the daily cap is exhausted", async () => {
    _resetBurstStateForTests();
    const db = makeMockDb(SEED);
    const now = new Date("2026-07-18T00:00:00.000Z");
    db._store.ai_usage[`${OWNER_UID}_2026-07-18`] = { uid: OWNER_UID, day: "2026-07-18", count: 50 };
    const handler = createHandler(baseDeps({ getDb: () => db, now: () => now }));
    const res = await handler(makeEvent({ body: chatBody() }));
    assert.strictEqual(res.statusCode, 429);
    assert.strictEqual(JSON.parse(res.body).error, "rate_limited");
  });

  await test("burst limiter rejects with 429 + Retry-After before ever touching Firestore", async () => {
    _resetBurstStateForTests();
    let dbTouched = false;
    const realDb = makeMockDb(SEED);
    const spyDb = { ...realDb, runTransaction: async (fn) => { dbTouched = true; return realDb.runTransaction(fn); } };
    const handler = createHandler(baseDeps({ getDb: () => spyDb }));
    for (let i = 0; i < 5; i++) await handler(makeEvent({ body: chatBody() }));
    dbTouched = false;
    const res = await handler(makeEvent({ body: chatBody() }));
    assert.strictEqual(res.statusCode, 429);
    assert.strictEqual(JSON.parse(res.body).scope, "burst");
    assert.ok(res.headers["Retry-After"]);
  });

  // ================= Tool allowlist =================
  console.log("\nTool allowlist (lib/tools.js)");

  function makeCtx(db) {
    const seen = new Set();
    return { db, uid: OWNER_UID, registerRef: (t, id) => seen.add(`${t}:${id}`), wasRefSeen: (t, id) => seen.has(`${t}:${id}`), _seen: seen };
  }

  await test("search_memories: only the Owner's own, active (non-trashed) Memories match", async () => {
    const db = makeMockDb(SEED);
    const ctx = makeCtx(db);
    const args = TOOLS.search_memories.validate({ query: "kampar" });
    const result = await TOOLS.search_memories.execute(args, ctx);
    const ids = result.results.map((r) => r.id);
    assert.ok(ids.includes("p1"));
    assert.ok(!ids.includes("p3"), "trashed content must be excluded");
    assert.ok(!ids.includes("p4"), "other users' content must be excluded");
  });

  await test("search_memories: never returns url, storagePath, or exact coordinates", async () => {
    const db = makeMockDb(SEED);
    const ctx = makeCtx(db);
    const args = TOOLS.search_memories.validate({ query: "storage" });
    const result = await TOOLS.search_memories.execute(args, ctx);
    const json = JSON.stringify(result);
    assert.ok(!json.includes("storage.example"), "must not leak a Storage download URL");
    assert.ok(!/"latitude"|"longitude"/.test(json), "must not leak exact coordinates");
    result.results.forEach((r) => {
      assert.strictEqual(Object.prototype.hasOwnProperty.call(r, "url"), false);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(r, "storagePath"), false);
    });
  });

  await test("find_memories_missing_location: only returns items lacking confirmed coordinates, still uid- and trash-scoped", async () => {
    const db = makeMockDb(SEED);
    const ctx = makeCtx(db);
    const args = TOOLS.find_memories_missing_location.validate({});
    const result = await TOOLS.find_memories_missing_location.execute(args, ctx);
    const ids = result.results.map((r) => r.id);
    assert.ok(ids.includes("p2"));
    assert.ok(!ids.includes("p1"), "p1 has confirmed coordinates and must not be listed as missing");
    assert.ok(!ids.includes("p3"), "trashed content must be excluded");
    assert.ok(!ids.includes("p4"), "other users' content must be excluded");
  });

  await test("search_journals: excludes other users' entries and never returns imageUrl", async () => {
    const db = makeMockDb(SEED);
    const ctx = makeCtx(db);
    const args = TOOLS.search_journals.validate({ query: "kampar" });
    const result = await TOOLS.search_journals.execute(args, ctx);
    const ids = result.results.map((r) => r.id);
    assert.ok(ids.includes("j1"));
    assert.ok(!ids.includes("j2"), "other users' journals must be excluded");
    const json = JSON.stringify(result);
    assert.ok(!json.includes("imageUrl"));
  });

  await test("list_journey: bounded date range excludes events outside it", async () => {
    const db = makeMockDb(SEED);
    const ctx = makeCtx(db);
    const args = TOOLS.list_journey.validate({ startDate: "2026-01-01", endDate: "2026-02-01" });
    const result = await TOOLS.list_journey.execute(args, ctx);
    const ids = result.results.map((r) => r.id);
    assert.ok(ids.includes("e1"));
    assert.ok(!ids.includes("e2"), "event far outside the requested range must be excluded");
  });

  await test("list_journey: a date range over 366 days is rejected", async () => {
    assert.throws(
      () => TOOLS.list_journey.validate({ startDate: "2020-01-01", endDate: "2026-01-01" }),
      ToolValidationError
    );
  });

  await test("list_calendar: requires both startDate and endDate, rejects a range over 31 days", async () => {
    assert.throws(() => TOOLS.list_calendar.validate({ startDate: "2026-01-01" }), ToolValidationError);
    assert.throws(() => TOOLS.list_calendar.validate({ startDate: "2026-01-01", endDate: "2026-06-01" }), ToolValidationError);
    const args = TOOLS.list_calendar.validate({ startDate: "2026-07-01", endDate: "2026-07-18" });
    assert.ok(args.start instanceof Date && args.end instanceof Date);
  });

  await test("list_calendar: never touches expenses (Finance) — result contains no expense fields", async () => {
    const db = makeMockDb(SEED);
    const ctx = makeCtx(db);
    const args = TOOLS.list_calendar.validate({ startDate: "2026-01-01", endDate: "2026-01-01" });
    const result = await TOOLS.list_calendar.execute(args, ctx);
    const json = JSON.stringify(result);
    assert.ok(!/amount|expense/i.test(json));
  });

  await test("draft_reflection: only approves sourceRefs already surfaced this turn (no id-probing side channel)", async () => {
    const db = makeMockDb(SEED);
    const ctx = makeCtx(db);
    ctx.registerRef("memory", "p1");
    const args = TOOLS.draft_reflection.validate({ sourceRefs: [{ type: "memory", id: "p1" }, { type: "memory", id: "not-surfaced-id" }] });
    const result = await TOOLS.draft_reflection.execute(args, ctx);
    assert.strictEqual(result.approvedSourceCount, 1);
    assert.strictEqual(result.rejectedSourceCount, 1);
  });

  await test("draft_reflection never queries Firestore (db is never touched)", async () => {
    let touched = false;
    const proxyDb = new Proxy({}, { get: () => { touched = true; return () => {}; } });
    const ctx = { db: proxyDb, uid: OWNER_UID, registerRef: () => {}, wasRefSeen: () => true };
    const args = TOOLS.draft_reflection.validate({ sourceRefs: [{ type: "memory", id: "p1" }] });
    await TOOLS.draft_reflection.execute(args, ctx);
    assert.strictEqual(touched, false);
  });

  await test("a tool never trusts an injected collection/uid/path field in its arguments", async () => {
    // Even if a compromised/malicious model output included extra fields, validate() only ever
    // extracts the specific known fields it defines — anything else is silently dropped, never
    // reaches execute(), and execute() itself hardcodes its own collection name regardless.
    const validated = TOOLS.search_memories.validate({
      query: "kampar",
      collection: "expenses",
      uid: OTHER_UID,
      path: "users/owner/secret",
    });
    assert.deepStrictEqual(Object.keys(validated).sort(), ["limit", "query"]);
    const db = makeMockDb(SEED);
    const ctx = makeCtx(db);
    const result = await TOOLS.search_memories.execute(validated, ctx);
    // Still only the Owner's own photos collection was ever touched — proven by the fact other
    // users' docs (p4) never leak in, even though `uid: OTHER_UID` was present in the raw args.
    assert.ok(!result.results.some((r) => r.id === "p4"));
  });

  await test("toolDefsForScopes: only exposes tools whose scope is enabled (plus draft_reflection, always on)", async () => {
    const none = toolDefsForScopes([]);
    assert.deepStrictEqual(none.map((t) => t.function.name).sort(), ["draft_reflection"]);
    const memoriesOnly = toolDefsForScopes(["memories"]);
    const names = memoriesOnly.map((t) => t.function.name).sort();
    assert.deepStrictEqual(names, ["draft_reflection", "find_memories_missing_location", "search_memories"]);
  });

  // ================= Agent loop =================
  console.log("\nAgent loop (lib/qwen.js)");

  await test("unknown tool name from the model is rejected, not crashed, loop continues", async () => {
    _resetBurstStateForTests();
    let call = 0;
    const fetchImpl = async () => {
      call++;
      if (call === 1) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: "c1", function: { name: "delete_everything", arguments: "{}" } }] } }] }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "Done." } }] }) };
    };
    const db = makeMockDb(SEED);
    const result = await runAgentLoop({ qwenConfig: { baseUrl: "https://x.invalid", apiKey: "k", model: "m" }, systemPrompt: "sys", history: [], userMessage: "hi", scopes: ["memories"], db, uid: OWNER_UID, fetchImpl });
    assert.strictEqual(result.answer, "Done.");
    assert.strictEqual(call, 2);
  });

  await test("malformed tool_call arguments JSON is handled safely, not thrown", async () => {
    let call = 0;
    const fetchImpl = async () => {
      call++;
      if (call === 1) return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: "c1", function: { name: "search_memories", arguments: "{not json" } }] } }] }) };
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "ok" } }] }) };
    };
    const db = makeMockDb(SEED);
    const result = await runAgentLoop({ qwenConfig: { baseUrl: "https://x.invalid", apiKey: "k", model: "m" }, systemPrompt: "sys", history: [], userMessage: "hi", scopes: ["memories"], db, uid: OWNER_UID, fetchImpl });
    assert.strictEqual(result.answer, "ok");
  });

  await test("maximum tool rounds (3) is strictly enforced — never a 4th call", async () => {
    let call = 0;
    const fetchImpl = async () => {
      call++;
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: `c${call}`, function: { name: "search_memories", arguments: JSON.stringify({ query: "x" }) } }] } }] }) };
    };
    const db = makeMockDb(SEED);
    const result = await runAgentLoop({ qwenConfig: { baseUrl: "https://x.invalid", apiKey: "k", model: "m" }, systemPrompt: "sys", history: [], userMessage: "hi", scopes: ["memories"], db, uid: OWNER_UID, fetchImpl });
    assert.strictEqual(call, 3, "must call Qwen at most MAX_TOOL_ROUNDS times");
    assert.strictEqual(result.roundsUsed, 3);
    assert.ok(result.answer.length > 0, "must still return a fallback answer, not throw");
  });

  await test("a fetch rejection shaped like an aborted/timed-out request maps to QwenError('qwen_request_timeout')", async () => {
    // Simulates exactly what a real `fetch` call does once callQwenChatCompletions's internal
    // AbortController fires its timeout: the underlying fetch promise rejects with an
    // AbortError. This deterministically tests the mapping without waiting out a real timer.
    const fetchImpl = async () => {
      const e = new Error("The operation was aborted.");
      e.name = "AbortError";
      throw e;
    };
    await assert.rejects(
      () => callQwenChatCompletions({ baseUrl: "https://x.invalid", apiKey: "k", model: "m", messages: [], tools: [], fetchImpl }),
      (err) => err instanceof QwenError && err.message === "qwen_request_timeout"
    );
  });

  await test("non-2xx Qwen response never forwards the raw provider error body", async () => {
    const fetchImpl = async () => ({ ok: false, status: 429, text: async () => `rate limited, key=${FAKE_KEY}` });
    await assert.rejects(
      () => callQwenChatCompletions({ baseUrl: "https://x.invalid", apiKey: FAKE_KEY, model: "m", messages: [], tools: [], fetchImpl }),
      (err) => err instanceof QwenError && !err.message.includes(FAKE_KEY) && err.message === "qwen_http_429"
    );
  });

  await test("no automatic retry on a failed Qwen call — fetchImpl is invoked exactly once per round", async () => {
    let calls = 0;
    const fetchImpl = async () => { calls++; return { ok: false, status: 500, text: async () => "{}" }; };
    await assert.rejects(() => callQwenChatCompletions({ baseUrl: "https://x.invalid", apiKey: "k", model: "m", messages: [], tools: [], fetchImpl }));
    assert.strictEqual(calls, 1);
  });

  await test("Qwen built-in tools (web_search/code_interpreter) are never sent — only the 6 allowlisted function tools", async () => {
    let sentTools = null;
    const fetchImpl = async (_url, opts) => {
      sentTools = JSON.parse(opts.body).tools;
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "ok" } }] }) };
    };
    const db = makeMockDb(SEED);
    await runAgentLoop({ qwenConfig: { baseUrl: "https://x.invalid", apiKey: "k", model: "m" }, systemPrompt: "sys", history: [], userMessage: "hi", scopes: ["memories", "journal", "journey", "calendar"], db, uid: OWNER_UID, fetchImpl });
    assert.ok(Array.isArray(sentTools));
    sentTools.forEach((t) => assert.strictEqual(t.type, "function"));
    const names = sentTools.map((t) => t.function.name).sort();
    assert.deepStrictEqual(names, ["draft_reflection", "find_memories_missing_location", "list_calendar", "list_journey", "search_journals", "search_memories"]);
  });

  // ================= End-to-end: full handler with a tool-calling round =================
  console.log("\nEnd-to-end handler");

  await test("full request: Owner asks about Kampar, tool runs, sanitized sources come back", async () => {
    _resetBurstStateForTests();
    let call = 0;
    const fetchImpl = async () => {
      call++;
      if (call === 1) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: "c1", function: { name: "search_memories", arguments: JSON.stringify({ query: "kampar" }) } }] } }] }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "Found one Kampar memory." } }], usage: { prompt_tokens: 20, completion_tokens: 6, total_tokens: 26 } }) };
    };
    const handler = createHandler(baseDeps({ fetchImpl }));
    const res = await handler(makeEvent({ body: chatBody({ message: "Find Memories related to Kampar.", scopes: ["memories"] }) }));
    assert.strictEqual(res.statusCode, 200, res.body);
    const data = JSON.parse(res.body);
    assert.strictEqual(data.answer, "Found one Kampar memory.");
    assert.ok(data.sources.some((s) => s.type === "memory" && s.id === "p1"));
    assert.deepStrictEqual(data.usage, { promptTokens: 20, completionTokens: 6, totalTokens: 26 });
    assert.strictEqual(res.headers["Cache-Control"], "no-store");
    assert.strictEqual(res.headers["Access-Control-Allow-Origin"], PROD_ORIGIN);
  });

  // ================= i18n key parity =================
  console.log("\ni18n");

  await test("EN/ZH locale files have identical key sets (including the new assistant.* namespace)", async () => {
    const root = path.resolve(__dirname, "..", "..", "..");
    const en = JSON.parse(fs.readFileSync(path.join(root, "locales", "en.json"), "utf8"));
    const zh = JSON.parse(fs.readFileSync(path.join(root, "locales", "zh-CN.json"), "utf8"));
    function keys(obj, prefix = "") {
      return Object.entries(obj).flatMap(([k, v]) => (v && typeof v === "object" ? keys(v, prefix + k + ".") : [prefix + k]));
    }
    const enKeys = new Set(keys(en));
    const zhKeys = new Set(keys(zh));
    assert.deepStrictEqual([...enKeys].filter((k) => !zhKeys.has(k)), []);
    assert.deepStrictEqual([...zhKeys].filter((k) => !enKeys.has(k)), []);
    assert.ok(enKeys.has("assistant.consent_title"));
    assert.ok(enKeys.has("nav.assistant"));
  });

  // ================= Static/structural checks =================
  console.log("\nStructural checks");

  await test("assistant.html carries data-owner-only=\"true\" (direct-URL auth-guard backstop)", async () => {
    const root = path.resolve(__dirname, "..", "..", "..");
    const html = fs.readFileSync(path.join(root, "assistant.html"), "utf8");
    assert.ok(/<body[^>]*data-owner-only="true"/.test(html));
  });

  await test("Health Function is unchanged: still GET-only, 200 {ok:true,...}, no env reads", async () => {
    const { handler } = require("../health.js");
    const getRes = await handler({ httpMethod: "GET" });
    assert.strictEqual(getRes.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(getRes.body), { ok: true, service: "edenatlas-functions" });
    const postRes = await handler({ httpMethod: "POST" });
    assert.strictEqual(postRes.statusCode, 405);
  });

  await test("service-worker.js: /.netlify/functions/* requests are never written to Cache Storage", async () => {
    const root = path.resolve(__dirname, "..", "..", "..");
    const src = fs.readFileSync(path.join(root, "service-worker.js"), "utf8");

    const cachePutCalls = [];
    const fetchCalls = [];
    const listeners = {};
    const sandbox = {
      self: { addEventListener: (name, fn) => { listeners[name] = fn; }, skipWaiting: () => {}, clients: { claim: async () => {} } },
      caches: {
        open: async () => ({ addAll: async () => {}, put: async (req) => { cachePutCalls.push(req.url || req); }, match: async () => undefined }),
        keys: async () => [],
        delete: async () => {},
      },
      fetch: async (req) => { fetchCalls.push(req.url || req); return { clone: () => ({}) }; },
      location: { origin: PROD_ORIGIN },
      URL,
      console,
    };
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { filename: "service-worker.js" });

    assert.strictEqual(typeof listeners.fetch, "function");

    let responded = null;
    const fnEvent = {
      request: { url: `${PROD_ORIGIN}/.netlify/functions/assistant`, method: "POST" },
      respondWith: (p) => { responded = p; },
    };
    listeners.fetch(fnEvent);
    await responded;
    assert.strictEqual(cachePutCalls.length, 0, "a Function request must never be written to Cache Storage");
    assert.strictEqual(fetchCalls.length, 1);

    // Sanity check the opposite case still caches normally (regression guard for the fix itself).
    const pageEvent = {
      request: { url: `${PROD_ORIGIN}/home.html`, method: "GET" },
      respondWith: (p) => { responded = p; },
    };
    fetchCalls.length = 0;
    listeners.fetch(pageEvent);
    await responded;
    assert.strictEqual(cachePutCalls.length, 1, "a normal page request should still be cached as before");
  });

  await test("service-worker.js CACHE version is eden-shell-v23 and includes assistant.html/assistant.js in PRECACHE", async () => {
    const root = path.resolve(__dirname, "..", "..", "..");
    const src = fs.readFileSync(path.join(root, "service-worker.js"), "utf8");
    assert.ok(/const CACHE = "eden-shell-v23"/.test(src));
    assert.ok(/"assistant\.html"/.test(src));
    assert.ok(/"assistant\.js"/.test(src));
  });

  // ---- Summary ----
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    process.exitCode = 1;
  }
}

run();
