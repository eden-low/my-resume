// Splash screen — a sixth sanctioned shared module (i18n.js, auth-guard.js, global-search.js,
// mobile-nav.js, sidebar.js, now splash.js), self-injecting like the others. Shown for the brief
// window body.auth-check-pending is present (auth-guard.js's check, or login.html's own),
// giving a deliberate branded moment instead of a sudden pop when content reveals.
//
// Appended to document.documentElement (a sibling of <body>, not a descendant) so body's own
// opacity:0/visibility:hidden while auth-check-pending can't hide it too — the same reasoning
// styles.css's html::before pulse mark already relies on. That CSS mark still fires on every
// page from the very first paint (zero JS, so there's never a truly blank frame); this overlay
// layers the real wordmark/tagline text on top of it once this script runs, then fades out the
// moment auth-check-pending is removed.
//
// No i18n.js import needed: this script's tag is placed before js/i18n.js's on every page, so
// i18n.js's own startup applyTranslations(document) sweep — which queries the whole document,
// not just what existed when it started — picks up this overlay's data-i18n text for free, same
// as any other static markup. If i18n.js has already finished initializing by the time this
// runs (window.EdenI18n set), the text is translated immediately instead of waiting for that
// sweep, so a same-order mistake elsewhere can't leave it permanently English.

const FADE_MS = 300;
const FALLBACK_MS = 6000; // safety net if auth-check-pending is never removed (e.g. login.html's session-restore redirect, where the page navigates away before ever clearing it)

function reducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function buildOverlay() {
  const overlay = document.createElement("div");
  overlay.id = "eden-splash";
  overlay.innerHTML = `
    <div id="eden-splash-inner">
      <div id="eden-splash-mark"><img src="images/logo-mark.png" alt=""></div>
      <p id="eden-splash-word">EdenAtlas</p>
      <p id="eden-splash-msg" data-i18n="splash.message">Opening your atlas&hellip;</p>
    </div>`;
  return overlay;
}

function mount() {
  if (!document.body || document.getElementById("eden-splash")) return null;
  if (!document.body.classList.contains("auth-check-pending")) return null;
  const overlay = buildOverlay();
  document.documentElement.appendChild(overlay);
  if (window.EdenI18n) {
    const msg = document.getElementById("eden-splash-msg");
    if (msg) msg.textContent = window.EdenI18n.t("splash.message");
  }
  return overlay;
}

function dismiss(overlay) {
  if (!overlay || overlay.dataset.dismissing) return;
  overlay.dataset.dismissing = "1";
  if (reducedMotion()) {
    overlay.remove();
    return;
  }
  overlay.classList.add("eden-splash-out");
  setTimeout(() => overlay.remove(), FADE_MS);
}

const splashOverlay = mount();
if (splashOverlay) {
  const observer = new MutationObserver(() => {
    if (!document.body.classList.contains("auth-check-pending")) {
      observer.disconnect();
      dismiss(splashOverlay);
    }
  });
  observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  setTimeout(() => {
    observer.disconnect();
    dismiss(splashOverlay);
  }, FALLBACK_MS);
}
