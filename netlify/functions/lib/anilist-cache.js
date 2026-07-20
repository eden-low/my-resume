// EdenAtlas Discover — short-lived, bounded, in-memory response cache. NOT a catalog mirror.
//
// Exists only to avoid hitting AniList twice for the exact same operation+variables within a
// short window (e.g. reloading "This Season" moments after the last load). Module-scope, so it
// resets on every cold start — same shape as netlify/functions/lib/rate-limit.js's `burstState`
// — and capped at a small entry count with oldest-first eviction, so it can never grow into
// anything resembling a stored copy of the catalog (the product direction this exists to respect:
// "do not bulk-copy or hoard the AniList catalog").

const TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ENTRIES = 40;

const store = new Map(); // "<operation>:<JSON variables>" -> { value, expiresAt }

function makeKey(operation, variables) {
  return `${operation}:${JSON.stringify(variables)}`;
}

function getCached(operation, variables, now = Date.now()) {
  const key = makeKey(operation, variables);
  const hit = store.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt <= now) {
    store.delete(key);
    return undefined;
  }
  return hit.value;
}

function setCached(operation, variables, value, now = Date.now()) {
  const key = makeKey(operation, variables);
  if (store.size >= MAX_ENTRIES && !store.has(key)) {
    const oldestKey = store.keys().next().value;
    if (oldestKey !== undefined) store.delete(oldestKey);
  }
  store.set(key, { value, expiresAt: now + TTL_MS });
}

// Only for deterministic tests — production code never calls this.
function _resetCacheForTests() {
  store.clear();
}

module.exports = { getCached, setCached, _resetCacheForTests, TTL_MS, MAX_ENTRIES };
