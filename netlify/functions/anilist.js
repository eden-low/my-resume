// EdenAtlas Discover — Owner-only AniList GraphQL proxy Function.
//
// Production route: /.netlify/functions/anilist (source lives at netlify/functions/anilist.js,
// structurally excluded from the static publish output by scripts/build-site.js — only the
// deployed Function endpoint is reachable; see netlify.toml).
//
// Owner-only authorization reuses the EXACT approach netlify/functions/assistant.js already
// established (see that file's header comment, point 3) rather than inventing a weaker or
// different check: the browser sends a Firebase ID token; this Function verifies it server-side
// via Firebase Admin, re-reads users/{uid} via Admin (which bypasses firestore.rules entirely,
// same as assistant.js), and requires TWO independent signals to agree — the server-verified
// token's own email AND the stored users/{uid} doc's `role`/`email` fields both matching the
// hardcoded OWNER_EMAIL constant — before treating the caller as the Owner. Discover is strictly
// Owner-only end to end (product decision): Friend/Connection/Viewer accounts must never reach
// AniList data through this Function, regardless of any client-side role check or which page they
// came from — this server-side check is the actual security boundary, never the UI.
//
// The browser never supplies a GraphQL document, field selection, or raw variables object — see
// lib/anilist-operations.js, which defines a fixed operation allowlist (browse/search/details/
// batch). isAdult:false is force-set into every request's variables by that module's
// buildRequest() functions; this file never reads an `isAdult` value out of the request body at
// any point, so there is no code path a client-supplied value could ever reach.
//
// This module intentionally never `require()`s any browser ES module (firebase-init.js, etc.) —
// see assistant.js's identical header note on why (CommonJS Function runtime vs. browser ESM).

const { OPERATIONS, AniListValidationError, CONTENT_FILTER_POLICY_VERSION } = require("./lib/anilist-operations");
const { getCached, setCached } = require("./lib/anilist-cache");
const { checkBurst } = require("./lib/rate-limit");
const { FirebaseConfigError } = require("./lib/firebase-admin");
const { readGeneratedDeployOrigins } = require("./lib/deploy-origin");

// Duplicated from firebase-init.js on purpose — see assistant.js's identical comment: this
// Function can't import a browser ES module, and re-deriving "who is the Owner" from two
// independent hardcoded sources (this constant + users/{uid}.role) is a deliberate
// defense-in-depth choice, not an oversight.
const OWNER_EMAIL = "jjun8647@gmail.com";

const REQUIRED_ENV = ["FIREBASE_PROJECT_ID", "FIREBASE_SERVICE_ACCOUNT", "ALLOWED_ORIGIN"];

// Same local-dev allowlist every other Function in this repo documents and duplicates (Netlify
// Dev / `npx serve .` / Python's http.server) — per this repo's established per-Function
// duplication convention (see assistant.js/weather.js's own identical comments).
const LOCAL_DEV_ORIGINS = [
  "http://localhost:8888", "http://127.0.0.1:8888",
  "http://localhost:3000", "http://127.0.0.1:3000",
  "http://localhost:8000", "http://127.0.0.1:8000",
];

const ANILIST_ENDPOINT = "https://graphql.anilist.co";
const MAX_BODY_BYTES = 2000; // generous for {"operation":"...","args":{...}} with room to spare
const UPSTREAM_TIMEOUT_MS = 8000;
const ALLOWED_OPERATIONS = Object.keys(OPERATIONS); // ["browse", "search", "details", "batch"]

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

// Netlify Deploy Previews and branch deploys get their own real, unpredictable-per-PR origin
// (e.g. https://deploy-preview-12--edenatlas.netlify.app), which can never be listed in the
// static ALLOWED_ORIGIN env var ahead of time. env.DEPLOY_PRIME_URL/env.DEPLOY_URL are RAW
// strings — in production they come from the build-time snapshot lib/deploy-origin.js reads (see
// buildProductionDeps() below), in tests they're whatever fixture value a test supplies — either
// way this function is the one place that normalizes and validates them, via `new URL(value)
// .origin`, exactly as required: NEVER a suffix/prefix match against "*.netlify.app" (that would
// let ANY Netlify-hosted site, including someone else's project, pass this check merely by
// forging an Origin header that ends the right way — deliberately not implemented). A malformed
// value (not a valid URL, or an unexpected scheme) normalizes to null and is silently dropped,
// never crashes the handler. The final Set comparison the caller does is a plain exact-string
// `Set.has(rawIncomingOriginHeader)` — never re-parsed or re-normalized — which is what actually
// defeats userinfo/trailing-dot/prefix/suffix bypass attempts: a browser's Origin header is
// already in canonical serialized-origin form, so any of those tricks simply produces a string
// that doesn't literally match anything in the Set.
function normalizeExactOrigin(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl.trim() === "") return null;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function resolveAllowedOrigins(env) {
  const configured = String(env.ALLOWED_ORIGIN || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // DEPLOY_PRIME_URL is checked first (the stable per-deploy-context URL; same value as
  // production's own URL when this Function happens to run in a production context), DEPLOY_URL
  // second (the unique-per-build URL, which changes on every new commit to the same PR) — both
  // are added when present and valid, not "DEPLOY_URL only as a fallback," since the browser may
  // have loaded either one depending on which link was actually opened.
  const deployOrigins = [normalizeExactOrigin(env.DEPLOY_PRIME_URL), normalizeExactOrigin(env.DEPLOY_URL)]
    .filter(Boolean);
  return new Set([...configured, ...deployOrigins, ...LOCAL_DEV_ORIGINS]);
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

// Only two top-level keys are ever accepted — `operation` (must be one of the fixed allowlisted
// names) and `args` (an operation-specific object, further validated by that operation's own
// validate()). Anything else at the top level is rejected outright, never silently ignored.
function parseRequestBody(raw) {
  if (typeof raw !== "string" || raw.length === 0) return { error: "empty_request_body" };
  if (raw.length > MAX_BODY_BYTES) return { error: "request_too_large" };
  const parsed = safeJsonParse(raw);
  if (!parsed.ok || typeof parsed.value !== "object" || parsed.value === null || Array.isArray(parsed.value)) {
    return { error: "invalid_json" };
  }
  const body = parsed.value;
  const extraTopLevel = Object.keys(body).filter((k) => k !== "operation" && k !== "args");
  if (extraTopLevel.length) return { error: "unknown_field" };
  if (typeof body.operation !== "string" || !ALLOWED_OPERATIONS.includes(body.operation)) {
    return { error: "unknown_operation" };
  }
  if (body.args !== undefined && (typeof body.args !== "object" || body.args === null || Array.isArray(body.args))) {
    return { error: "invalid_args" };
  }
  return { value: { operation: body.operation, args: body.args || {} } };
}

class UpstreamError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code; // "timeout" | "http" | "malformed" | "network"
  }
}

async function callAniList(fetchImpl, query, variables, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(ANILIST_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err && err.name === "AbortError") throw new UpstreamError("anilist request timed out", "timeout");
    throw new UpstreamError("anilist request failed", "network");
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    // AniList returns a structured GraphQL error body even on non-2xx — never echoed to the
    // client or logged verbatim; only this sanitized classification is.
    throw new UpstreamError(`anilist http ${res.status}`, "http");
  }
  const data = await res.json().catch(() => null);
  if (!data || typeof data !== "object" || !data.data) {
    throw new UpstreamError("anilist returned a malformed payload", "malformed");
  }
  return data.data;
}

// The only place this file logs anything about an auth/config failure — mirrors assistant.js's/
// weather.js's logAuthStageFailure(): reveals which stage failed and a short, safe error code,
// never the raw JSON, token, or Authorization header.
function logAuthStageFailure(stage, err) {
  const code = (err && err.code) || "no_code";
  console.error(`[anilist] auth stage failed: stage=${stage} code=${code}`);
}

// `deps` is fully injectable so this handler is unit-testable without firebase-admin or network
// access — see netlify/functions/__tests__/anilist.test.js. Production wiring is at the bottom.
function createHandler(deps) {
  return async function handler(event) {
    const env = deps.env || process.env;
    const method = event.httpMethod;

    // 1. Fail closed on missing configuration, before anything else.
    const missing = REQUIRED_ENV.filter((k) => !env[k]);
    if (missing.length) {
      console.error("[anilist] missing required environment variables:", missing.join(","));
      return jsonResponse(500, { ok: false, error: "anilist_not_configured" });
    }

    // 2. Firebase Admin initialization boundary — deliberately separate from token verification
    // (see lib/firebase-admin.js's header comment for the production incident this pattern
    // fixes in assistant.js; reused verbatim here for the same reason).
    try {
      await deps.ensureFirebaseAdmin();
    } catch (err) {
      logAuthStageFailure(err instanceof FirebaseConfigError ? err.stage : "admin_initialization", err);
      return jsonResponse(500, { ok: false, error: "anilist_not_configured" });
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

    // 3. Authenticate — derive uid from a server-verified Firebase ID token only.
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
        return jsonResponse(500, { ok: false, error: "anilist_not_configured" }, baseHeaders);
      }
      logAuthStageFailure("token_verification", err);
      return jsonResponse(401, { ok: false, error: "invalid_or_expired_token" }, baseHeaders);
    }
    if (!decoded || !decoded.uid) {
      logAuthStageFailure("token_verification", null);
      return jsonResponse(401, { ok: false, error: "invalid_or_expired_token" }, baseHeaders);
    }
    const uid = decoded.uid;

    // 4. Authorize — Owner only. Two independent signals that must BOTH agree (AND, never OR —
    // see assistant.js's identical comment for why an OR here would be a real gap): the
    // server-verified token's own email AND the users/{uid} directory doc's role/email fields.
    let userDoc;
    try {
      userDoc = await deps.getUserDoc(uid);
    } catch (err) {
      console.error("[anilist] users/{uid} read failed:", err && err.code);
      return jsonResponse(500, { ok: false, error: "profile_lookup_failed" }, baseHeaders);
    }
    const isOwner = !!userDoc && userDoc.role === "owner" && decoded.email === OWNER_EMAIL && userDoc.email === OWNER_EMAIL;
    if (!isOwner) {
      return jsonResponse(403, { ok: false, error: "owner_only" }, baseHeaders);
    }

    // 5. Burst rate-limit — in-memory, per-uid, namespaced with an "anilist:" prefix so it never
    // shares (or is exhausted by) the same in-memory counter assistant.js/weather.js use for the
    // same uid via the same shared lib/rate-limit.js module instance. No durable daily cap here
    // (unlike assistant.js's Qwen guard) — AniList calls have no per-call cost to protect against,
    // matching weather.js's identical choice to rely on the burst guard alone.
    const now = deps.now ? deps.now() : new Date();
    const burst = deps.checkBurst(`anilist:${uid}`, now.getTime());
    if (!burst.allowed) {
      return jsonResponse(
        429,
        { ok: false, error: "rate_limited", retryAfterMs: burst.retryAfterMs },
        { ...baseHeaders, "Retry-After": String(Math.ceil(burst.retryAfterMs / 1000)) }
      );
    }

    // 6. Parse + validate the request shape — operation allowlist, no unknown top-level fields.
    const parsedBody = parseRequestBody(event.body);
    if (parsedBody.error) {
      return jsonResponse(400, { ok: false, error: parsedBody.error }, baseHeaders);
    }
    const { operation, args } = parsedBody.value;
    const opDef = OPERATIONS[operation];

    // 7. Validate operation-specific args (unknown fields, bounds, positive integers, dedup, …).
    let validatedArgs;
    try {
      validatedArgs = opDef.validate(args);
    } catch (err) {
      if (err instanceof AniListValidationError) {
        return jsonResponse(400, { ok: false, error: err.code }, baseHeaders);
      }
      throw err;
    }

    // 8. Build the fixed, server-constructed query + variables. isAdult:false is baked in by
    // buildRequest() itself — never read from `args`/the request body at any point above.
    const { query, variables } = opDef.buildRequest(validatedArgs, { now });

    // 9. Short-lived bounded cache — never a persistent catalog store (see lib/anilist-cache.js).
    // The cache key is namespaced with CONTENT_FILTER_POLICY_VERSION (not just `operation`) so a
    // response cached under an older content-filter policy (e.g. before EXCLUDED_GENRES existed,
    // or before a future addition to it) can never be served once a newer policy is deployed —
    // an explicit guarantee, not a reliance on this Function's in-memory cache happening to reset
    // on every deploy's cold start. Applies uniformly to all four operations, including `details`
    // (whose own request `variables` never changes with EXCLUDED_GENRES — see
    // lib/anilist-operations.js's DETAILS_QUERY comment for why), so this is the one guarantee
    // that covers every operation the same way, not just the ones with genre_not_in in their
    // variables.
    const cacheKey = `${operation}:${CONTENT_FILTER_POLICY_VERSION}`;
    const cached = deps.getCached(cacheKey, variables, now.getTime());
    if (cached) {
      return jsonResponse(200, { ok: true, ...cached }, baseHeaders);
    }

    // 10. Call AniList, sanitize to the fixed allowlisted field set, cache briefly, return.
    try {
      const raw = await callAniList(deps.fetchImpl || fetch, query, variables, UPSTREAM_TIMEOUT_MS);
      const sanitized = opDef.sanitize(raw);
      deps.setCached(cacheKey, variables, sanitized, now.getTime());
      return jsonResponse(200, { ok: true, ...sanitized }, baseHeaders);
    } catch (err) {
      if (err instanceof UpstreamError) {
        console.error(`[anilist] upstream call failed: code=${err.code}`);
        if (err.code === "timeout") return jsonResponse(504, { ok: false, error: "anilist_upstream_timeout" }, baseHeaders);
        return jsonResponse(502, { ok: false, error: "anilist_upstream_error" }, baseHeaders);
      }
      console.error("[anilist] unexpected error:", err && err.message);
      return jsonResponse(500, { ok: false, error: "anilist_internal_error" }, baseHeaders);
    }
  };
}

// ---- Production wiring (firebase-admin only loaded/initialized here, never in the handler
// factory above, so tests never need it installed to exercise business logic) ----

function buildProductionDeps() {
  const { initializeApp, cert, getApps, getApp } = require("firebase-admin/app");
  const { getAuth } = require("firebase-admin/auth");
  const { getFirestore } = require("firebase-admin/firestore");
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

  // DEPLOY_PRIME_URL/DEPLOY_URL are not in process.env at Function runtime (confirmed against
  // Netlify's own docs — see lib/deploy-origin.js's header comment), so this reads the build-time
  // snapshot instead. Computed once per cold start (these values never change for the lifetime of
  // a deployed Function instance), same as every other env value below. `process.env.DEPLOY_*` is
  // still checked first and preferred if it's ever actually present — a forward-compatible
  // fallback order, not a claim that it currently is.
  const generatedDeployOrigins = readGeneratedDeployOrigins();
  const env = {
    ...process.env,
    DEPLOY_PRIME_URL: process.env.DEPLOY_PRIME_URL || generatedDeployOrigins.deployPrimeUrl || undefined,
    DEPLOY_URL: process.env.DEPLOY_URL || generatedDeployOrigins.deployUrl || undefined,
  };

  return {
    env,
    now: () => new Date(),
    ensureFirebaseAdmin: async () => { ensureApp(); },
    verifyIdToken: (token) => getAuth(ensureApp()).verifyIdToken(token, true),
    getUserDoc: async (uid) => {
      const snap = await getFirestore(ensureApp()).collection("users").doc(uid).get();
      return snap.exists ? snap.data() : null;
    },
    checkBurst,
    getCached,
    setCached,
    fetchImpl: undefined, // use global fetch
  };
}

exports.handler = createHandler(buildProductionDeps());
exports.createHandler = createHandler; // exported for tests only
