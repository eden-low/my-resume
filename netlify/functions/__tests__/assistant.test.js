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
const crypto = require("node:crypto");

const { createHandler } = require("../assistant.js");
const { TOOLS, toolDefsForScopes, ToolValidationError } = require("../lib/tools.js");
const { runAgentLoop, callQwenChatCompletions, QwenError } = require("../lib/qwen.js");
const { checkBurst, checkAndIncrementDailyUsage, _resetBurstStateForTests } = require("../lib/rate-limit.js");
const { FirebaseConfigError, parseServiceAccount, initializeFirebaseAdmin } = require("../lib/firebase-admin.js");

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
    // Real production wiring calls getApp() here (see lib/firebase-admin.js); the mock default
    // simulates a healthy, already-initialized Admin app — tests that want to exercise a
    // json_parse/credential_validation/admin_initialization failure override this directly with
    // something that throws a FirebaseConfigError, exactly like initializeFirebaseAdmin() would.
    ensureFirebaseAdmin: async () => {},
    verifyIdToken: async (token) => {
      if (token === "owner-token") return { uid: OWNER_UID, email: OWNER_EMAIL };
      if (token === "friend-token") return { uid: FRIEND_UID, email: "friend@example.com" };
      const e = new Error("invalid token");
      e.code = "auth/argument-error";
      throw e;
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

  console.log("\nFirebase Admin initialization boundary (lib/firebase-admin.js)");

  // A REAL RSA private key, generated locally for this test run only (never a real credential,
  // never written anywhere, discarded when the process exits) — necessary because this suite
  // now validates PEM structure with Node's own `crypto.createPrivateKey()` (see
  // lib/firebase-admin.js's assertPrivateKeyIsUsable(), added after confirming against the real
  // firebase-admin package that its modular cert() does NOT eagerly validate a key, so a
  // placeholder string would no longer be a valid fixture for the "this should succeed" tests).
  const REAL_TEST_PRIVATE_KEY = crypto
    .generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" });

  const VALID_SA = {
    project_id: "lfj-profolio",
    client_email: "sa@lfj-profolio.iam.gserviceaccount.com",
    private_key: REAL_TEST_PRIVATE_KEY,
  };

  // A fake shaped exactly like firebase-admin v14's MODULAR API (getApps/getApp/initializeApp/
  // cert as plain functions — never a legacy `admin` namespace object with `.apps`/`.app()`/
  // `.credential.cert()`), matching initializeFirebaseAdmin()'s real parameter shape. This is
  // deliberately not the only coverage this suite has for the real package — see the "real
  // firebase-admin v14 package" section below, which is what actually catches an API-shape
  // incompatibility a fake can't (a fake will happily keep matching whatever shape you wrote it
  // to match, even after the real package's shape changes underneath it).
  function makeFakeModularAdmin({ failCert = false, failInit = false } = {}) {
    const apps = [];
    return {
      getApps: () => apps,
      getApp: () => apps[0],
      cert: (sa) => {
        if (failCert) throw new Error("fake OpenSSL error: error:0909006C:PEM routines");
        return { __cert: true, sa };
      },
      initializeApp: (opts) => {
        if (failInit) throw new Error("fake initializeApp failure");
        const app = { __app: true, opts };
        apps.push(app);
        return app;
      },
    };
  }

  await test("parseServiceAccount: a valid service-account object parses and initializes successfully", async () => {
    const fake = makeFakeModularAdmin();
    const app = initializeFirebaseAdmin({ ...fake, projectId: "lfj-profolio", serviceAccountRaw: JSON.stringify(VALID_SA) });
    assert.ok(app.__app);
    assert.strictEqual(fake.getApps().length, 1);
  });

  await test("parseServiceAccount: surrounding whitespace around the raw env var is trimmed", async () => {
    const raw = `\n  \t${JSON.stringify(VALID_SA)}\t  \n`;
    const parsed = parseServiceAccount(raw, "lfj-profolio");
    assert.strictEqual(parsed.project_id, "lfj-profolio");
  });

  await test("parseServiceAccount: a healthy, already-correctly-escaped private key is left unchanged", async () => {
    const parsed = parseServiceAccount(JSON.stringify(VALID_SA), "lfj-profolio");
    assert.strictEqual(parsed.private_key, VALID_SA.private_key);
  });

  await test("parseServiceAccount: a double-escaped private key (literal backslash-n text) is normalized to real newlines", async () => {
    // Simulates the real production failure mode: somewhere between the Firebase Console
    // download and the Netlify env var, each real `\n` JSON escape (2 chars) in the JSON TEXT
    // became `\\n` (3 chars) — so after one JSON.parse, the resulting string contains literal
    // backslash+n text instead of an actual newline byte. Built via JSON.stringify (not by
    // hand-counting backslashes in a string literal) so the test itself can't have an off-by-one
    // escaping bug.
    // Derived from the real test key by turning every real newline byte into literal "\n" text —
    // the exact inverse of what assertPrivateKeyIsUsable/normalizeLocation's replace() fixes.
    const doubleEscapedPrivateKey = VALID_SA.private_key.replace(/\n/g, "\\n");
    const rawJsonText = JSON.stringify({ ...VALID_SA, private_key: doubleEscapedPrivateKey });
    const parsed = parseServiceAccount(rawJsonText, "lfj-profolio");
    assert.strictEqual(parsed.private_key, VALID_SA.private_key, "should normalize back to real newlines");
    assert.ok(!parsed.private_key.includes("\\n"), "must contain no literal backslash-n text after normalization");
  });

  await test("parseServiceAccount: malformed JSON throws FirebaseConfigError(stage=json_parse)", async () => {
    assert.throws(
      () => parseServiceAccount("{not valid json", "lfj-profolio"),
      (err) => err instanceof FirebaseConfigError && err.stage === "json_parse" && err.code === "config/invalid-json"
    );
  });

  await test("parseServiceAccount: a missing required field throws FirebaseConfigError(stage=credential_validation)", async () => {
    const { private_key, ...missingKey } = VALID_SA;
    assert.throws(
      () => parseServiceAccount(JSON.stringify(missingKey), "lfj-profolio"),
      (err) => err instanceof FirebaseConfigError && err.stage === "credential_validation" && err.code === "config/missing-field"
    );
  });

  await test("parseServiceAccount: a project_id mismatch throws FirebaseConfigError(stage=credential_validation)", async () => {
    assert.throws(
      () => parseServiceAccount(JSON.stringify(VALID_SA), "some-other-project"),
      (err) => err instanceof FirebaseConfigError && err.stage === "credential_validation" && err.code === "config/project-mismatch"
    );
  });

  await test("initializeFirebaseAdmin: a present-but-garbage private_key is rejected by real, local PEM validation BEFORE cert() is ever called — the actual production root cause", async () => {
    // This is the scenario the real firebase-admin package does NOT catch on its own (verified
    // against the actual installed package, not assumed — see the header comment in
    // lib/firebase-admin.js): project_id/client_email/private_key are all present and are all
    // strings, so parseServiceAccount's shape checks pass, but the private_key text isn't a
    // real, usable PEM key (exactly what a mis-escaped or truncated key looks like). Uses a
    // "normal" fake admin (cert()/initializeApp() would happily accept anything) specifically to
    // prove the rejection comes from OUR local crypto check, not from the SDK.
    const fake = makeFakeModularAdmin();
    let certCalled = false;
    const cert = (sa) => { certCalled = true; return { __cert: true, sa }; };
    const garbageKeySA = { ...VALID_SA, private_key: "-----BEGIN PRIVATE KEY-----\nnot-real-key-material\n-----END PRIVATE KEY-----\n" };
    assert.throws(
      () => initializeFirebaseAdmin({ ...fake, cert, projectId: "lfj-profolio", serviceAccountRaw: JSON.stringify(garbageKeySA) }),
      (err) => err instanceof FirebaseConfigError && err.stage === "admin_initialization" && err.code === "config/invalid-private-key"
    );
    assert.strictEqual(certCalled, false, "must reject before ever reaching cert()");
  });

  await test("initializeFirebaseAdmin: a credential/private-key that fails cert() throws FirebaseConfigError(stage=admin_initialization), never leaking the raw SDK error", async () => {
    const fake = makeFakeModularAdmin({ failCert: true });
    assert.throws(
      () => initializeFirebaseAdmin({ ...fake, projectId: "lfj-profolio", serviceAccountRaw: JSON.stringify(VALID_SA) }),
      (err) => err instanceof FirebaseConfigError && err.stage === "admin_initialization" && err.code === "config/init-failed" && !err.message.includes("OpenSSL") && !err.message.includes("PEM")
    );
  });

  await test("initializeFirebaseAdmin: initializeApp() itself throwing is also classified as stage=admin_initialization", async () => {
    const fake = makeFakeModularAdmin({ failInit: true });
    assert.throws(
      () => initializeFirebaseAdmin({ ...fake, projectId: "lfj-profolio", serviceAccountRaw: JSON.stringify(VALID_SA) }),
      (err) => err instanceof FirebaseConfigError && err.stage === "admin_initialization"
    );
  });

  await test("initializeFirebaseAdmin: reuses the existing app on a warm instance, never re-validates", async () => {
    const fake = makeFakeModularAdmin();
    const first = initializeFirebaseAdmin({ ...fake, projectId: "lfj-profolio", serviceAccountRaw: JSON.stringify(VALID_SA) });
    // Second call passes garbage — if it were re-parsed/re-validated this would throw, but
    // getApps().length is already 1, so initializeFirebaseAdmin must short-circuit to getApp().
    const second = initializeFirebaseAdmin({ ...fake, projectId: "lfj-profolio", serviceAccountRaw: "{not json at all" });
    assert.strictEqual(first, second);
  });

  console.log("\nReal firebase-admin v14 package (production-wiring smoke test)");

  // This section is what actually caught the second production incident: every test above uses
  // `makeFakeModularAdmin()`, a hand-written fake that will happily keep matching whatever shape
  // we wrote it to match — including a shape the REAL installed package stopped supporting. The
  // first-generation test suite's fake had `.apps`/`.app()`/`.credential.cert()` (mirroring the
  // legacy namespace) and passed every assertion while the real firebase-admin ^14.2.0 package
  // installed by package.json had already silently dropped that entire shape. These tests load
  // and exercise the REAL package from node_modules — no fakes — so a future firebase-admin
  // upgrade that changes the modular API shape again would fail here, not just in production.

  await test("firebase-admin/app, firebase-admin/auth, firebase-admin/firestore modular entry points load from the real installed package and export the expected functions", async () => {
    const { initializeApp, cert, getApps, getApp } = require("firebase-admin/app");
    const { getAuth } = require("firebase-admin/auth");
    const { getFirestore } = require("firebase-admin/firestore");
    assert.strictEqual(typeof initializeApp, "function");
    assert.strictEqual(typeof cert, "function");
    assert.strictEqual(typeof getApps, "function");
    assert.strictEqual(typeof getApp, "function");
    assert.strictEqual(typeof getAuth, "function");
    assert.strictEqual(typeof getFirestore, "function");
  });

  await test("regression guard: the installed firebase-admin's legacy require(\"firebase-admin\").apps is undefined — documents exactly why the modular migration was necessary", async () => {
    const legacyAdmin = require("firebase-admin");
    assert.strictEqual(
      legacyAdmin.apps,
      undefined,
      "if this ever becomes an array again (e.g. a firebase-admin downgrade), re-review whether the modular-only rule in this file is still required"
    );
  });

  await test("initializeFirebaseAdmin against the REAL installed firebase-admin v14 package succeeds end-to-end (app -> auth -> firestore), no network call made, no legacy API touched", async () => {
    const { initializeApp, cert, getApps, getApp } = require("firebase-admin/app");
    const { getAuth } = require("firebase-admin/auth");
    const { getFirestore } = require("firebase-admin/firestore");

    const testServiceAccount = {
      project_id: "edenatlas-smoke-test",
      client_email: "smoke-test@edenatlas-smoke-test.iam.gserviceaccount.com",
      private_key: REAL_TEST_PRIVATE_KEY,
    };

    const app = initializeFirebaseAdmin({
      getApps,
      getApp,
      initializeApp,
      cert,
      projectId: "edenatlas-smoke-test",
      serviceAccountRaw: JSON.stringify(testServiceAccount),
    });

    assert.ok(app, "initializeFirebaseAdmin must return a real App instance from the real package");
    assert.strictEqual(getApps().length, 1, "exactly one real app must now be initialized");

    // Constructing Auth/Firestore instances is a local operation (no network call) — only an
    // actual verifyIdToken()/collection().get() call would reach the network, and this smoke
    // test deliberately stops short of that, matching this pass's "mocked/local tests only, no
    // live calls" convention. Reaching this point at all already proves the full modular chain
    // (initializeApp -> cert -> getAuth -> getFirestore) is wired correctly against the real,
    // currently-installed package — exactly the chain buildProductionDeps() uses in production.
    const auth = getAuth(app);
    const db = getFirestore(app);
    assert.strictEqual(typeof auth.verifyIdToken, "function");
    assert.strictEqual(typeof db.collection, "function");
  });

  await test("repository guard: zero legacy firebase-admin namespace calls remain in production Function code (comments excluded)", async () => {
    // Strips comments before scanning specifically so this file's OWN historical documentation
    // (which names the removed APIs on purpose, for future readers — see this file's and
    // lib/firebase-admin.js's header comments) can never itself trip the guard. This is a
    // durable, low-maintenance regression check: it scans every .js file under netlify/functions
    // (production Function source), not just the two files this pass touched, so a future file
    // that reintroduces `require("firebase-admin")` + legacy namespace calls fails here too.
    const root = path.resolve(__dirname, "..", "..", "..");
    const functionsDir = path.join(root, "netlify", "functions");

    function stripComments(src) {
      return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    }

    function collectJsFiles(dir) {
      let files = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "__tests__") continue; // test doubles are allowed any shape
          files = files.concat(collectJsFiles(full));
        } else if (entry.name.endsWith(".js")) {
          files.push(full);
        }
      }
      return files;
    }

    const LEGACY_PATTERNS = [
      { name: 'require("firebase-admin") (bare, legacy namespace import)', re: /require\(\s*["']firebase-admin["']\s*\)/ },
      { name: "admin.apps", re: /\badmin\.apps\b/ },
      { name: "admin.app(", re: /\badmin\.app\s*\(/ },
      { name: "admin.initializeApp(", re: /\badmin\.initializeApp\s*\(/ },
      { name: "admin.credential.cert(", re: /\badmin\.credential\.cert\s*\(/ },
      { name: "admin.auth(", re: /\badmin\.auth\s*\(/ },
      { name: "admin.firestore(", re: /\badmin\.firestore\s*\(/ },
    ];

    const violations = [];
    for (const file of collectJsFiles(functionsDir)) {
      const stripped = stripComments(fs.readFileSync(file, "utf8"));
      for (const pattern of LEGACY_PATTERNS) {
        if (pattern.re.test(stripped)) {
          violations.push(`${path.relative(root, file)}: ${pattern.name}`);
        }
      }
    }
    assert.deepStrictEqual(violations, [], `legacy firebase-admin namespace calls found in production code:\n${violations.join("\n")}`);
  });

  console.log("\nHandler-level classification: config/init failures are 500, never 401 — and never call Qwen");

  const CONFIG_FAILURE_STAGES = [
    ["json_parse", () => { throw new FirebaseConfigError("bad json", "json_parse", "config/invalid-json"); }],
    ["credential_validation", () => { throw new FirebaseConfigError("missing field", "credential_validation", "config/missing-field"); }],
    ["admin_initialization", () => { throw new FirebaseConfigError("init failed", "admin_initialization", "config/init-failed"); }],
  ];

  for (const [stageName, throwFn] of CONFIG_FAILURE_STAGES) {
    await test(`ensureFirebaseAdmin failing at stage=${stageName} returns 500 assistant_not_configured, not 401, and never calls verifyIdToken or Qwen`, async () => {
      _resetBurstStateForTests();
      let verifyCalled = false;
      let qwenCalled = false;
      const deps = baseDeps({
        ensureFirebaseAdmin: async () => throwFn(),
        verifyIdToken: async () => { verifyCalled = true; return { uid: OWNER_UID, email: OWNER_EMAIL }; },
        fetchImpl: async () => { qwenCalled = true; return { ok: true, status: 200, text: async () => "{}" }; },
      });
      const handler = createHandler(deps);
      const res = await handler(makeEvent({ body: chatBody() }));
      assert.strictEqual(res.statusCode, 500, res.body);
      assert.strictEqual(JSON.parse(res.body).error, "assistant_not_configured");
      assert.strictEqual(verifyCalled, false, "token verification must never run when Admin init failed");
      assert.strictEqual(qwenCalled, false, "Qwen must never be called when Admin init failed");
    });
  }

  await test("a genuine verifyIdToken rejection (Admin already initialized) is 401, not 500 — and never calls Qwen", async () => {
    _resetBurstStateForTests();
    let qwenCalled = false;
    const deps = baseDeps({
      ensureFirebaseAdmin: async () => {}, // init already succeeded
      verifyIdToken: async () => { const e = new Error("Firebase ID token has expired"); e.code = "auth/id-token-expired"; throw e; },
      fetchImpl: async () => { qwenCalled = true; return { ok: true, status: 200, text: async () => "{}" }; },
    });
    const handler = createHandler(deps);
    const res = await handler(makeEvent({ body: chatBody() }));
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(JSON.parse(res.body).error, "invalid_or_expired_token");
    assert.strictEqual(qwenCalled, false);
  });

  await test("if verifyIdToken somehow still throws a FirebaseConfigError directly, it's classified as 500, not 401 (defense in depth)", async () => {
    _resetBurstStateForTests();
    const deps = baseDeps({
      ensureFirebaseAdmin: async () => {},
      verifyIdToken: async () => { throw new FirebaseConfigError("late failure", "admin_initialization", "config/init-failed"); },
    });
    const handler = createHandler(deps);
    const res = await handler(makeEvent({ body: chatBody() }));
    assert.strictEqual(res.statusCode, 500);
    assert.strictEqual(JSON.parse(res.body).error, "assistant_not_configured");
  });

  await test("Owner authorization (403 owner_only) is unaffected by the auth-boundary refactor", async () => {
    _resetBurstStateForTests();
    const deps = baseDeps({ ensureFirebaseAdmin: async () => {} });
    const handler = createHandler(deps);
    const res = await handler(makeEvent({ headers: { authorization: "Bearer friend-token" }, body: chatBody() }));
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(JSON.parse(res.body).error, "owner_only");
  });

  await test("safe stage logging reveals only stage + a sanitized code — never the JSON, key, email, token, or raw SDK message", async () => {
    _resetBurstStateForTests();
    captureConsoleError();
    const deps = baseDeps({
      ensureFirebaseAdmin: async () => {
        throw new FirebaseConfigError("firebase-admin failed to initialize from the provided credential", "admin_initialization", "config/init-failed");
      },
    });
    const handler = createHandler(deps);
    await handler(makeEvent({ body: chatBody() }));
    restoreConsoleError();
    const joined = consoleErrorCalls.join("\n");
    assert.ok(joined.includes("stage=admin_initialization"));
    assert.ok(joined.includes("code=config/init-failed"));
    assert.ok(!joined.includes(FAKE_KEY));
    assert.ok(!joined.includes(OWNER_EMAIL));
    assert.ok(!/BEGIN PRIVATE KEY/.test(joined));
    assert.ok(!/"project_id"/.test(joined), "must never log the raw service-account JSON");
  });

  await test("a token-verification failure with no err.code logs code=no_code, not undefined", async () => {
    _resetBurstStateForTests();
    captureConsoleError();
    const deps = baseDeps({
      ensureFirebaseAdmin: async () => {},
      verifyIdToken: async () => { throw new Error("some low-level failure with no .code"); },
    });
    const handler = createHandler(deps);
    await handler(makeEvent({ body: chatBody() }));
    restoreConsoleError();
    const joined = consoleErrorCalls.join("\n");
    assert.ok(joined.includes("stage=token_verification"));
    assert.ok(joined.includes("code=no_code"));
    assert.ok(!joined.includes("undefined"), "must never print the literal word 'undefined' the way the original bug did");
  });

  console.log("\nFrontend retry-once-on-401 policy (mirrors assistant.js's withOneRetryOn401)");

  // Duplicated verbatim from assistant.js's withOneRetryOn401 (documented there as intentionally
  // duplicated, per this repo's own per-file convention) so the exact retry policy — one retry,
  // forced refresh, never a loop — is unit-testable without a browser/DOM/Firebase environment.
  async function withOneRetryOn401(attempt) {
    let res = await attempt(false);
    if (res.status === 401) {
      res = await attempt(true);
    }
    return res;
  }

  await test("withOneRetryOn401: a first-try success never retries", async () => {
    let calls = 0;
    const res = await withOneRetryOn401(async () => { calls++; return { status: 200 }; });
    assert.strictEqual(calls, 1);
    assert.strictEqual(res.status, 200);
  });

  await test("withOneRetryOn401: a 401 then 200 retries exactly once, second attempt forces refresh", async () => {
    const forceFlags = [];
    let calls = 0;
    const res = await withOneRetryOn401(async (force) => {
      calls++;
      forceFlags.push(force);
      return calls === 1 ? { status: 401 } : { status: 200 };
    });
    assert.strictEqual(calls, 2);
    assert.deepStrictEqual(forceFlags, [false, true]);
    assert.strictEqual(res.status, 200);
  });

  await test("withOneRetryOn401: a 401 then 401 again makes exactly 2 calls total, never loops", async () => {
    let calls = 0;
    const res = await withOneRetryOn401(async () => { calls++; return { status: 401 }; });
    assert.strictEqual(calls, 2, "must never call a 3rd time even if the retry also fails");
    assert.strictEqual(res.status, 401);
  });

  await test("withOneRetryOn401: a non-401 error status (e.g. 500) never triggers a retry", async () => {
    let calls = 0;
    const res = await withOneRetryOn401(async () => { calls++; return { status: 500 }; });
    assert.strictEqual(calls, 1);
    assert.strictEqual(res.status, 500);
  });

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

  await test("service-worker.js CACHE version is eden-shell-v24 (bumped for this pass's assistant.js frontend change) and includes assistant.html/assistant.js in PRECACHE", async () => {
    const root = path.resolve(__dirname, "..", "..", "..");
    const src = fs.readFileSync(path.join(root, "service-worker.js"), "utf8");
    assert.ok(/const CACHE = "eden-shell-v24"/.test(src));
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
