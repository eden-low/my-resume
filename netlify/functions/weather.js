// EdenAtlas — authenticated weather proxy Function (Production Hardening Phase 1, task C).
//
// Production route: /.netlify/functions/weather (source lives at netlify/functions/weather.js,
// structurally excluded from the static publish output by scripts/build-site.js — only the
// deployed Function endpoint is reachable; see netlify.toml).
//
// Why this exists: home.html and me.js used to call OpenWeatherMap directly from the browser
// with an API key hardcoded in each file's own source — readable by anyone who views page
// source, and permanently present in this repo's git history regardless of any later edit. This
// Function removes that exposure entirely: the provider key now lives only in Netlify's
// OPENWEATHER_API_KEY environment variable, read server-side, and is never included in any
// response, error message, or log line this Function produces.
//
// Unlike netlify/functions/assistant.js, there is NO Owner-only check here — weather is shown to
// the Owner and any Friend alike on Home/Me, so any caller holding a valid Firebase ID token
// (verified server-side, same firebase-admin v14 modular architecture assistant.js already
// uses — see lib/firebase-admin.js) is authorized. No Firestore read is needed at all: this
// Function only verifies the token's signature/validity, it never looks up users/{uid}.
//
// Security model:
//   1. The browser sends its current Firebase ID token as `Authorization: Bearer <token>` and a
//      POST JSON body ({lat, lon} or {}) — coordinates are NEVER placed in a URL/query string on
//      this site's own side, so they never appear in Netlify's access logs or this Function's
//      own console output.
//   2. Coordinates (if supplied) are validated (finite, in [-90,90]/[-180,180]) and rounded to
//      2 decimal places (~1.1km) before ever being sent to the upstream provider — a malformed
//      or out-of-range pair is rejected with 400, never silently clamped or forwarded raw.
//   3. The response returned to the browser is a small, fixed shape (`{ ok, tempC,
//      description }`) — never the raw provider payload, the provider's own request URL,
//      coordinates, or the API key.
//   4. Every failure path (missing config, bad token, invalid coordinates, provider timeout,
//      provider non-2xx, a malformed provider payload) maps to a sanitized error code; the raw
//      provider response body is never echoed back to the browser or logged verbatim.

const { FirebaseConfigError } = require("./lib/firebase-admin");
const { checkBurst } = require("./lib/rate-limit");

const REQUIRED_ENV = ["FIREBASE_PROJECT_ID", "FIREBASE_SERVICE_ACCOUNT", "OPENWEATHER_API_KEY", "ALLOWED_ORIGIN"];

// Same local-dev allowlist assistant.js already documents (Netlify Dev / `npx serve .` /
// Python's http.server) — duplicated here rather than shared, per this repo's established
// per-Function duplication convention (see assistant.js's own header comment).
const LOCAL_DEV_ORIGINS = [
  "http://localhost:8888", "http://127.0.0.1:8888",
  "http://localhost:3000", "http://127.0.0.1:3000",
  "http://localhost:8000", "http://127.0.0.1:8000",
];

const MAX_BODY_BYTES = 500; // generous for {"lat":12.34,"lon":56.78} with room to spare
const LAT_MIN = -90, LAT_MAX = 90, LON_MIN = -180, LON_MAX = 180;
const COORD_PRECISION = 2; // ~1.1km grid — plenty for a city-level weather reading, and avoids
                            // handing the provider a visitor's exact device-GPS coordinate.
const PROVIDER_TIMEOUT_MS = 8000;

// Same fallback the old client-side code used when geolocation is unavailable/denied/timed out —
// kept identical so "no location permission" behaves exactly as it did before this Function
// existed (task C.9).
const FALLBACK_CITY_QUERY = "Kuching,MY";

function jsonResponse(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

function resolveAllowedOrigins(env) {
  const configured = String(env.ALLOWED_ORIGIN || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set([...configured, ...LOCAL_DEV_ORIGINS]);
}

function getHeader(event, name) {
  const headers = event.headers || {};
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return undefined;
}

function safeJsonParse(str) {
  try {
    return { ok: true, value: JSON.parse(str) };
  } catch {
    return { ok: false };
  }
}

// Body is optional — an empty/missing body means "use the fallback city," matching the old
// client behavior when geolocation was unavailable.
function parseRequestBody(raw) {
  if (raw === undefined || raw === null || raw === "") return { value: {} };
  if (typeof raw !== "string") return { error: "invalid_json" };
  if (raw.length > MAX_BODY_BYTES) return { error: "request_too_large" };
  const parsed = safeJsonParse(raw);
  if (!parsed.ok || typeof parsed.value !== "object" || parsed.value === null || Array.isArray(parsed.value)) {
    return { error: "invalid_json" };
  }
  return { value: parsed.value };
}

function roundCoord(n) {
  const factor = 10 ** COORD_PRECISION;
  return Math.round(n * factor) / factor;
}

// Returns { value: null } when the caller supplied no coordinates at all (fallback-city path),
// { value: {lat, lon} } (already rounded) for a valid pair, or { error } for anything malformed
// or out of range — never silently clamped or defaulted to {0,0}.
//
// `typeof === "number"` deliberately, NOT Number(...) coercion: JSON `null` coerces to 0, `true`
// to 1, `"3.14"` to 3.14 and `[5]` to 5 — every one of which would otherwise pass the finite +
// range checks as a fabricated location (e.g. {lat:null, lon:null} → Null Island) instead of
// being rejected. The one legitimate client (js/weather-client.js) only ever sends real JSON
// numbers, so nothing valid is lost by being strict. JSON.parse can still produce a non-finite
// number from e.g. `1e999` (Infinity), which Number.isFinite rejects below.
function validateCoordsInput(body) {
  if (body.lat === undefined && body.lon === undefined) return { value: null };
  const { lat, lon } = body;
  if (typeof lat !== "number" || typeof lon !== "number") return { error: "invalid_coordinates" };
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { error: "invalid_coordinates" };
  if (lat < LAT_MIN || lat > LAT_MAX || lon < LON_MIN || lon > LON_MAX) return { error: "invalid_coordinates" };
  return { value: { lat: roundCoord(lat), lon: roundCoord(lon) } };
}

function buildProviderUrl(coords, apiKey) {
  const base = "https://api.openweathermap.org/data/2.5/weather";
  const locationParam = coords ? `lat=${coords.lat}&lon=${coords.lon}` : `q=${encodeURIComponent(FALLBACK_CITY_QUERY)}`;
  return `${base}?${locationParam}&units=metric&appid=${apiKey}`;
}

// Only the fields the UI actually renders (task C.7) — never the raw provider payload.
// home.html shows `description` ("scattered clouds"); me.js's compact System Status line shows
// the shorter `condition` ("Clouds", OpenWeatherMap's own `weather[0].main`) — both are plain
// short text fields, neither is sensitive, so both are included rather than picking one caller's
// shape and forcing the other to lose information it displayed before this Function existed.
// Returns null for a payload missing/malformed in a way that makes a temperature unavailable.
function sanitizeProviderPayload(data) {
  const tempRaw = data && data.main && data.main.temp;
  if (!Number.isFinite(tempRaw)) return null;
  const first = data && Array.isArray(data.weather) ? data.weather[0] : null;
  const description = first && typeof first.description === "string" ? first.description : null;
  const condition = first && typeof first.main === "string" ? first.main : null;
  return { tempC: Math.round(tempRaw), description, condition };
}

class ProviderError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code; // one of: "timeout" | "http" | "malformed" | "network"
  }
}

async function fetchProviderWeather(fetchImpl, coords, apiKey, timeoutMs) {
  const url = buildProviderUrl(coords, apiKey);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, { signal: controller.signal });
  } catch (err) {
    if (err && err.name === "AbortError") throw new ProviderError("weather provider request timed out", "timeout");
    throw new ProviderError("weather provider request failed", "network");
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new ProviderError(`weather provider returned http ${res.status}`, "http");
  }
  const data = await res.json().catch(() => null);
  const sanitized = data && sanitizeProviderPayload(data);
  if (!sanitized) {
    throw new ProviderError("weather provider returned a malformed payload", "malformed");
  }
  return sanitized;
}

// The only place this file logs anything about a config/auth failure — mirrors assistant.js's
// logAuthStageFailure(): reveals which stage failed and a short, safe error code, never the raw
// JSON, key, token, or Authorization header.
function logAuthStageFailure(stage, err) {
  const code = (err && err.code) || "no_code";
  console.error(`[weather] auth stage failed: stage=${stage} code=${code}`);
}

// `deps` is fully injectable so this handler is unit-testable without firebase-admin or network
// access — see netlify/functions/__tests__/weather.test.js. Production wiring is at the bottom
// of this file.
function createHandler(deps) {
  return async function handler(event) {
    const env = deps.env || process.env;
    const method = event.httpMethod;

    // 1. Fail closed on missing configuration, before anything else.
    const missing = REQUIRED_ENV.filter((k) => !env[k]);
    if (missing.length) {
      console.error("[weather] missing required environment variables:", missing.join(","));
      return jsonResponse(500, { ok: false, error: "weather_not_configured" });
    }

    // 2. Firebase Admin initialization boundary — deliberately separate from token verification
    // (see lib/firebase-admin.js's header comment for the production incident this pattern
    // fixes in assistant.js; reused verbatim here for the same reason).
    try {
      await deps.ensureFirebaseAdmin();
    } catch (err) {
      logAuthStageFailure(err instanceof FirebaseConfigError ? err.stage : "admin_initialization", err);
      return jsonResponse(500, { ok: false, error: "weather_not_configured" });
    }

    const allowedOrigins = resolveAllowedOrigins(env);
    const origin = getHeader(event, "origin");
    const originOk = !!origin && allowedOrigins.has(origin);

    if (method === "OPTIONS") {
      return originOk
        ? { statusCode: 204, headers: corsHeaders(origin), body: "" }
        : jsonResponse(403, { ok: false, error: "origin_not_allowed" });
    }
    if (method !== "POST") {
      return jsonResponse(405, { ok: false, error: "method_not_allowed" }, { Allow: "POST, OPTIONS" });
    }
    if (!originOk) {
      return jsonResponse(403, { ok: false, error: "origin_not_allowed" });
    }
    const baseHeaders = corsHeaders(origin);

    // 3. Authenticate — any signed-in user (no Owner-only check; weather is shown to every
    // signed-in role). By this point Firebase Admin is already known-initialized (step 2 already
    // returned 500 otherwise), so the only way verifyIdToken() can now fail is a genuine token
    // problem — that is the only case that may ever produce a 401 here.
    const authHeader = getHeader(event, "authorization") || "";
    const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    if (!match) {
      return jsonResponse(401, { ok: false, error: "missing_bearer_token" }, baseHeaders);
    }
    let decoded;
    try {
      decoded = await deps.verifyIdToken(match[1]);
    } catch (err) {
      if (err instanceof FirebaseConfigError) {
        logAuthStageFailure(err.stage, err);
        return jsonResponse(500, { ok: false, error: "weather_not_configured" }, baseHeaders);
      }
      logAuthStageFailure("token_verification", err);
      return jsonResponse(401, { ok: false, error: "invalid_or_expired_token" }, baseHeaders);
    }
    if (!decoded || !decoded.uid) {
      logAuthStageFailure("token_verification", null);
      return jsonResponse(401, { ok: false, error: "invalid_or_expired_token" }, baseHeaders);
    }
    const uid = decoded.uid;

    // 4. Burst rate-limit — in-memory, per-uid, namespaced with a "weather:" prefix so it never
    // shares (or is exhausted by) the same in-memory counter netlify/functions/assistant.js uses
    // for the same uid via the same shared lib/rate-limit.js module instance.
    const now = deps.now ? deps.now() : new Date();
    const burst = deps.checkBurst(`weather:${uid}`, now.getTime());
    if (!burst.allowed) {
      return jsonResponse(
        429,
        { ok: false, error: "rate_limited", retryAfterMs: burst.retryAfterMs },
        { ...baseHeaders, "Retry-After": String(Math.ceil(burst.retryAfterMs / 1000)) }
      );
    }

    // 5. Validate the request body / coordinates.
    const parsedBody = parseRequestBody(event.body);
    if (parsedBody.error) {
      return jsonResponse(400, { ok: false, error: parsedBody.error }, baseHeaders);
    }
    const coordsResult = validateCoordsInput(parsedBody.value);
    if (coordsResult.error) {
      return jsonResponse(400, { ok: false, error: coordsResult.error }, baseHeaders);
    }

    // 6. Call the upstream provider. Every failure path returns a sanitized error — the raw
    // provider body/status text and the API key are never included in the response or logged.
    try {
      const weather = await fetchProviderWeather(deps.fetchImpl || fetch, coordsResult.value, env.OPENWEATHER_API_KEY, PROVIDER_TIMEOUT_MS);
      return jsonResponse(200, { ok: true, tempC: weather.tempC, description: weather.description, condition: weather.condition }, baseHeaders);
    } catch (err) {
      if (err instanceof ProviderError) {
        console.error(`[weather] provider call failed: code=${err.code}`);
        if (err.code === "timeout") return jsonResponse(504, { ok: false, error: "weather_upstream_timeout" }, baseHeaders);
        return jsonResponse(502, { ok: false, error: "weather_upstream_error" }, baseHeaders);
      }
      console.error("[weather] unexpected error:", err && err.message);
      return jsonResponse(500, { ok: false, error: "weather_internal_error" }, baseHeaders);
    }
  };
}

// ---- Production wiring (firebase-admin only loaded/initialized here, never in the handler
// factory above, so tests never need it installed to exercise business logic) ----

function buildProductionDeps() {
  // Same v14 modular entry points assistant.js uses — no Firestore is needed at all for this
  // Function, so firebase-admin/firestore is deliberately never required here.
  const { initializeApp, cert, getApps, getApp } = require("firebase-admin/app");
  const { getAuth } = require("firebase-admin/auth");
  const { initializeFirebaseAdmin } = require("./lib/firebase-admin");
  let app = null; // memoized ONLY on success — see assistant.js's ensureApp() for the reasoning

  function ensureApp() {
    if (app) return app;
    app = initializeFirebaseAdmin({
      getApps,
      getApp,
      initializeApp,
      cert,
      projectId: process.env.FIREBASE_PROJECT_ID,
      serviceAccountRaw: process.env.FIREBASE_SERVICE_ACCOUNT,
    });
    return app;
  }

  return {
    env: process.env,
    now: () => new Date(),
    ensureFirebaseAdmin: async () => { ensureApp(); },
    verifyIdToken: (token) => getAuth(ensureApp()).verifyIdToken(token, true),
    checkBurst,
    fetchImpl: undefined, // use global fetch
  };
}

exports.handler = createHandler(buildProductionDeps());
exports.createHandler = createHandler; // exported for tests only
