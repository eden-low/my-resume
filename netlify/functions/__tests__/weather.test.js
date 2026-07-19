// Deterministic tests for the authenticated weather proxy Function — mocked Firebase Admin, a
// mocked fetchImpl for the upstream OpenWeatherMap call, no network access, no real Firestore, no
// real provider key. Run with: node netlify/functions/__tests__/weather.test.js (or
// `npm run test:functions`). Exits non-zero on any failure. Mirrors assistant.test.js's own
// createHandler(deps) testing style.

const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");
const vm = require("node:vm");

const { createHandler } = require("../weather.js");
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

const FAKE_KEY = "FAKE_OPENWEATHER_SECRET_DO_NOT_LEAK_7c3a1b";
const PROD_ORIGIN = "https://edenatlas.netlify.app";
const OWNER_UID = "owner-uid-123";
const FRIEND_UID = "friend-uid-456";

function baseEnv(overrides = {}) {
  return {
    FIREBASE_PROJECT_ID: "lfj-profolio",
    FIREBASE_SERVICE_ACCOUNT: '{"project_id":"lfj-profolio"}',
    OPENWEATHER_API_KEY: FAKE_KEY,
    ALLOWED_ORIGIN: PROD_ORIGIN,
    ...overrides,
  };
}

function baseEvent({ httpMethod = "POST", headers = {}, body = "{}" } = {}) {
  return {
    httpMethod,
    headers: { origin: PROD_ORIGIN, authorization: "Bearer valid-token", ...headers },
    body,
  };
}

function makeFakeFetch({ status = 200, json = null, malformedJson = false, throwAbort = false, throwNetwork = false } = {}) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push(url);
    if (throwAbort) {
      const err = new Error("simulated abort");
      err.name = "AbortError";
      throw err;
    }
    if (throwNetwork) {
      throw new Error("simulated network failure");
    }
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (malformedJson) throw new Error("not json");
        return json;
      },
    };
  };
  impl.calls = calls;
  return impl;
}

function makeDeps(overrides = {}) {
  return {
    env: baseEnv(),
    now: () => new Date("2026-07-19T04:00:00Z"),
    ensureFirebaseAdmin: async () => {},
    verifyIdToken: async () => ({ uid: OWNER_UID, email: "jjun8647@gmail.com" }),
    checkBurst: () => ({ allowed: true }),
    fetchImpl: makeFakeFetch({ json: { main: { temp: 28.4 }, weather: [{ description: "light rain" }] } }),
    ...overrides,
  };
}

async function run() {
  // ---- Config / origin / method ----

  await test("missing required env vars fails closed with 500, before touching Firebase Admin", async () => {
    let ensureCalled = false;
    const deps = makeDeps({ env: baseEnv({ OPENWEATHER_API_KEY: undefined }), ensureFirebaseAdmin: async () => { ensureCalled = true; } });
    const handler = createHandler(deps);
    const res = await handler(baseEvent());
    assert.strictEqual(res.statusCode, 500);
    assert.strictEqual(JSON.parse(res.body).error, "weather_not_configured");
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
    assert.strictEqual(JSON.parse(res.body).error, "weather_not_configured");
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

  await test("a local-dev origin (Netlify Dev, port 8888) is accepted", async () => {
    const res = await createHandler(makeDeps())(baseEvent({ headers: { origin: "http://localhost:8888", authorization: "Bearer t" } }));
    assert.notStrictEqual(res.statusCode, 403);
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

  // ---- Auth: any signed-in user, no Owner-only check ----

  await test("missing Authorization header is rejected with 401", async () => {
    const res = await createHandler(makeDeps())(baseEvent({ headers: { origin: PROD_ORIGIN, authorization: undefined } }));
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(JSON.parse(res.body).error, "missing_bearer_token");
  });

  await test("a genuinely invalid token is 401, never 500", async () => {
    const deps = makeDeps({ verifyIdToken: async () => { const e = new Error("bad token"); e.code = "auth/argument-error"; throw e; } });
    const res = await createHandler(deps)(baseEvent());
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(JSON.parse(res.body).error, "invalid_or_expired_token");
  });

  await test("a FirebaseConfigError thrown from verifyIdToken (defense-in-depth) is 500, not 401", async () => {
    const deps = makeDeps({ verifyIdToken: async () => { throw new FirebaseConfigError("x", "admin_initialization", "config/init-failed"); } });
    const res = await createHandler(deps)(baseEvent());
    assert.strictEqual(res.statusCode, 500);
  });

  await test("a valid token for a NON-owner (Friend) is accepted — weather has no Owner-only gate", async () => {
    const deps = makeDeps({ verifyIdToken: async () => ({ uid: FRIEND_UID, email: "friend@example.com" }) });
    const res = await createHandler(deps)(baseEvent());
    assert.strictEqual(res.statusCode, 200);
  });

  // ---- Rate limiting ----

  await test("a burst-rejected request returns 429 with Retry-After and never calls the provider", async () => {
    const fetchImpl = makeFakeFetch({ json: { main: { temp: 20 }, weather: [{ description: "clear" }] } });
    const deps = makeDeps({ checkBurst: () => ({ allowed: false, retryAfterMs: 12345 }), fetchImpl });
    const res = await createHandler(deps)(baseEvent());
    assert.strictEqual(res.statusCode, 429);
    assert.strictEqual(res.headers["Retry-After"], "13");
    assert.strictEqual(fetchImpl.calls.length, 0);
  });

  await test("checkBurst is called with a 'weather:'-prefixed key so it never shares assistant.js's per-uid burst budget", async () => {
    let receivedKey = null;
    const deps = makeDeps({ checkBurst: (key) => { receivedKey = key; return { allowed: true }; } });
    await createHandler(deps)(baseEvent());
    assert.strictEqual(receivedKey, `weather:${OWNER_UID}`);
  });

  // ---- Request body / coordinate validation ----

  await test("an empty body is treated as 'no coordinates' (fallback city), not an error", async () => {
    const res = await createHandler(makeDeps())(baseEvent({ body: "" }));
    assert.strictEqual(res.statusCode, 200);
  });

  await test("invalid JSON body is rejected with 400", async () => {
    const res = await createHandler(makeDeps())(baseEvent({ body: "{not json" }));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(JSON.parse(res.body).error, "invalid_json");
  });

  await test("an oversized body is rejected with 400 before JSON parsing", async () => {
    const res = await createHandler(makeDeps())(baseEvent({ body: `{"lat":1,"lon":1,"pad":"${"x".repeat(600)}"}` }));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(JSON.parse(res.body).error, "request_too_large");
  });

  await test("non-finite coordinates are rejected with invalid_coordinates", async () => {
    const res = await createHandler(makeDeps())(baseEvent({ body: JSON.stringify({ lat: "not-a-number", lon: 10 }) }));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(JSON.parse(res.body).error, "invalid_coordinates");
  });

  await test("out-of-range coordinates (lat > 90) are rejected with invalid_coordinates", async () => {
    const res = await createHandler(makeDeps())(baseEvent({ body: JSON.stringify({ lat: 200, lon: 10 }) }));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(JSON.parse(res.body).error, "invalid_coordinates");
  });

  await test("out-of-range coordinates (lon < -180) are rejected with invalid_coordinates", async () => {
    const res = await createHandler(makeDeps())(baseEvent({ body: JSON.stringify({ lat: 10, lon: -200 }) }));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(JSON.parse(res.body).error, "invalid_coordinates");
  });

  await test("JSON null coordinates are rejected — Number(null)===0 must never fabricate a (0,0) Null Island location", async () => {
    const fetchImpl = makeFakeFetch({ json: { main: { temp: 20 }, weather: [{ description: "clear" }] } });
    const res = await createHandler(makeDeps({ fetchImpl }))(baseEvent({ body: JSON.stringify({ lat: null, lon: null }) }));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(JSON.parse(res.body).error, "invalid_coordinates");
    assert.strictEqual(fetchImpl.calls.length, 0, "a rejected coordinate pair must never reach the provider");
  });

  await test("boolean / numeric-string / array coordinates are rejected — no type coercion into a valid-looking pair", async () => {
    for (const body of [{ lat: true, lon: false }, { lat: "3.14", lon: "101.9" }, { lat: [5], lon: [6] }]) {
      const res = await createHandler(makeDeps())(baseEvent({ body: JSON.stringify(body) }));
      assert.strictEqual(res.statusCode, 400, `expected 400 for ${JSON.stringify(body)}`);
      assert.strictEqual(JSON.parse(res.body).error, "invalid_coordinates");
    }
  });

  await test("a one-sided pair (lat without lon, or lon without lat) is rejected, never defaulted", async () => {
    for (const body of [{ lat: 3.1 }, { lon: 101.9 }]) {
      const res = await createHandler(makeDeps())(baseEvent({ body: JSON.stringify(body) }));
      assert.strictEqual(res.statusCode, 400, `expected 400 for ${JSON.stringify(body)}`);
      assert.strictEqual(JSON.parse(res.body).error, "invalid_coordinates");
    }
  });

  await test("a JSON number that parses to Infinity (1e999) is rejected as non-finite", async () => {
    const res = await createHandler(makeDeps())(baseEvent({ body: '{"lat":1e999,"lon":101.9}' }));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(JSON.parse(res.body).error, "invalid_coordinates");
  });

  await test("valid coordinates are rounded to 2 decimal places before being sent upstream, and never appear raw", async () => {
    const fetchImpl = makeFakeFetch({ json: { main: { temp: 25 }, weather: [{ description: "clear sky" }] } });
    const deps = makeDeps({ fetchImpl });
    const res = await createHandler(deps)(baseEvent({ body: JSON.stringify({ lat: 3.14159265, lon: 101.98765432 }) }));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(fetchImpl.calls.length, 1);
    assert.ok(fetchImpl.calls[0].includes("lat=3.14"), `expected rounded lat in ${fetchImpl.calls[0]}`);
    assert.ok(fetchImpl.calls[0].includes("lon=101.99"), `expected rounded lon in ${fetchImpl.calls[0]}`);
    assert.ok(!fetchImpl.calls[0].includes("3.14159265"), "raw, unrounded coordinate must never reach the provider URL");
  });

  await test("no coordinates supplied falls back to the fixed city query (Kuching,MY)", async () => {
    const fetchImpl = makeFakeFetch({ json: { main: { temp: 25 }, weather: [{ description: "clear sky" }] } });
    const deps = makeDeps({ fetchImpl });
    await createHandler(deps)(baseEvent({ body: "{}" }));
    assert.ok(fetchImpl.calls[0].includes("q=Kuching%2CMY"));
  });

  // ---- Provider failure handling ----

  await test("a provider timeout (AbortError) maps to 504 weather_upstream_timeout", async () => {
    const deps = makeDeps({ fetchImpl: makeFakeFetch({ throwAbort: true }) });
    const res = await createHandler(deps)(baseEvent());
    assert.strictEqual(res.statusCode, 504);
    assert.strictEqual(JSON.parse(res.body).error, "weather_upstream_timeout");
  });

  await test("a provider non-2xx response maps to 502, never echoing the raw status/body", async () => {
    const deps = makeDeps({ fetchImpl: makeFakeFetch({ status: 500, json: { message: "upstream secret debug info" } }) });
    const res = await createHandler(deps)(baseEvent());
    assert.strictEqual(res.statusCode, 502);
    assert.strictEqual(JSON.parse(res.body).error, "weather_upstream_error");
    assert.ok(!res.body.includes("upstream secret debug info"));
  });

  await test("a malformed/incomplete provider payload (no main.temp) maps to 502, not a crash", async () => {
    const deps = makeDeps({ fetchImpl: makeFakeFetch({ json: { weather: [{ description: "foggy" }] } }) });
    const res = await createHandler(deps)(baseEvent());
    assert.strictEqual(res.statusCode, 502);
    assert.strictEqual(JSON.parse(res.body).error, "weather_upstream_error");
  });

  await test("a provider response that isn't valid JSON at all maps to 502, not a crash", async () => {
    const deps = makeDeps({ fetchImpl: makeFakeFetch({ malformedJson: true }) });
    const res = await createHandler(deps)(baseEvent());
    assert.strictEqual(res.statusCode, 502);
  });

  await test("a network-level fetch failure maps to 502 weather_upstream_error", async () => {
    const deps = makeDeps({ fetchImpl: makeFakeFetch({ throwNetwork: true }) });
    const res = await createHandler(deps)(baseEvent());
    assert.strictEqual(res.statusCode, 502);
  });

  // ---- Success shape / secret hygiene ----

  await test("a successful response contains ONLY {ok, tempC, description, condition} — never coordinates, provider payload, or the API key", async () => {
    const deps = makeDeps({
      fetchImpl: makeFakeFetch({ json: { main: { temp: 28.6, humidity: 80, pressure: 1010 }, weather: [{ main: "Rain", description: "moderate rain", icon: "10d" }], coord: { lat: 3.14, lon: 101.99 }, name: "Kuala Lumpur" } }),
    });
    const res = await createHandler(deps)(baseEvent({ body: JSON.stringify({ lat: 3.1, lon: 101.9 }) }));
    const parsed = JSON.parse(res.body);
    assert.deepStrictEqual(Object.keys(parsed).sort(), ["condition", "description", "ok", "tempC"]);
    assert.strictEqual(parsed.tempC, 29); // Math.round(28.6)
    assert.strictEqual(parsed.description, "moderate rain");
    assert.strictEqual(parsed.condition, "Rain");
    assert.ok(!res.body.includes(FAKE_KEY));
    assert.ok(!res.body.includes("humidity"));
    assert.ok(!res.body.includes("3.1"));
  });

  await test("the API key never appears in any response body across every failure path", async () => {
    const scenarios = [
      makeDeps({ env: baseEnv({ OPENWEATHER_API_KEY: undefined }) }),
      makeDeps({ verifyIdToken: async () => { throw new Error("bad"); } }),
      makeDeps({ fetchImpl: makeFakeFetch({ status: 401, json: { message: `key ${FAKE_KEY} invalid` } }) }),
      makeDeps({ fetchImpl: makeFakeFetch({ throwAbort: true }) }),
    ];
    for (const deps of scenarios) {
      const res = await createHandler(deps)(baseEvent());
      assert.ok(!res.body.includes(FAKE_KEY), `key leaked in: ${res.body}`);
    }
  });

  await test("the API key and coordinates never appear in a console.error call across any failure path", async () => {
    const originalError = console.error;
    const logged = [];
    console.error = (...args) => logged.push(args.join(" "));
    try {
      const deps = makeDeps({ fetchImpl: makeFakeFetch({ status: 500, json: {} }) });
      await createHandler(deps)(baseEvent({ body: JSON.stringify({ lat: 3.123456, lon: 101.987654 }) }));
      const combined = logged.join("\n");
      assert.ok(!combined.includes(FAKE_KEY));
      assert.ok(!combined.includes("3.123456"));
      assert.ok(!combined.includes("101.987654"));
    } finally {
      console.error = originalError;
    }
  });

  await test("a network error whose OWN message embeds the provider URL (and key) is logged only as code=network — the raw message never reaches the log", async () => {
    // Node's real fetch rejections can carry the request URL in their message/cause chain — and
    // the provider URL contains the API key as a query param. The ProviderError wrapper must
    // discard the original message entirely, not just prefix it.
    const fetchImpl = async (url) => {
      throw new Error(`request to ${url} failed, reason: connect ECONNREFUSED`);
    };
    const originalError = console.error;
    const logged = [];
    console.error = (...args) => logged.push(args.join(" "));
    let res;
    try {
      res = await createHandler(makeDeps({ fetchImpl }))(baseEvent({ body: JSON.stringify({ lat: 3.1, lon: 101.9 }) }));
    } finally {
      console.error = originalError;
    }
    assert.strictEqual(res.statusCode, 502);
    const combined = logged.join("\n");
    assert.ok(!combined.includes(FAKE_KEY), "the key-bearing URL from the fetch error's own message must never be logged");
    assert.ok(!combined.includes("openweathermap"), "the provider URL must never be logged");
    assert.ok(combined.includes("code=network"), "the sanitized classification should still be logged");
    assert.ok(!res.body.includes(FAKE_KEY));
    assert.ok(!res.body.includes("ECONNREFUSED"));
  });

  // ---- Service worker: Function responses are never cached ----

  await test("service-worker.js: /.netlify/functions/weather is never written to Cache Storage (same generic bypass as /assistant, /health)", async () => {
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
      request: { url: `${PROD_ORIGIN}/.netlify/functions/weather`, method: "POST" },
      respondWith: (p) => { responded = p; },
    });
    await responded;
    assert.strictEqual(cachePutCalls.length, 0);
  });

  await test("service-worker.js precaches the browser assets this pass added (Weather Function client)", async () => {
    const root = path.resolve(__dirname, "..", "..", "..");
    const src = fs.readFileSync(path.join(root, "service-worker.js"), "utf8");
    // CACHE's exact version string is intentionally not asserted here — it is expected to keep
    // advancing past eden-shell-v29 as later, unrelated passes (e.g. the Tailwind local build
    // migration's eden-shell-v30) bump it further; this test only cares that the assets THIS
    // pass added are still precached, not which version number currently owns the bump.
    assert.ok(/"js\/date-utils\.js"/.test(src));
    assert.ok(/"js\/reflection\.js"/.test(src));
    assert.ok(/"js\/weather-client\.js"/.test(src));
  });

  // ---- Frontend key removal (structural — deliberately contains no real credential) ----
  //
  // The historical browser-exposed OpenWeatherMap key was removed from home.html/me.js by this
  // pass. Rather than embedding that key literal here as a canary — which would itself keep a
  // real credential in the tree — this test enforces the security properties structurally: no
  // browser-served file may construct a direct provider call or an appid= query at all, and no
  // OpenWeatherMap-shaped key literal (32 lowercase hex chars) may appear in any of the files
  // below. The shape check catches reintroduction of the old key AND any future one, without
  // this file ever needing to know either value. netlify/functions/weather.js is the one
  // legitimate provider call site (server-side proxy), and service-worker.js may name the
  // provider host in its inert BYPASS_HOSTS list — neither may carry a key-shaped literal.

  await test("no browser file calls OpenWeatherMap directly, embeds appid=, or contains a key-shaped literal; the Function reads its key only from the environment", async () => {
    const root = path.resolve(__dirname, "..", "..", "..");
    const OWM_KEY_SHAPE = /\b[0-9a-f]{32}\b/; // OpenWeatherMap API keys are 32 lowercase hex chars
    // Browser-served weather call sites: never a direct provider call, never an appid= query,
    // never a key-shaped literal.
    for (const file of ["home.html", "me.js", "js/weather-client.js"]) {
      const src = fs.readFileSync(path.join(root, file), "utf8");
      assert.ok(!/api\.openweathermap\.org/.test(src), `${file} must not call OpenWeatherMap directly`);
      assert.ok(!/appid=/.test(src), `${file} must not construct a provider-key query parameter`);
      assert.ok(!OWM_KEY_SHAPE.test(src), `${file} must not contain an OpenWeatherMap-shaped key literal`);
    }
    // service-worker.js's BYPASS_HOSTS hostname entry is inert and allowed — but an appid=
    // construction or key-shaped literal never is.
    const sw = fs.readFileSync(path.join(root, "service-worker.js"), "utf8");
    assert.ok(!/appid=/.test(sw), "service-worker.js must not construct a provider-key query parameter");
    assert.ok(!OWM_KEY_SHAPE.test(sw), "service-worker.js must not contain an OpenWeatherMap-shaped key literal");
    // The server proxy is the ONE place a provider URL is built — and its key must come only
    // from the environment (env.OPENWEATHER_API_KEY), never a literal in committed source.
    const fnSrc = fs.readFileSync(path.join(root, "netlify", "functions", "weather.js"), "utf8");
    assert.ok(/env\.OPENWEATHER_API_KEY/.test(fnSrc), "weather.js must read the provider key from the environment");
    assert.ok(!OWM_KEY_SHAPE.test(fnSrc), "weather.js must not contain an OpenWeatherMap-shaped key literal");
    // This test file itself must stay credential-free: the fixture is unmistakably fake (and
    // not key-shaped), and no key-shaped literal may appear anywhere in this file.
    assert.ok(FAKE_KEY.startsWith("FAKE_") && !OWM_KEY_SHAPE.test(FAKE_KEY), "the test fixture key must be unmistakably fake");
    const selfSrc = fs.readFileSync(__filename, "utf8");
    assert.ok(!OWM_KEY_SHAPE.test(selfSrc), "this test file must not contain any key-shaped literal");
  });

  // ---- Summary ----
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    process.exitCode = 1;
  }
}

run();
