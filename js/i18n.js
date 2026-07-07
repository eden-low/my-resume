// Site-wide i18n. A third sanctioned shared module (alongside auth-guard.js and
// global-search.js) — dropped on every protected page via
// `<script type="module" src="js/i18n.js"></script>`, loaded before scripts.js so translated
// text is in place before auth-guard.js reveals the page (no flash of the other language).
import { auth, db } from "../firebase-init.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import { doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

const LANG_KEY = "eden:lang";
const SUPPORTED = ["en", "zh-CN"];
const DICTS = {};
let currentLang = localStorage.getItem(LANG_KEY) || "en";

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

export function getLang() {
  return currentLang;
}

// Dot-path lookup, e.g. t("nav.home"). Falls back to the key itself so a missing
// translation is visible (and debuggable) rather than blank.
export function t(key) {
  const dict = DICTS[currentLang] || {};
  const value = key.split(".").reduce((node, part) => (node && typeof node === "object" ? node[part] : undefined), dict);
  return typeof value === "string" ? value : key;
}

export function applyTranslations(root = document) {
  root.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.getAttribute("data-i18n"));
  });
  root.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.setAttribute("placeholder", t(el.getAttribute("data-i18n-placeholder")));
  });
  document.documentElement.setAttribute("lang", currentLang === "zh-CN" ? "zh-CN" : "en");
}

// Career CMS (and anything else rendering bilingual Firestore content) listens for this to
// re-render in the new language, since that content isn't driven by data-i18n/applyTranslations.
function dispatchLangChange() {
  document.dispatchEvent(new CustomEvent("eden:langchange", { detail: { lang: currentLang } }));
}

export async function setLang(lang) {
  if (!SUPPORTED.includes(lang)) return;
  currentLang = lang;
  localStorage.setItem(LANG_KEY, lang);
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
}

async function boot() {
  await loadDict(currentLang);
  applyTranslations(document);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}

// Once auth resolves, Firestore's `users/{uid}.lang` (if set) wins over localStorage — lets a
// language choice made on one device follow the user to another, same precedence pattern as
// bio/location/username reconciliation elsewhere in this app.
onAuthStateChanged(auth, async (user) => {
  if (!user) return;
  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    const remoteLang = snap.data()?.lang;
    if (remoteLang && SUPPORTED.includes(remoteLang) && remoteLang !== currentLang) {
      currentLang = remoteLang;
      localStorage.setItem(LANG_KEY, remoteLang);
      await loadDict(remoteLang);
      applyTranslations(document);
      dispatchLangChange();
    }
  } catch (err) {
    console.error("[i18n] failed to read users/{uid}.lang:", err.code || err);
  }
});
