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

// The only account allowed to upload/delete and always allowed to read private content.
// Access beyond this is granted via the `allowedUsers` Firestore collection (see firestore.rules).
export const OWNER_EMAIL = "jjun8647@gmail.com";

export function isOwner(user) {
  return !!user && user.email === OWNER_EMAIL;
}
