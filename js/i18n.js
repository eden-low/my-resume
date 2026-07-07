// Site-wide i18n. A third sanctioned shared module (alongside auth-guard.js and
// global-search.js) — dropped on every protected page via
// `<script type="module" src="js/i18n.js"></script>`, loaded before scripts.js so translated
// text is in place before auth-guard.js reveals the page (no flash of the other language).
//
// Single source of truth: `currentLang`, exposed both as ES module exports (for existing
// `import { ... } from "./i18n.js"` call sites in settings.js/mobile-nav.js/career.js) and as
// `window.EdenI18n` (a plain global, for anything that isn't itself a module, or just wants a
// stable name to reach for). Both forms call the exact same functions below — there is no
// separate "mobile" language logic anywhere.
//
// Priority order, decided once in init() and never silently re-decided later:
//   1. localStorage["edenAtlasLang"]
//   2. users/{uid}.lang in Firestore — ONLY consulted when localStorage had nothing yet
//   3. browser language (navigator.language)
//   4. "en"
// Bug this fixes: the previous version re-read Firestore on every onAuthStateChanged and
// overwrote `currentLang`/localStorage whenever it differed — including with stale data read
// before an in-flight `setLanguage()` write had landed. That race is exactly why a manual
// switch would "revert after about a second," or be lost after navigating to a fresh page
// (whose own onAuthStateChanged fired again and re-clobbered it). Firestore is now only ever
// read once, and only to *seed* localStorage when there was no local preference at all — it
// never overrides an existing one.
import { auth, db } from "../firebase-init.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import { doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

const LANG_KEY = "edenAtlasLang";
const LEGACY_LANG_KEY = "eden:lang"; // pre-fix key name, migrated once on init if present
const SUPPORTED = ["en", "zh-CN"];
const DICTS = {};

let currentLang = "en";
let initialized = false;
let initPromise = null;

function readStoredLang() {
  const stored = localStorage.getItem(LANG_KEY);
  if (stored && SUPPORTED.includes(stored)) return stored;
  // One-time migration from the old key name, so a real prior choice isn't silently lost.
  const legacy = localStorage.getItem(LEGACY_LANG_KEY);
  if (legacy && SUPPORTED.includes(legacy)) {
    localStorage.setItem(LANG_KEY, legacy);
    return legacy;
  }
  return null;
}

function detectBrowserLang() {
  const nav = (navigator.language || "en").toLowerCase();
  return nav.startsWith("zh") ? "zh-CN" : "en";
}

async function loadDict(lang) {
  if (DICTS[lang]) return DICTS[lang];
  try {
    const res = await fetch(`locales/${lang}.json`);
    DICTS[lang] = await res.json();
  } catch (err) {
    console.error(`[i18n] failed to load locales/${lang}.json:`, err);
    DICTS[lang] = {};
  }
  return DICTS[lang];
}

function getCurrentLang() {
  return currentLang;
}

// Dot-path lookup, e.g. t("nav.home"). Falls back to the key itself so a missing
// translation is visible (and debuggable) rather than blank.
function t(key) {
  const dict = DICTS[currentLang] || {};
  const value = key.split(".").reduce((node, part) => (node && typeof node === "object" ? node[part] : undefined), dict);
  return typeof value === "string" ? value : key;
}

// Pure re-render from whatever `currentLang` already is — never changes the selected language,
// never touches localStorage/Firestore. Safe to call as often as you like (e.g. after injecting
// new DOM, like sidebar.js/mobile-nav.js do after building their own markup).
function applyTranslations(root = document) {
  root.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.getAttribute("data-i18n"));
  });
  root.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.setAttribute("placeholder", t(el.getAttribute("data-i18n-placeholder")));
  });
  document.documentElement.setAttribute("lang", currentLang === "zh-CN" ? "zh-CN" : "en");
  console.log(`i18n applied: ${currentLang}`);
}

// Career CMS (and anything else rendering bilingual Firestore content) listens for this to
// re-render in the new language, since that content isn't driven by data-i18n/applyTranslations.
// Settings' and the mobile drawer's own language buttons also listen, so whichever control
// didn't originate the change still repaints its active state.
function dispatchLangChange() {
  document.dispatchEvent(new CustomEvent("eden:langchange", { detail: { lang: currentLang } }));
}

// The one function every language switcher (Settings, mobile drawer) calls — there is no
// separate implementation for either.
async function setLanguage(lang) {
  if (!SUPPORTED.includes(lang)) return currentLang;
  currentLang = lang;
  localStorage.setItem(LANG_KEY, lang);
  console.log(`i18n saved language: ${lang}`);
  await loadDict(lang);
  applyTranslations(document);
  dispatchLangChange();

  const user = auth.currentUser;
  if (user) {
    try {
      await setDoc(doc(db, "users", user.uid), { uid: user.uid, lang }, { merge: true });
    } catch (err) {
      console.error("[i18n] failed to persist language to users/{uid}:", err.code || err);
    }
  }
  return currentLang;
}

// Safe to call multiple times — the real derivation only ever runs once (guarded by
// `initialized`); later calls just return the already-decided language.
async function init() {
  if (initialized) return initPromise;
  initialized = true;

  initPromise = (async () => {
    const stored = readStoredLang();
    if (stored) {
      currentLang = stored;
    } else {
      currentLang = detectBrowserLang();
    }
    console.log(`i18n loaded language: ${currentLang}`);

    await loadDict(currentLang);
    applyTranslations(document);

    // Only ever consulted once, and only when there was no local preference at all — this is
    // the one-time "seed from another device" path, not a continuous sync. It re-checks
    // localStorage right before applying so a manual choice made while this was in flight
    // always wins (this re-check is what actually closes the race that caused the revert bug).
    if (!stored) {
      onAuthStateChanged(auth, async (user) => {
        if (!user || readStoredLang()) return;
        try {
          const snap = await getDoc(doc(db, "users", user.uid));
          const remoteLang = snap.data()?.lang;
          if (remoteLang && SUPPORTED.includes(remoteLang) && !readStoredLang()) {
            await setLanguage(remoteLang);
          }
        } catch (err) {
          console.error("[i18n] failed to read users/{uid}.lang:", err.code || err);
        }
      });
    }

    return currentLang;
  })();

  return initPromise;
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

// ---- Public API ----

window.EdenI18n = { init, getCurrentLang, setLanguage, applyTranslations, t };

// Back-compat named exports (same underlying implementation, not a parallel one) for existing
// `import { getLang, setLang } from "./i18n.js"` call sites.
export { init, getCurrentLang, getCurrentLang as getLang, setLanguage, setLanguage as setLang, applyTranslations, t };
