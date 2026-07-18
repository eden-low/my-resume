// Firebase Admin initialization boundary — deliberately separate from ID-token verification.
//
// Root cause #1 (first production incident): the previous version of
// netlify/functions/assistant.js called a lazy `getApp()` *inside* `verifyIdToken()`, and the
// handler wrapped that whole call in one try/catch that mapped ANY thrown error to
// `401 invalid_or_expired_token`. That meant malformed JSON, a missing service-account field, a
// mis-escaped private key, or `initializeApp()` itself throwing — none of which have anything to
// do with whether a given ID token is valid — all surfaced as "the token is invalid or expired."
// Fixed by giving initialization its own boundary (this file) with classified errors.
//
// Root cause #2 (second production incident, after root cause #1 was fixed): this file and
// netlify/functions/assistant.js were still written against firebase-admin's LEGACY namespace
// API (`require("firebase-admin")`, `admin.apps`, `admin.app()`, `admin.initializeApp()`,
// `admin.credential.cert()`, `admin.auth()`, `admin.firestore()`) while package.json installs
// firebase-admin ^14.2.0 — and v14 removed legacy namespace support entirely. Confirmed directly
// against the actual installed package (not assumed): `require("firebase-admin").apps` is
// `undefined` in v14, so the very first line of the old `initializeFirebaseAdmin()` —
// `if (admin.apps.length) return admin.app();` — threw a plain `TypeError` (no `.code`) reading
// `.length` off `undefined`, *before* any service-account parsing or validation ever ran. That
// TypeError propagated up uncaught by the `try/catch` around `initializeApp()` (which starts
// after that line) and was classified generically as `stage=admin_initialization code=no_code` —
// which is exactly what production logged. This file is now written entirely against v14's
// modular entry points (`firebase-admin/app`, `firebase-admin/auth`, `firebase-admin/firestore`)
// instead — see `initializeFirebaseAdmin()`'s parameters below, which take the specific modular
// functions (`getApps`, `getApp`, `initializeApp`, `cert`) as arguments rather than a legacy
// `admin` namespace object, so this module never touches a removed API again and stays testable
// (real modular functions from the installed package in production, injectable fakes in tests —
// see netlify/functions/__tests__/assistant.test.js's "real package" smoke test, which is what
// actually caught this class of bug: the old mock's fake `admin.apps` array papered over the
// real package's incompatibility).
//
// This module's only job is turning `FIREBASE_SERVICE_ACCOUNT` + `FIREBASE_PROJECT_ID` into an
// initialized Admin app, failing with a *classified* error (one of the three stages below) when
// it can't — never silently, never disguised as a token-verification failure. It never calls
// `getAuth(app).verifyIdToken()` at all; that call happens only in assistant.js, after this
// module has already succeeded.

const crypto = require("node:crypto");

const STAGES = ["json_parse", "credential_validation", "admin_initialization"];

class FirebaseConfigError extends Error {
  constructor(message, stage, code) {
    super(message);
    this.name = "FirebaseConfigError";
    this.stage = stage; // one of STAGES above — never "token_verification", that's a different error type entirely
    this.code = code || "no_code"; // short, safe-to-log enum; never derived from raw SDK error text
  }
}

const REQUIRED_FIELDS = ["project_id", "client_email", "private_key"];

// Parses + validates the raw FIREBASE_SERVICE_ACCOUNT env var. Never logs or returns the raw
// string, the parsed object, or any field value to a caller that might log it — callers get
// either a validated object back or a FirebaseConfigError with no credential material in it.
function parseServiceAccount(raw, expectedProjectId) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new FirebaseConfigError("FIREBASE_SERVICE_ACCOUNT is empty", "json_parse", "config/empty");
  }

  // Trim surrounding whitespace only — a trailing newline/space from a copy-paste into an env
  // var UI is a real, common failure mode and is always safe to strip; nothing inside the JSON
  // value itself is touched here.
  const trimmed = raw.trim();

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new FirebaseConfigError("FIREBASE_SERVICE_ACCOUNT is not valid JSON", "json_parse", "config/invalid-json");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new FirebaseConfigError("FIREBASE_SERVICE_ACCOUNT did not parse into an object", "json_parse", "config/not-an-object");
  }

  for (const field of REQUIRED_FIELDS) {
    if (typeof parsed[field] !== "string" || !parsed[field].trim()) {
      throw new FirebaseConfigError(
        "FIREBASE_SERVICE_ACCOUNT is missing a required field",
        "credential_validation",
        "config/missing-field"
      );
    }
  }

  if (expectedProjectId && parsed.project_id !== expectedProjectId) {
    throw new FirebaseConfigError(
      "FIREBASE_SERVICE_ACCOUNT project_id does not match FIREBASE_PROJECT_ID",
      "credential_validation",
      "config/project-mismatch"
    );
  }

  // Common failure mode for a multi-line PEM pasted through an env-var UI: the real newline
  // escape sequences (`\n`, two characters — which JSON.parse already turns into actual newline
  // bytes on its own) get double-escaped somewhere upstream, surviving as literal backslash-n
  // *text* inside the parsed string instead of a real line break. A healthy key already has no
  // literal "\n" text left after JSON.parse, so this replace is a safe no-op for it and a fix
  // for a double-escaped one either way.
  const privateKey = parsed.private_key.replace(/\\n/g, "\n");

  return { ...parsed, private_key: privateKey };
}

// Real, local, synchronous PEM validation via Node's own `crypto` module — deliberately NOT
// left to firebase-admin's modular `cert()` (from `firebase-admin/app`). Confirmed against the
// actual installed firebase-admin package (not assumed): `cert()`/`initializeApp()` do NOT
// eagerly parse or validate the private key at all — a garbage string sails through both calls
// without throwing. The key is only ever actually used later, lazily, when the SDK signs a JWT bearer
// assertion to mint an OAuth access token for a real Admin API call (Firestore reads, or
// `verifyIdToken(token, true)`'s revocation check, which needs that access token). That is
// precisely how the original production bug manifested: a malformed key caused a signing
// failure *inside* the verifyIdToken() call stack, which the old code's catch block then
// misreported as "the token is invalid," with no `auth/...` code because it was never really a
// token problem. Validating the key's PEM structure here, synchronously, with no network call,
// catches that entire failure class at the correct boundary instead.
function assertPrivateKeyIsUsable(privateKey) {
  try {
    crypto.createPrivateKey(privateKey);
  } catch {
    // Node's crypto error text can include OpenSSL diagnostic fragments — never forwarded.
    throw new FirebaseConfigError(
      "FIREBASE_SERVICE_ACCOUNT's private_key is not a usable PEM private key",
      "admin_initialization",
      "config/invalid-private-key"
    );
  }
}

// Initializes (or reuses) the Admin app for this warm Function instance, using firebase-admin
// v14's MODULAR API only. `getApps`/`getApp`/`initializeApp`/`cert` are passed in as explicit
// function arguments — normally the real ones from `require("firebase-admin/app")` (see
// assistant.js's production wiring) — rather than a legacy `admin` namespace object, both
// because that namespace no longer has the shape this code needs in v14 (see the header
// comment) and so this module stays independently testable with injectable fakes, without the
// real firebase-admin package installed.
function initializeFirebaseAdmin({ getApps, getApp, initializeApp, cert, projectId, serviceAccountRaw }) {
  if (getApps().length) return getApp();

  const serviceAccount = parseServiceAccount(serviceAccountRaw, projectId);
  assertPrivateKeyIsUsable(serviceAccount.private_key);

  try {
    return initializeApp({ credential: cert(serviceAccount), projectId });
  } catch {
    // A real PEM key passed the crypto check above but cert()/initializeApp() still rejected it
    // (e.g. a key/cert type Admin doesn't accept) — still a configuration problem, never a
    // token-verification one. The underlying SDK error is deliberately not forwarded — it can
    // include text that echoes fragments of the malformed input.
    throw new FirebaseConfigError(
      "firebase-admin failed to initialize from the provided credential",
      "admin_initialization",
      "config/init-failed"
    );
  }
}

module.exports = { FirebaseConfigError, parseServiceAccount, initializeFirebaseAdmin, STAGES };
