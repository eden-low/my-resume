// Shared Firebase setup, imported by any page that needs auth/data (currently gallery.js;
// future phases like notes/dashboard widgets will reuse this same module).
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, setPersistence, browserLocalPersistence } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-storage.js";

// authDomain controls where Firebase's OAuth handler page (/__/auth/handler) lives. The default,
// {project}.firebaseapp.com, is a third-party origin relative to this site — on iOS, a
// home-screen-installed ("standalone") PWA uses a storage partition that does not reliably
// survive a round trip through a different top-level origin, which is why signInWithRedirect
// used to strand standalone users on Google's page with no way back (see login.html). Pointing
// authDomain at this site's own production host instead — with netlify.toml proxying
// /__/auth/* through to the real Firebase handler — keeps the whole OAuth handshake same-origin
// from the browser's point of view, which fixes that. This only works when actually served from
// that host (the proxy rule is Netlify-only), so every other context (localhost, `file://`,
// Netlify deploy previews) falls back to the original Firebase-hosted authDomain, where the
// proxy doesn't exist but the default flow still works. Requires this host to be listed under
// Firebase Console -> Authentication -> Settings -> Authorized domains, and
// `https://edenatlas.netlify.app/__/auth/handler` to be an Authorized redirect URI on the
// matching Google Cloud OAuth 2.0 Client ID — both are manual console steps, not code.
const PRODUCTION_HOST = "edenatlas.netlify.app";
const DEFAULT_AUTH_DOMAIN = "lfj-profolio.firebaseapp.com";
const authDomain =
  typeof location !== "undefined" && location.hostname === PRODUCTION_HOST
    ? PRODUCTION_HOST
    : DEFAULT_AUTH_DOMAIN;

const firebaseConfig = {
  apiKey: "AIzaSyBLJmKmn4Nwc2Ad3CG_KoPAn96HSfuvvU8",
  authDomain,
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
