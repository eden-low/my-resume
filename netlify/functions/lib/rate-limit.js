// EdenAtlas Atlas Assistant — usage guards.
//
// Two layers, deliberately not conflated:
//
// 1. `checkAndIncrementDailyUsage` — the REAL, durable per-Owner limiter. Backed by a Firestore
//    Admin transaction against `ai_usage/{uid}_{yyyy-mm-dd}`, so it is consistent across cold
//    starts and concurrent Function invocations (unlike a plain in-memory counter, which resets
//    every cold start and is invisible to any other concurrently-running instance). This is the
//    thing that actually stops runaway Qwen spend.
// 2. `checkBurst` — an in-memory, per-instance, best-effort guard against a tight click-spam
//    burst within the same warm Function instance. It is explicitly NOT durable: a cold start
//    resets it, and a burst spread across two concurrently-invoked instances would see two
//    independent counters. It exists only to reject an obvious rapid-fire burst cheaply,
//    without paying for a Firestore transaction on every single request; it is never the sole
//    protection layer, and must not be described as one — the daily transaction above is.

const DAILY_LIMIT = 50; // requests/day for the one Owner account this endpoint ever serves
const BURST_LIMIT = 5;
const BURST_WINDOW_MS = 60_000;

const burstState = new Map(); // uid -> timestamps[] (module-scope: reset on every cold start)

function checkBurst(uid, now = Date.now()) {
  const recent = (burstState.get(uid) || []).filter((t) => now - t < BURST_WINDOW_MS);
  if (recent.length >= BURST_LIMIT) {
    burstState.set(uid, recent);
    return { allowed: false, retryAfterMs: BURST_WINDOW_MS - (now - recent[0]) };
  }
  recent.push(now);
  burstState.set(uid, recent);
  return { allowed: true };
}

// Only for deterministic tests — production code never calls this.
function _resetBurstStateForTests() {
  burstState.clear();
}

async function checkAndIncrementDailyUsage(db, uid, { limit = DAILY_LIMIT, now = new Date() } = {}) {
  const dayKey = now.toISOString().slice(0, 10);
  const ref = db.collection("ai_usage").doc(`${uid}_${dayKey}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists ? Number(snap.data().count || 0) : 0;
    if (current >= limit) {
      return { allowed: false, count: current, limit, dayKey };
    }
    tx.set(ref, { uid, day: dayKey, count: current + 1, updatedAt: now.toISOString() }, { merge: true });
    return { allowed: true, count: current + 1, limit, dayKey };
  });
}

module.exports = {
  checkBurst,
  checkAndIncrementDailyUsage,
  _resetBurstStateForTests,
  DAILY_LIMIT,
  BURST_LIMIT,
  BURST_WINDOW_MS,
};
