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
const { FirebaseConfigError } = require("./lib/firebase-admin");
const { buildDateContext, DEFAULT_TIME_ZONE } = require("./lib/date-utils");

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

// `dateContext` is the ONLY source of truth for "today" this prompt gives the model — see
// lib/date-utils.js's header comment for the production incident (relative phrases like "this
// month"/"June" resolving against a hallucinated year) this directly fixes. The model is never
// told to compute a date range itself for a relative phrase when a tool offers `relativePeriod`
// — that math happens deterministically in lib/date-utils.js instead (see list_calendar/
// list_journey's tool descriptions), which is what makes it fixable and testable at all.
function systemPrompt(scopes, dateContext) {
  const scopeList = scopes.length ? scopes.join(", ") : "(none selected — no personal-data tools are available this turn)";
  return [
    "You are the EdenAtlas Atlas Assistant, a private, read-only helper for the app's Owner only.",
    "You can only use the provided tools to look up the Owner's own data; you have no ability to create, edit, delete, publish, or share anything — if asked to perform an action, explain that write actions are not enabled in this version and offer a draft instead where relevant.",
    `The Owner has enabled these data scopes for this conversation: ${scopeList}. Never claim to use a scope that isn't listed.`,
    // --- Scope authority (scope-change conversation isolation pass) — fixes a real production
    // gap: after the Owner re-enabled a scope that was previously off, Qwen kept answering "I
    // still don't have access," apparently trusting an earlier turn's own "no access" statement
    // over the CURRENT scope list above. The frontend now also starts a clean conversation on
    // every scope change (so this stale-history case should rarely even reach the model anymore),
    // but this instruction is the server-side backstop for any older history that still slips
    // through, and for the reverse direction (a scope that just got turned off). ---
    "The scope list above is the ONLY authoritative statement of what you may use RIGHT NOW — it reflects the Owner's current selection for this exact request, not any earlier one. Any earlier message in this conversation (yours or the Owner's) claiming which scopes were enabled, disabled, or inaccessible may be STALE and must NEVER override the scope list above: if a scope is listed as enabled above, you must use it even if an earlier turn said you had no access to it; if a scope is NOT listed above, you must never use it or claim to have used it, even if an earlier turn in this same conversation did.",
    "Never invent facts about the Owner's data — only state things a tool result actually returned. If a tool returns no results, say so plainly.",
    // --- Per-turn tool evidence (trust/provenance pass) — fixes a real production gap: a
    // follow-up like "if June?" was sometimes answered from the previous turn's remembered
    // result instead of a fresh tool call, so no source chip could ever be shown for it. ---
    "Every fact you state about the Owner's own Memories, Journal, Journey, or Calendar must come from a tool call made in THIS turn — a previous answer earlier in this conversation is never sufficient evidence for a new question, even a closely related one (e.g. \"what about June?\" right after you answered about July). Whenever the Owner asks about a different date range, place, or topic than your most recent tool call actually covered, call the appropriate tool again before answering — never reuse an earlier turn's tool result for a new range or query.",
    "If you do not call a tool during this turn, never say you \"searched,\" \"checked,\" \"looked through,\" or \"found\" anything in the Owner's records — those words are only true the moment a tool actually ran. In that case, either answer only from what's already visible in this conversation, or ask a short clarifying question instead.",
    "Keep answers concise and cite which Memories/Journal entries/Journey events you used when relevant.",
    // --- Authoritative date context (task A/B) ---
    `Authoritative current date: currentLocalDate=${dateContext.currentLocalDate}, currentYear=${dateContext.currentYear}, currentMonth=${dateContext.currentMonth}, timeZone=${dateContext.timeZone}.`,
    "This is ground truth for \"today\" — never use your own training data, a provider clock, or an assumed year for any relative date phrase (\"this month,\" \"last month,\" \"June,\" \"recently,\" etc). If the Owner gives an explicit date or year (e.g. \"June 2024\"), that explicit value always wins over any relative-phrase resolution.",
    "For list_calendar/list_journey, prefer their relativePeriod parameter over computing startDate/endDate yourself whenever the Owner used a relative phrase — it is resolved deterministically from currentLocalDate server-side, so you cannot get the year wrong by using it. A bare month name with no year (e.g. \"June\") means the most recent occurrence not after currentLocalDate; only set direction=\"forward\" when the wording clearly means upcoming/next (e.g. \"next June,\" \"this coming December\"). If a date phrase is genuinely ambiguous even with this rule, ask one short clarifying question instead of guessing a year.",
    "Never claim an item is in the past or future without actually comparing its date to currentLocalDate.",
    // --- Calendar semantics (task C) ---
    "list_calendar and list_journey summarize an ACTIVITY calendar, not a scheduling system: memories' dates are uploadedAt (when the Memory was uploaded) and journals' dates are createdAt (when the entry was written) — never a planned/future event time. Describe these records as \"recorded,\" \"uploaded,\" or \"created.\" NEVER describe them as \"scheduled,\" \"pre-scheduled,\" \"a placeholder,\" or \"added in advance\" — no field in this data means that, and using that language would misrepresent what was actually stored. Finance/expenses are never included in any calendar or journey summary.",
    "When you report on a date range, state the actual range you searched (a tool's resolvedRange, if present) so the Owner can see exactly what was covered.",
    // --- Language (task H) ---
    "Respond in the same language the Owner's message is written in — if it's in Chinese, answer in Chinese; if it's in English, answer in English. Never translate or alter the Owner's own stored titles, captions, tags, or place names — quote them as stored.",
    // --- Output formatting ---
    "Write plain, simple prose and short bullet lists only. Do not use Markdown heading syntax, tables, or nested formatting — the client renders plain paragraphs and single-level lists only.",
  ].join(" ");
}

// The ONLY place this file logs anything about an auth/config failure. Reveals exactly two
// things: which of the four stages failed (json_parse | credential_validation |
// admin_initialization | token_verification) and a short, safe error code — never the raw JSON,
// client_email, private_key, token, Authorization header, or any other environment value. A
// FirebaseConfigError already carries a safe `.code` (see lib/firebase-admin.js); a real
// Firebase Auth error's `.code` (e.g. "auth/id-token-expired") is equally safe to log — it's a
// fixed SDK enum, never derived from the token's own contents.
function logAuthStageFailure(stage, err) {
  const code = (err && err.code) || "no_code";
  console.error(`[assistant] auth stage failed: stage=${stage} code=${code}`);
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

    // 2. Firebase Admin initialization boundary — deliberately its own step, run for every
    // caller before origin/method/auth, and deliberately NOT inside the token-verification try/
    // catch below. This is the fix for two stacked production incidents: (1) parsing/validating
    // FIREBASE_SERVICE_ACCOUNT and initializing the Admin app used to happen lazily inside
    // verifyIdToken(), so any failure there got caught by the same catch block as an actual
    // invalid token and reported as 401 invalid_or_expired_token; (2) after that was fixed, this
    // file was still calling firebase-admin's removed legacy namespace API
    // (`require("firebase-admin")`'s `.apps`/`.app()`/etc.), which v14 no longer supports —
    // `buildProductionDeps()` below now uses only the v14 modular entry points
    // (`firebase-admin/app`, `firebase-admin/auth`, `firebase-admin/firestore`). See
    // netlify/functions/lib/firebase-admin.js for the full history and the parsing/normalization
    // logic itself.
    try {
      await deps.ensureFirebaseAdmin();
    } catch (err) {
      logAuthStageFailure(err instanceof FirebaseConfigError ? err.stage : "admin_initialization", err);
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

    // 3. Authenticate — derive uid from a server-verified Firebase ID token only. By this point
    // Firebase Admin is already known-initialized (step 2 above already returned 500 otherwise),
    // so the only way deps.verifyIdToken() can now fail is a genuine token problem (missing,
    // expired, revoked, malformed, wrong audience/issuer) — that is the ONLY case that may ever
    // produce a 401 here. The FirebaseConfigError branch below is defense-in-depth only (it
    // should be unreachable given step 2 already succeeded) — if it somehow still fires, it must
    // still be reported as a config failure (500), never mis-classified as a bad token (401).
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
        return jsonResponse(500, { ok: false, error: "assistant_not_configured" }, baseHeaders);
      }
      logAuthStageFailure("token_verification", err);
      return jsonResponse(401, { ok: false, error: "invalid_or_expired_token" }, baseHeaders);
    }
    if (!decoded || !decoded.uid) {
      logAuthStageFailure("token_verification", null);
      return jsonResponse(401, { ok: false, error: "invalid_or_expired_token" }, baseHeaders);
    }
    const uid = decoded.uid;

    // 4. Authorize — Owner only. Two independent signals that must BOTH agree, not an "either
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

    // 5. Validate the request body.
    const validated = validateRequestBody(event.body);
    if (validated.error) {
      return jsonResponse(400, { ok: false, error: validated.error }, baseHeaders);
    }
    const { message, history, scopes } = validated.value;

    // 6. Rate/cost protection. Burst guard first (cheap, no Firestore round trip); the durable
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

    // 7. Run the bounded, read-only tool-calling agent loop against Qwen. `now` is the exact
    // same server clock reading already used for rate limiting above (never a second, possibly-
    // different `new Date()` call) — one authoritative "now" per request, threaded everywhere.
    const timeZone = DEFAULT_TIME_ZONE;
    const dateContext = buildDateContext(now, timeZone);
    try {
      const result = await runAgentLoop({
        qwenConfig: { baseUrl: env.QWEN_BASE_URL, apiKey: env.DASHSCOPE_API_KEY, model: env.QWEN_MODEL },
        systemPrompt: systemPrompt(scopes, dateContext),
        history,
        userMessage: message,
        scopes,
        now,
        timeZone,
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
          // Server-generated, non-model-controlled evidence summary (see qwen.js's
          // createProvenanceTracker) — the frontend's evidence row is built from this object
          // only, never from `answer`'s free text.
          provenance: result.provenance,
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
  // firebase-admin v14 removed legacy namespace support (`require("firebase-admin")`'s
  // `.apps`/`.app()`/`.initializeApp()`/`.credential.cert()`/`.auth()`/`.firestore()` no longer
  // exist in the shape this code used to assume — see lib/firebase-admin.js's header comment for
  // the production incident this caused). Every Admin SDK call in this file goes through the v14
  // modular entry points instead — never a bare `require("firebase-admin")`.
  const { initializeApp, cert, getApps, getApp } = require("firebase-admin/app");
  const { getAuth } = require("firebase-admin/auth");
  const { getFirestore } = require("firebase-admin/firestore");
  const { initializeFirebaseAdmin } = require("./lib/firebase-admin");
  let app = null; // memoized ONLY on success — see ensureApp()'s comment

  // Once per warm Function instance: the first successful call caches `app` and every later
  // call (this request or a later one on the same warm instance) returns it instantly with no
  // re-parsing/re-validation. A FAILED attempt is deliberately not cached — a later request on
  // the same warm instance is allowed to retry (e.g. if a Netlify env var change takes effect
  // without a full cold start), and each retry still goes through the exact same classified
  // parseServiceAccount()/initializeApp() path, never a weaker fallback. Named `ensureApp`, not
  // `getApp`, specifically so it can't be confused with (or accidentally shadow) the modular
  // `getApp` imported from `firebase-admin/app` above.
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
    // The dedicated initialization boundary (see assistant.js's handler, step 2, and
    // lib/firebase-admin.js) — throws a classified FirebaseConfigError on failure, never
    // reaches or is reachable from verifyIdToken().
    ensureFirebaseAdmin: async () => { ensureApp(); },
    verifyIdToken: (token) => getAuth(ensureApp()).verifyIdToken(token, true),
    getUserDoc: async (uid) => {
      const snap = await getFirestore(ensureApp()).collection("users").doc(uid).get();
      return snap.exists ? snap.data() : null;
    },
    getDb: () => getFirestore(ensureApp()),
    fetchImpl: undefined, // use global fetch
  };
}

exports.handler = createHandler(buildProductionDeps());
exports.createHandler = createHandler; // exported for tests only
