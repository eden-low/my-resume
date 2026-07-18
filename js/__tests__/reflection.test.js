// Deterministic tests for js/reflection.js (the real module home.html imports) plus a
// rules-logic simulation of firestore.rules' daily_reflections match block — the same
// methodology this repo's "Trash privacy fix" pass used for photos' visibility rule, since no
// Java runtime is available in this environment to run a real Firestore emulator (confirmed
// unavailable in an earlier pass — see CLAUDE.md's Production Hardening history — not assumed
// here). Run with: node js/__tests__/reflection.test.js
import assert from "node:assert";
import { reflectionDateKey, reflectionDocId, buildReflectionSavePayload } from "../reflection.js";

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

// ---- Pure helpers ----

await test("reflectionDateKey uses Asia/Kuala_Lumpur, not the instant's UTC day", () => {
  const d = new Date("2026-07-18T16:30:00.000Z"); // 00:30 MYT on the 19th
  assert.strictEqual(reflectionDateKey(d), "2026-07-19");
});

await test("reflectionDocId is deterministic: same uid + same MYT day => same ID, always", () => {
  const d1 = new Date("2026-07-19T01:00:00.000Z");
  const d2 = new Date("2026-07-19T10:00:00.000Z"); // different instant, same MYT calendar day
  assert.strictEqual(reflectionDocId("uid1", d1), reflectionDocId("uid1", d2));
  assert.strictEqual(reflectionDocId("uid1", d1), "uid1_2026-07-19");
});

await test("reflectionDocId differs across a Malaysia midnight rollover even though the UTC day hasn't changed", () => {
  const beforeRollover = new Date("2026-07-18T15:59:00.000Z"); // 23:59 MYT Jul 18
  const afterRollover = new Date("2026-07-18T16:01:00.000Z"); // 00:01 MYT Jul 19
  assert.notStrictEqual(reflectionDocId("uid1", beforeRollover), reflectionDocId("uid1", afterRollover));
});

// ---- buildReflectionSavePayload: task B (createdAt preservation) ----

await test("first save (existedBefore=false) includes both createdAt and updatedAt", () => {
  const payload = buildReflectionSavePayload({
    uid: "uid1", mood: "happy", note: "Great day", now: new Date("2026-07-19T04:00:00Z"),
    existedBefore: false, createdAtValue: "CREATED_SENTINEL", updatedAtValue: "UPDATED_SENTINEL",
  });
  assert.strictEqual(payload.createdAt, "CREATED_SENTINEL");
  assert.strictEqual(payload.updatedAt, "UPDATED_SENTINEL");
  assert.strictEqual(payload.dateKey, "2026-07-19");
  assert.strictEqual(payload.uid, "uid1");
  assert.strictEqual(payload.visibility, "private");
});

await test("later edit (existedBefore=true) omits createdAt entirely so a {merge:true} write never re-stamps it", () => {
  const payload = buildReflectionSavePayload({
    uid: "uid1", mood: "tired", note: "Edited later", now: new Date("2026-07-19T20:00:00Z"),
    existedBefore: true, createdAtValue: "CREATED_SENTINEL_SHOULD_NOT_APPEAR", updatedAtValue: "UPDATED_SENTINEL_2",
  });
  assert.ok(!("createdAt" in payload), "createdAt must not be present on an update payload");
  assert.strictEqual(payload.updatedAt, "UPDATED_SENTINEL_2");
});

await test("repeated saves on the same day always target the same dateKey regardless of existedBefore", () => {
  const now = new Date("2026-07-19T12:00:00Z");
  const first = buildReflectionSavePayload({ uid: "u", mood: "happy", note: "a", now, existedBefore: false, createdAtValue: "C", updatedAtValue: "U1" });
  const second = buildReflectionSavePayload({ uid: "u", mood: "sad", note: "b", now, existedBefore: true, createdAtValue: "C", updatedAtValue: "U2" });
  assert.strictEqual(first.dateKey, second.dateKey);
});

// ---- Rules-logic simulation: firestore.rules' daily_reflections match block ----
// match /daily_reflections/{reflectionId} {
//   allow read, update, delete: if request.auth != null && resource.data.uid == request.auth.uid;
//   allow create: if isOwner() && request.resource.data.uid == request.auth.uid;
// }
const OWNER_EMAIL = "jjun8647@gmail.com";

function isOwner(callerEmail) {
  return callerEmail === OWNER_EMAIL;
}

// Simulates Firestore's actual get()-by-ID rule evaluation: referencing `resource.data.uid` when
// the document does not exist throws (Firestore surfaces this as PERMISSION_DENIED, not
// "not found" — there is no way for a rule shaped like this to distinguish the two). This is the
// OLD, pre-fix code path (home.html's original `getDoc(doc(db,"daily_reflections", id))`).
function evaluateGetByIdReadRule(existingDoc, callerUid) {
  if (callerUid == null) throw new Error("permission-denied: request.auth == null");
  if (!existingDoc) {
    throw new Error("permission-denied: resource.data is undefined for a nonexistent document");
  }
  return existingDoc.data.uid === callerUid;
}

// Simulates the NEW query-based read: Firestore's query-rule provability check requires that
// EVERY possible result of the query already satisfies the rule for ANY caller — which holds
// here because the query itself filters uid==callerUid, so every candidate result already
// satisfies `resource.data.uid == request.auth.uid` by construction, and an empty result set is
// never an error.
function evaluateProvableQuery(allDocs, callerUid, dateKey) {
  if (callerUid == null) throw new Error("permission-denied: request.auth == null");
  return allDocs.filter((d) => d.data.uid === callerUid && d.data.dateKey === dateKey);
}

function evaluateCreateRule(callerEmail, callerUid, newDocUid) {
  if (callerEmail == null || callerUid == null) return false;
  return isOwner(callerEmail) && newDocUid === callerUid;
}

await test("[rules sim] OLD getDoc-by-ID behavior: a day with no reflection yet throws permission-denied, not a clean not-found", () => {
  assert.throws(() => evaluateGetByIdReadRule(null, "owner-uid"), /permission-denied/);
});

await test("[rules sim] OLD getDoc-by-ID behavior: an existing doc for the caller's own uid reads fine", () => {
  const doc = { data: { uid: "owner-uid", dateKey: "2026-07-19" } };
  assert.strictEqual(evaluateGetByIdReadRule(doc, "owner-uid"), true);
});

await test("[rules sim] NEW query behavior: a day with no reflection yet returns an empty array, never throws", () => {
  const result = evaluateProvableQuery([], "owner-uid", "2026-07-19");
  assert.deepStrictEqual(result, []);
});

await test("[rules sim] NEW query behavior: an existing reflection for today is returned", () => {
  const allDocs = [
    { data: { uid: "owner-uid", dateKey: "2026-07-18" } }, // yesterday, must not match
    { data: { uid: "owner-uid", dateKey: "2026-07-19" } }, // today, must match
    { data: { uid: "someone-else", dateKey: "2026-07-19" } }, // another user, must never match
  ];
  const result = evaluateProvableQuery(allDocs, "owner-uid", "2026-07-19");
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].data.dateKey, "2026-07-19");
});

await test("[rules sim] every possible query result already satisfies the read rule (query-provability), for any caller", () => {
  const allDocs = [
    { data: { uid: "owner-uid", dateKey: "2026-07-19" } },
    { data: { uid: "friend-uid", dateKey: "2026-07-19" } },
    { data: { uid: "viewer-uid", dateKey: "2026-07-19" } },
  ];
  for (const callerUid of ["owner-uid", "friend-uid", "viewer-uid", "someone-else"]) {
    const result = evaluateProvableQuery(allDocs, callerUid, "2026-07-19");
    for (const doc of result) {
      assert.strictEqual(doc.data.uid, callerUid, "a query-scoped result must always satisfy resource.data.uid == request.auth.uid");
    }
  }
});

await test("[rules sim] non-Owner cannot create a daily_reflections doc, even for their own uid", () => {
  assert.strictEqual(evaluateCreateRule("friend@example.com", "friend-uid", "friend-uid"), false);
  assert.strictEqual(evaluateCreateRule("viewer@example.com", "viewer-uid", "viewer-uid"), false);
});

await test("[rules sim] the Owner can create a daily_reflections doc for their own uid, and only their own uid", () => {
  assert.strictEqual(evaluateCreateRule(OWNER_EMAIL, "owner-uid", "owner-uid"), true);
  assert.strictEqual(evaluateCreateRule(OWNER_EMAIL, "owner-uid", "someone-else-uid"), false);
});

await test("[rules sim] a signed-out caller is rejected by both the old and new read paths", () => {
  assert.throws(() => evaluateGetByIdReadRule(null, null));
  assert.throws(() => evaluateProvableQuery([], null, "2026-07-19"));
});

// ---- Concurrent-save state machine ----
// Duplicates home.html's reflection-save handler's exact guard/state logic (per this repo's
// established test-duplication convention — see assistant.test.js's withOneRetryOn401 and
// scope-change state-machine duplicates; keep in sync with home.html if that handler changes).
// The fake `writeDoc` records every payload and resolves on demand, so overlap is controlled
// deterministically — no timers, no real Firestore.
function makeSaveHarness() {
  const state = {
    reflectionExistsToday: false,
    savingReflection: false,
    writes: [], // every payload that actually reached setDoc
  };
  let releaseWrite;
  const writeGate = () => new Promise((resolve) => { releaseWrite = resolve; });

  async function save({ mood = "happy", note = "" } = {}) {
    // mirrors: if (!user || !isOwnerRole(user) || !selectedMood || savingReflection) return;
    if (!mood || state.savingReflection) return "blocked";
    state.savingReflection = true;
    try {
      const payload = buildReflectionSavePayload({
        uid: "owner-uid", mood, note, now: new Date("2026-07-19T04:00:00Z"),
        existedBefore: state.reflectionExistsToday,
        createdAtValue: "SERVER_TS_CREATED", updatedAtValue: "SERVER_TS_UPDATED",
      });
      await state.pendingWrite; // simulates the awaited setDoc round trip
      state.writes.push(payload);
      // mirrors: await loadReflection(user) — the post-save re-query finds today's doc
      state.reflectionExistsToday = true;
      return "saved";
    } finally {
      state.savingReflection = false;
    }
  }

  return { state, save, writeGate, release: () => releaseWrite() };
}

await test("[concurrency] a second click while the first save is still in flight is blocked — exactly one write, one createdAt", async () => {
  const h = makeSaveHarness();
  h.state.pendingWrite = h.writeGate(); // first save will suspend at the setDoc await
  const first = h.save({ mood: "happy" });
  const second = await h.save({ mood: "sad" }); // fired while first is mid-flight
  assert.strictEqual(second, "blocked");
  h.release();
  assert.strictEqual(await first, "saved");
  assert.strictEqual(h.state.writes.length, 1);
  assert.strictEqual(h.state.writes[0].createdAt, "SERVER_TS_CREATED");
});

await test("[concurrency] a save AFTER the first completes goes through as an update — createdAt omitted", async () => {
  const h = makeSaveHarness();
  h.state.pendingWrite = Promise.resolve();
  assert.strictEqual(await h.save({ mood: "happy" }), "saved");
  assert.strictEqual(await h.save({ mood: "tired", note: "edited" }), "saved");
  assert.strictEqual(h.state.writes.length, 2);
  assert.ok("createdAt" in h.state.writes[0], "first save must stamp createdAt");
  assert.ok(!("createdAt" in h.state.writes[1]), "second save must never re-stamp createdAt");
});

await test("[concurrency] the Edit-button view-toggle never resets reflectionExistsToday — a save right after Edit is still an update", async () => {
  const h = makeSaveHarness();
  h.state.pendingWrite = Promise.resolve();
  await h.save({ mood: "happy" });
  // home.html's Edit button nulls currentReflection (view state) but NOT reflectionExistsToday.
  // Simulate exactly that: no change to h.state.reflectionExistsToday.
  await h.save({ mood: "grateful", note: "after edit" });
  assert.ok(!("createdAt" in h.state.writes[1]));
});

await test("[concurrency] a failed write releases the guard so the user can retry (finally-block behavior)", async () => {
  const h = makeSaveHarness();
  h.state.pendingWrite = Promise.reject(new Error("simulated firestore failure"));
  await assert.rejects(h.save({ mood: "happy" }));
  assert.strictEqual(h.state.savingReflection, false, "the in-flight flag must be cleared even on failure");
  h.state.pendingWrite = Promise.resolve();
  assert.strictEqual(await h.save({ mood: "happy" }), "saved");
  // The failed attempt never reached the write, so the retry is still the FIRST save.
  assert.strictEqual(h.state.writes.length, 1);
  assert.ok("createdAt" in h.state.writes[0]);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("\nFailures:");
  failures.forEach(({ name, err }) => console.log(`  - ${name}: ${err.message}`));
  process.exit(1);
}
