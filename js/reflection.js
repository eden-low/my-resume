// EdenAtlas — Daily Reflection: pure, Firebase-SDK-free helpers shared between home.html's
// inline module (the real write path) and this repo's deterministic tests (js/__tests__/
// reflection.test.js). Kept separate from js/date-utils.js so the "what does a save payload
// look like" logic can be unit-tested with zero Firestore/Firebase Auth dependency — the caller
// (home.html) supplies the actual `serverTimestamp()` sentinel values.
//
// Production Hardening Phase 1, part A/B:
//   - The old code read today's reflection via a direct getDoc() on the deterministic
//     `${uid}_${dateKey}` document ID. When no reflection exists yet for today, that document
//     doesn't exist, so firestore.rules' `resource.data.uid == request.auth.uid` check
//     references `resource.data` on a null `resource` — Firestore reports this as
//     PERMISSION_DENIED, not "not found" (there is no way to distinguish the two from a bare
//     get() against a rule shaped like this one). Fixed by querying instead of getting by ID —
//     `where("uid","==",myUid), where("dateKey","==",<today>), limit(1)` is directly provable
//     against that same rule (every possible result already satisfies
//     `resource.data.uid == request.auth.uid` by construction of the query filter), so an empty
//     day now returns a clean empty snapshot.
//   - The old save always included `createdAt: serverTimestamp()` in a `{merge:true}` write,
//     which re-stamps `createdAt` on every edit (merge overwrites any field you explicitly
//     include, it does not skip fields that already exist). `buildReflectionSavePayload()` below
//     only includes `createdAt` when `existedBefore` is false — home.html derives that flag from
//     the query result itself (a separate `reflectionExistsToday` flag, deliberately NOT reset by
//     the Edit button's own view-toggle — editing an existing reflection must never look like a
//     first-time create).
import { localDateString, DEFAULT_TIME_ZONE } from "./date-utils.js";

// The Malaysia-local calendar-day key this collection's documents are keyed by — independent of
// the caller's own device/browser/Netlify-edge timezone.
export function reflectionDateKey(now = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  return localDateString(now, timeZone);
}

// The canonical, deterministic document ID — one document per uid per Malaysia-local day, so a
// same-day re-save is always a merge onto the same document, never a duplicate.
export function reflectionDocId(uid, now = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  return `${uid}_${reflectionDateKey(now, timeZone)}`;
}

// Builds the {merge:true} write payload for saving today's reflection.
//
// `existedBefore` must reflect whether a daily_reflections doc for THIS uid+dateKey was already
// found by a fresh query before this save was clicked — never derived from transient UI state
// (see the header comment above). `createdAtValue`/`updatedAtValue` are injected by the caller
// (normally Firestore's serverTimestamp() sentinel) so this function has zero Firebase SDK
// dependency and is trivially unit-testable with plain string/marker values.
export function buildReflectionSavePayload({ uid, mood, note, now, timeZone, existedBefore, createdAtValue, updatedAtValue }) {
  const payload = {
    uid,
    dateKey: reflectionDateKey(now, timeZone),
    mood,
    note,
    visibility: "private",
    updatedAt: updatedAtValue,
  };
  if (!existedBefore) payload.createdAt = createdAtValue;
  return payload;
}
