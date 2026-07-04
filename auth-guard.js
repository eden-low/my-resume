// Site-wide login gate. Drop `<script type="module" src="auth-guard.js"></script>` on any
// protected page (right after scripts.js) — no per-page wiring needed. Redirects to login.html
// if signed out; reveals the page (removes body.auth-check-pending, see styles.css) once resolved.
import { auth, db, isOwner } from "./firebase-init.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import { collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

const fallbackTimer = setTimeout(() => {
  document.body.classList.remove("auth-check-pending");
}, 6000);

// Unread-notification badge on the nav's Notifications link, present on every protected page.
// No-ops on any page that doesn't have the element (e.g. login.html has no nav at all).
async function updateNotifBadge(user) {
  const badge = document.getElementById("notif-badge");
  if (!badge || !isOwner(user)) return;
  try {
    const snap = await getDocs(query(collection(db, "notifications"), where("uid", "==", user.uid), where("read", "==", false)));
    if (snap.size > 0) {
      badge.textContent = snap.size > 9 ? "9+" : String(snap.size);
      badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
    }
  } catch (err) {
    console.error("[auth-guard] notif badge query failed:", err.code || err);
  }
}

onAuthStateChanged(auth, (user) => {
  clearTimeout(fallbackTimer);
  if (!user) {
    const here = location.pathname.split("/").pop() || "index.html";
    location.href = "login.html?redirect=" + encodeURIComponent(here);
    return;
  }
  document.body.classList.remove("auth-check-pending");
  updateNotifBadge(user);
});

// A signed-out user hitting Back into a bfcache-restored protected page would otherwise see
// the cached DOM before a fresh auth check runs — force a reload so the gate re-evaluates.
window.addEventListener("pageshow", (event) => {
  if (event.persisted) location.reload();
});
