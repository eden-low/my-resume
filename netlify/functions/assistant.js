// EdenAtlas Atlas Assistant — Owner-only, read-only Qwen-powered AI Function.
//
// Production route: /.netlify/functions/assistant (see netlify.toml — this file's *source*
// lives at netlify/functions/assistant.js, which is structurally excluded from the static
// publish output by scripts/build-site.js; only the deployed Function endpoint is reachable).
//
// This module intentionally never `require()`s any of this repo's browser ES modules
// (firebase-init.js, js/i18n.js, js/memory-filters.js, js/location-fields.js, etc.) — those use
// `export`/`import` syntax and are loaded by the browser as ES modules straight from source, but
// this Function runs under plain Node CommonJS with no "type":"module" declaration (see
// package.json's comment). Any small predicate this file needs from those modules (trashed-post
// filtering, coordinate validation) is duplicated locally in netlify/functions/lib/tools.js,
// matching this codebase's own established per-file duplication convention rather than inventing
// a new cross-runtime import mechanism for a handful of one-line functions.
//
// Security model (see docs/ai-architecture.md for the full design doc this implements):
//   1. The browser sends the current Firebase ID token as `Authorization: Bearer <token>`.
//   2. This Function verifies that token server-side via Firebase Admin — the UID it acts on is
//      ALWAYS the one decoded from that verified token, never anything the request body claims.
//   3. It then re-reads `users/{uid}` via Firebase Admin (which bypasses firestore.rules
//      entirely) and requires `role === "owner"` AND the token's email to match the same
//      hardcoded OWNER_EMAIL constant firebase-init.js uses client-side — two independent
//      signals, so a stale/incorrect `role` field alone can never grant access.
//   4. Every Firestore read a tool performs is hardcoded to `where("uid","==",<verified uid>)`
//      against one fixed collection name — see lib/tools.js. The model never supplies a
//      collection name, document path, uid, or raw query operator.
//   5. No write path exists anywhere in this file or lib/tools.js. This is v1: read-only.

const { runAgentLoop, QwenError } = require("./lib/qwen");
const { checkBurst, checkAndIncrementDailyUsage } = require("./lib/rate-limit");

// Duplicated from firebase-init.js's OWNER_EMAIL on purpose (see that file's own comment) — this
// Function has no way to import a browser ES module, and re-deriving "who is the Owner" from
// two independent hardcoded sources (this constant + the `role` field on users/{uid}) is a
// deliberate defense-in-depth choice: a bug that wrongly sets `role: "owner"` on some other
// account still can't pass this second check.
const OWNER_EMAIL = "jjun8647@gmail.com";

const REQUIRED_ENV = [
  "FIREBASE_PROJECT_ID",
  "FIREBASE_SERVICE_ACCOUNT",
  "DASHSCOPE_API_KEY",
  "QWEN_MODEL",
  "QWEN_BASE_URL",
  "ALLOWED_ORIGIN",
];

// Common local dev server ports for this repo's documented "Running locally" workflows
// (README.md): Netlify Dev's default (8888), `npx serve .`'s default (3000), and Python's
// `http.server` default (8000). Production is always read from the ALLOWED_ORIGIN env var —
// never hardcoded here — this list only ever adds narrowly-scoped localhost exceptions.
const LOCAL_DEV_ORIGINS = [
  "http://localhost:8888", "http://127.0.0.1:8888",
  "http://localhost:3000", "http://127.0.0.1:3000",
  "http://localhost:8000", "http://127.0.0.1:8000",
];

const MAX_MESSAGE_LEN = 2000;
const MAX_HISTORY_ITEMS = 20;
const MAX_HISTORY_ITEM_LEN = 2000;
const MAX_BODY_BYTES = 24_000; // generous for ~20 history turns + one message, still bounded
const KNOWN_SCOPES = ["memories", "journal", "journey", "calendar"];

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

function validateRequestBody(raw) {
  if (typeof raw !== "string" || raw.length === 0) return { error: "empty_request_body" };
  if (raw.length > MAX_BODY_BYTES) return { error: "request_too_large" };
  const parsed = safeJsonParse(raw);
  if (!parsed.ok || typeof parsed.value !== "object" || parsed.value === null) {
    return { error: "invalid_json" };
  }
  const body = parsed.value;

  if (typeof body.message !== "string" || !body.message.trim()) return { error: "message_required" };
  if (body.message.length > MAX_MESSAGE_LEN) return { error: "message_too_long" };

  let history = [];
  if (body.history !== undefined) {
    if (!Array.isArray(body.history)) return { error: "history_must_be_array" };
    if (body.history.length > MAX_HISTORY_ITEMS) return { error: "history_too_long" };
    for (const item of body.history) {
      if (!item || (item.role !== "user" && item.role !== "assistant")) return { error: "invalid_history_item" };
      if (typeof item.content !== "string" || item.content.length > MAX_HISTORY_ITEM_LEN) return { error: "invalid_history_item" };
    }
    history = body.history.map((h) => ({ role: h.role, content: h.content }));
  }

  let scopes = [];
  if (body.scopes !== undefined) {
    if (!Array.isArray(body.scopes)) return { error: "scopes_must_be_array" };
    if (!body.scopes.every((s) => KNOWN_SCOPES.includes(s))) return { error: "unknown_scope" };
    scopes = [...new Set(body.scopes)];
  }

  return { value: { message: body.message.trim(), history, scopes } };
}

function systemPrompt(scopes) {
  const scopeList = scopes.length ? scopes.join(", ") : "(none selected — no personal-data tools are available this turn)";
  return [
    "You are the EdenAtlas Atlas Assistant, a private, read-only helper for the app's Owner only.",
    "You can only use the provided tools to look up the Owner's own data; you have no ability to create, edit, delete, publish, or share anything — if asked to perform an action, explain that write actions are not enabled in this version and offer a draft instead where relevant.",
    `The Owner has enabled these data scopes for this conversation: ${scopeList}. Never claim to use a scope that isn't listed.`,
    "Never invent facts about the Owner's data — only state things a tool result actually returned. If a tool returns no results, say so plainly.",
    "Keep answers concise and cite which Memories/Journal entries/Journey events you used when relevant.",
  ].join(" ");
}

function sanitizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const out = {};
  if (Number.isFinite(usage.prompt_tokens)) out.promptTokens = usage.prompt_tokens;
  if (Number.isFinite(usage.completion_tokens)) out.completionTokens = usage.completion_tokens;
  if (Number.isFinite(usage.total_tokens)) out.totalTokens = usage.total_tokens;
  return Object.keys(out).length ? out : null;
}

// `deps` is fully injectable so this handler is unit-testable without firebase-admin, a real
// Qwen endpoint, or network access — see netlify/functions/__tests__/assistant.test.js. The
// production wiring at the bottom of this file supplies the real implementations.
function createHandler(deps) {
  return async function handler(event) {
    const env = deps.env || process.env;
    const method = event.httpMethod;

    // 1. Fail closed on missing configuration — checked before anything else, including
    // method/origin/auth, so a misconfigured deploy behaves identically (and safely) for every
    // caller rather than leaking partial functionality.
    const missing = REQUIRED_ENV.filter((k) => !env[k]);
    if (missing.length) {
      console.error("[assistant] missing required environment variables:", missing.join(","));
      return jsonResponse(500, { ok: false, error: "assistant_not_configured" });
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

    // 2. Authenticate — derive uid from a server-verified Firebase ID token only.
    const authHeader = getHeader(event, "authorization") || "";
    const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    if (!match) {
      return jsonResponse(401, { ok: false, error: "missing_bearer_token" }, baseHeaders);
    }
    let decoded;
    try {
      decoded = await deps.verifyIdToken(match[1]);
    } catch (err) {
      console.error("[assistant] token verification failed:", err && err.code);
      return jsonResponse(401, { ok: false, error: "invalid_or_expired_token" }, baseHeaders);
    }
    if (!decoded || !decoded.uid) {
      return jsonResponse(401, { ok: false, error: "invalid_or_expired_token" }, baseHeaders);
    }
    const uid = decoded.uid;

    // 3. Authorize — Owner only. Two independent signals that must BOTH agree, not an "either
    // will do" OR: the server-verified token's own email (decoded.email — cryptographically
    // attested by Firebase Admin, not client-suppliable) AND the users/{uid} directory doc's
    // `role`/`email` fields. Using OR here would have been a real gap — a bug that wrongly wrote
    // role:"owner" (and the real Owner's email) onto some *other* uid's users/{uid} doc would
    // then only need ONE of the two signals to line up, defeating the point of having two.
    let userDoc;
    try {
      userDoc = await deps.getUserDoc(uid);
    } catch (err) {
      console.error("[assistant] users/{uid} read failed:", err && err.code);
      return jsonResponse(500, { ok: false, error: "profile_lookup_failed" }, baseHeaders);
    }
    const isOwner = !!userDoc && userDoc.role === "owner" && decoded.email === OWNER_EMAIL && userDoc.email === OWNER_EMAIL;
    if (!isOwner) {
      return jsonResponse(403, { ok: false, error: "owner_only" }, baseHeaders);
    }

    // 4. Validate the request body.
    const validated = validateRequestBody(event.body);
    if (validated.error) {
      return jsonResponse(400, { ok: false, error: validated.error }, baseHeaders);
    }
    const { message, history, scopes } = validated.value;

    // 5. Rate/cost protection. Burst guard first (cheap, no Firestore round trip); the durable
    // daily cap is the real limiter — see lib/rate-limit.js's header comment.
    const now = deps.now ? deps.now() : new Date();
    const burst = checkBurst(uid, now.getTime());
    if (!burst.allowed) {
      return jsonResponse(
        429,
        { ok: false, error: "rate_limited", scope: "burst", retryAfterMs: burst.retryAfterMs },
        { ...baseHeaders, "Retry-After": String(Math.ceil(burst.retryAfterMs / 1000)) }
      );
    }
    let db;
    try {
      db = deps.getDb();
    } catch (err) {
      console.error("[assistant] Firestore Admin unavailable:", err && err.message);
      return jsonResponse(500, { ok: false, error: "assistant_not_configured" }, baseHeaders);
    }
    let daily;
    try {
      daily = await checkAndIncrementDailyUsage(db, uid, { now });
    } catch (err) {
      console.error("[assistant] rate limit check failed:", err && err.message);
      return jsonResponse(500, { ok: false, error: "rate_limit_unavailable" }, baseHeaders);
    }
    if (!daily.allowed) {
      return jsonResponse(429, { ok: false, error: "rate_limited", scope: "daily", limit: daily.limit }, baseHeaders);
    }

    // 6. Run the bounded, read-only tool-calling agent loop against Qwen.
    try {
      const result = await runAgentLoop({
        qwenConfig: { baseUrl: env.QWEN_BASE_URL, apiKey: env.DASHSCOPE_API_KEY, model: env.QWEN_MODEL },
        systemPrompt: systemPrompt(scopes),
        history,
        userMessage: message,
        scopes,
        db,
        uid,
        fetchImpl: deps.fetchImpl,
      });
      return jsonResponse(
        200,
        {
          ok: true,
          answer: result.answer,
          sources: result.sources,
          usage: sanitizeUsage(result.usage),
          roundsUsed: result.roundsUsed,
        },
        baseHeaders
      );
    } catch (err) {
      if (err instanceof QwenError) {
        console.error("[assistant] Qwen call failed:", err.message);
        return jsonResponse(502, { ok: false, error: "assistant_upstream_error" }, baseHeaders);
      }
      console.error("[assistant] unexpected error:", err && err.message);
      return jsonResponse(500, { ok: false, error: "assistant_internal_error" }, baseHeaders);
    }
  };
}

// ---- Production wiring (firebase-admin only loaded/initialized here, never in the handler
// factory above, so tests never need it installed to exercise business logic) ----

function buildProductionDeps() {
  const admin = require("firebase-admin");
  let app = null;

  function getApp() {
    if (app) return app;
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    let serviceAccount;
    try {
      serviceAccount = JSON.parse(raw);
    } catch {
      throw new Error("FIREBASE_SERVICE_ACCOUNT is not valid JSON");
    }
    app = admin.apps.length ? admin.app() : admin.initializeApp({ credential: admin.credential.cert(serviceAccount), projectId });
    return app;
  }

  return {
    env: process.env,
    now: () => new Date(),
    verifyIdToken: (token) => admin.auth(getApp()).verifyIdToken(token, true),
    getUserDoc: async (uid) => {
      const snap = await admin.firestore(getApp()).collection("users").doc(uid).get();
      return snap.exists ? snap.data() : null;
    },
    getDb: () => admin.firestore(getApp()),
    fetchImpl: undefined, // use global fetch
  };
}

exports.handler = createHandler(buildProductionDeps());
exports.createHandler = createHandler; // exported for tests only
