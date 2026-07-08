// Identity-resolution helper (v3.1) — a small, import-only module in the same shape as
// i18n.js (no self-injected DOM, unlike auth-guard.js/global-search.js/mobile-nav.js/
// sidebar.js/splash.js). Centralizes the Display Name / @username / email priority so every
// page's "Signed in as" text and greeting resolve identity the same way, instead of each page
// re-deriving `user.displayName || user.email` on its own — which is what let a raw Google
// account name like "君JUN" (Chinese + English for the same name, read as a duplicate) leak
// straight into the UI with no way for the user to clean it up. The actual fix is giving
// Display Name its own editable field on users/{uid} (see me.js) and always preferring it here.
import { db } from "../firebase-init.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

const cache = new Map(); // uid -> users/{uid} doc data, or null if missing/failed

async function fetchUserDoc(uid) {
  if (cache.has(uid)) return cache.get(uid);
  let data = null;
  try {
    const snap = await getDoc(doc(db, "users", uid));
    if (snap.exists()) data = snap.data();
  } catch (err) {
    console.error("[identity] users/{uid} fetch failed:", err.code || err);
  }
  cache.set(uid, data);
  return data;
}

// Self-identity priority: Firestore users/{uid}.displayName -> Firebase Auth displayName ->
// username -> email prefix -> "User". Never concatenates two of these together. Exported so a
// page that already has its own users/{uid} fetch in flight (e.g. me.js's header render) can
// reuse the exact same formula without a second, redundant getDoc through resolveDisplayName().
export function computeDisplayName(profileData, authUser) {
  if (profileData?.displayName) return profileData.displayName;
  if (authUser?.displayName) return authUser.displayName;
  if (profileData?.username) return profileData.username;
  const email = profileData?.email || authUser?.email;
  if (email) return email.split("@")[0];
  return "User";
}

// For the current signed-in Firebase `user` — fetches (and caches) their own users/{uid} doc
// first so a Display Name set from Me -> Profile always wins over the raw Google name.
export async function resolveDisplayName(user) {
  if (!user) return "User";
  const profileData = await fetchUserDoc(user.uid);
  return computeDisplayName(profileData, user);
}

// For rendering *other* people (Connections cards, profile.html) — never falls back to email,
// since that would leak a private field onto a public card. displayName -> username -> "User".
export function publicDisplayName(profileData) {
  return profileData?.displayName || profileData?.username || "User";
}

export function formatHandle(username) {
  return username ? `@${username}` : "";
}

// Call after saving a new Display Name/username from Me so this session's cache doesn't keep
// serving the stale value to the header/sidebar/etc.
export function invalidateIdentityCache(uid) {
  cache.delete(uid);
}
