// Shared Firebase setup, imported by any page that needs auth/data (currently gallery.js;
// future phases like notes/dashboard widgets will reuse this same module).
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, setPersistence, browserLocalPersistence } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyBLJmKmn4Nwc2Ad3CG_KoPAn96HSfuvvU8",
  authDomain: "lfj-profolio.firebaseapp.com",
  projectId: "lfj-profolio",
  storageBucket: "lfj-profolio.firebasestorage.app",
  messagingSenderId: "173360347563",
  appId: "1:173360347563:web:961b3118bce0a8232c3aee",
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
// Explicit rather than relying on the SDK default so the PWA (standalone launch,
// no browser chrome) reliably keeps the session across relaunches.
setPersistence(auth, browserLocalPersistence).catch(console.error);
export const googleProvider = new GoogleAuthProvider();
export const db = getFirestore(app);
export const storage = getStorage(app);

// The single site owner — always allowed to write, and the only role that sees admin UI
// (System Logs, Whitelist Management). Everyone else is either an approved friend (own
// private data space, granted via the `friends` Firestore collection — see firestore.rules)
// or a plain viewer (read-only, public content only).
export const OWNER_EMAIL = "jjun8647@gmail.com";

export function isOwner(user) {
  return !!user && user.email === OWNER_EMAIL;
}

// Role is decided once at login time (see login.html) and cached here — real enforcement is
// always the Firestore/Storage rules re-checking `friends` fresh, this is UI gating only.
export const USER_MODE_KEY = "lfj:userMode";

export function getUserMode() {
  return localStorage.getItem(USER_MODE_KEY) || "VIEWER";
}

export function canParticipate() {
  const mode = getUserMode();
  return mode === "OWNER" || mode === "FRIEND";
}
