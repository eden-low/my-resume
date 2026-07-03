// Site-wide login gate. Drop `<script type="module" src="auth-guard.js"></script>` on any
// protected page (right after scripts.js) — no per-page wiring needed. Redirects to login.html
// if signed out; reveals the page (removes body.auth-check-pending, see styles.css) once resolved.
import { auth } from "./firebase-init.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";

const fallbackTimer = setTimeout(() => {
  document.body.classList.remove("auth-check-pending");
}, 6000);

onAuthStateChanged(auth, (user) => {
  clearTimeout(fallbackTimer);
  if (!user) {
    const here = location.pathname.split("/").pop() || "index.html";
    location.href = "login.html?redirect=" + encodeURIComponent(here);
    return;
  }
  document.body.classList.remove("auth-check-pending");
});

// A signed-out user hitting Back into a bfcache-restored protected page would otherwise see
// the cached DOM before a fresh auth check runs — force a reload so the gate re-evaluates.
window.addEventListener("pageshow", (event) => {
  if (event.persisted) location.reload();
});
