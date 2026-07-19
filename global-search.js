// Site-wide "Search Everything" command palette. A second sanctioned shared module alongside
// auth-guard.js — dropped on every protected page via a single
// `<script type="module" src="global-search.js"></script>` tag (right after auth-guard.js).
// Injects its own trigger button + modal into the header's <nav> rather than requiring
// per-page markup, matching auth-guard.js's self-contained pattern.
import { auth, db, getUserMode } from "./firebase-init.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import { collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import { init as initI18n, applyTranslations, t } from "./js/i18n.js";
import { publicDisplayName } from "./js/identity.js";
import { excludeDeleted } from "./js/memory-filters.js";

// Security audit fix: resultLabel() below surfaces raw Firestore free text (photo captions,
// journal/event/habit titles, expense notes, publicDisplayName) across every user's
// public/mine-merged content -- this palette is reachable from every protected page via
// Ctrl/Cmd-K, so an unescaped hit here is the widest-reach XSS surface in the app. Same esc()
// implementation as calendar.js's pre-existing one.
function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// "Reports" isn't its own searchable collection (reports.html/insights.js has no documents of
// its own — it's a derived analytics view over `expenses`), so that bucket is mapped to the
// actual underlying collection, Expenses, rather than inventing a duplicate result type.
// Labels reuse the existing sidebar/nav translation keys (each of these result types maps
// cleanly onto one nav section) rather than inventing parallel global_search.category_* keys.
const GROUPS = [
  { key: "users", labelKey: "nav.people", icon: "fa-user", href: (r) => r.username ? `profile.html?u=${encodeURIComponent(r.username)}` : `profile.html?uid=${encodeURIComponent(r.uid)}` },
  { key: "photos", labelKey: "nav.memories", icon: "fa-image", href: () => "gallery.html" },
  { key: "journals", labelKey: "nav.journal", icon: "fa-book", href: () => "journal.html" },
  { key: "life_events", labelKey: "nav.journey", icon: "fa-timeline", href: () => "timeline.html" },
  { key: "habits", labelKey: "nav.habits", icon: "fa-list-check", href: () => "habits.html" },
  { key: "expenses", labelKey: "nav.finance", icon: "fa-wallet", href: () => "expenses.html" },
];

let injected = false;
let cachedData = null;

function injectUI() {
  if (injected) return;
  const nav = document.querySelector("header nav");
  if (!nav) return;
  injected = true;

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-borderNeon bg-darkBg/60 text-textGray text-xs font-code hover:text-neonPurple hover:border-neonPurple/40 transition-colors";
  trigger.innerHTML = `<i class="fa-solid fa-magnifying-glass"></i> <span class="hidden sm:inline" data-i18n="common.search">Search</span> <span class="hidden sm:inline text-[10px] text-textGray/60 border border-borderNeon rounded px-1" data-i18n="global_search.shortcut_hint">Ctrl K</span>`;
  nav.appendChild(trigger);

  const overlay = document.createElement("div");
  overlay.id = "global-search-overlay";
  overlay.className = "hidden fixed inset-0 z-[100] flex items-start justify-center p-4 pt-[10vh]";
  overlay.innerHTML = `
    <div id="global-search-backdrop" class="absolute inset-0 bg-darkBg/80 backdrop-blur-sm"></div>
    <div class="relative w-full max-w-xl bg-cardBg neon-border-purple rounded-2xl overflow-hidden max-h-[70vh] flex flex-col">
      <div class="flex items-center gap-3 px-4 py-3 border-b border-borderNeon/60 flex-shrink-0">
        <i class="fa-solid fa-magnifying-glass text-textGray text-sm"></i>
        <input id="global-search-input" type="text" data-i18n-placeholder="global_search.placeholder" placeholder="Search people, gallery, journal, timeline, habits, expenses&hellip;" class="flex-1 bg-transparent text-sm text-white placeholder:text-textGray/60 focus:outline-none">
        <button id="global-search-close" class="text-textGray hover:text-white text-lg leading-none">&times;</button>
      </div>
      <div id="global-search-results" class="overflow-y-auto p-2 space-y-3"></div>
      <p id="global-search-empty" class="hidden text-center text-xs font-code text-textGray py-10" data-i18n="common.no_results">No results.</p>
    </div>`;
  document.body.appendChild(overlay);

  // This module self-injects its DOM after js/i18n.js's initial applyTranslations(document) pass
  // has already run, so the trigger/modal need their own pass — same pattern sidebar.js and
  // mobile-nav.js use for their own self-injected markup.
  initI18n().then(() => applyTranslations(document));

  trigger.addEventListener("click", openPalette);
  document.getElementById("global-search-close").addEventListener("click", closePalette);
  document.getElementById("global-search-backdrop").addEventListener("click", closePalette);
  document.getElementById("global-search-input").addEventListener("input", (event) => renderResults(event.target.value));

  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      openPalette();
    } else if (event.key === "Escape" && !overlay.classList.contains("hidden")) {
      closePalette();
    }
  });
}

function openPalette() {
  const overlay = document.getElementById("global-search-overlay");
  overlay.classList.remove("hidden");
  const input = document.getElementById("global-search-input");
  input.value = "";
  input.focus();
  renderResults("");
  if (!cachedData) loadAll();
}

function closePalette() {
  document.getElementById("global-search-overlay").classList.add("hidden");
}

// Same mine+public Map-merge pattern used by gallery.js/journal.js/timeline.js/habits.js.
async function fetchMineOrPublic(name) {
  const user = auth.currentUser;
  const map = new Map();
  try {
    const publicSnap = await getDocs(query(collection(db, name), where("visibility", "==", "public")));
    publicSnap.forEach((d) => map.set(d.id, { id: d.id, ...d.data() }));
  } catch (err) {
    console.error(`[global-search] ${name} public query failed:`, err.code || err);
  }
  if (user) {
    try {
      const mineSnap = await getDocs(query(collection(db, name), where("uid", "==", user.uid)));
      mineSnap.forEach((d) => map.set(d.id, { id: d.id, ...d.data() }));
    } catch (err) {
      console.error(`[global-search] ${name} own query failed:`, err.code || err);
    }
  }
  // Trashed Memories (photos with deletedAt set) never surface in search results — harmless
  // no-op for journals/life_events/habits, which never carry that field.
  return excludeDeleted([...map.values()]);
}

// Expenses are always private — this only ever fetches the signed-in user's own, never anyone
// else's, so "Search Everything" for expenses returns nothing for other people by construction.
async function fetchMine(name) {
  const user = auth.currentUser;
  if (!user) return [];
  try {
    const snap = await getDocs(query(collection(db, name), where("uid", "==", user.uid)));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.error(`[global-search] ${name} query failed:`, err.code || err);
    return [];
  }
}

// Mirrors dashboard.js's searchableUsers() role gate: a Viewer only ever finds the Owner; a
// Friend or the Owner finds the Owner and any Friend.
function searchableUsers(users) {
  const myRole = getUserMode();
  return users.filter((p) => {
    if (p.uid === auth.currentUser?.uid) return false;
    if (myRole === "VIEWER") return p.role === "owner";
    return p.role === "owner" || p.role === "friend";
  });
}

async function loadAll() {
  const [usersSnap, photos, journals, life_events, habits, expenses] = await Promise.all([
    getDocs(collection(db, "users")).catch((err) => {
      console.error("[global-search] users query failed:", err.code || err);
      return { docs: [] };
    }),
    fetchMineOrPublic("photos"),
    fetchMineOrPublic("journals"),
    fetchMineOrPublic("life_events"),
    fetchMineOrPublic("habits"),
    fetchMine("expenses"),
  ]);
  cachedData = {
    users: searchableUsers(usersSnap.docs.map((d) => d.data())),
    photos, journals, life_events, habits, expenses,
  };
  const input = document.getElementById("global-search-input");
  if (input) renderResults(input.value);
}

function matchText(values, q) {
  return values.some((v) => (v || "").toString().toLowerCase().includes(q));
}

function resultLabel(key, r) {
  if (key === "users") return esc(publicDisplayName(r));
  if (key === "photos") return esc(r.caption || "Untitled photo");
  if (key === "journals") return esc(r.title || "Untitled entry");
  if (key === "life_events") return esc(r.title || "Untitled event");
  if (key === "habits") return esc(r.title);
  if (key === "expenses") return `${esc(r.note || r.category)} — RM${r.amount}`;
  return "";
}

function renderResults(raw) {
  const resultsEl = document.getElementById("global-search-results");
  const emptyEl = document.getElementById("global-search-empty");
  if (!resultsEl) return;
  const q = raw.trim().toLowerCase().replace(/^@/, "");
  if (!q || !cachedData) {
    resultsEl.replaceChildren();
    emptyEl.classList.add("hidden");
    return;
  }

  const matches = {
    // Username/Display Name only — never matched against the private account email (v3.1).
    users: cachedData.users.filter((u) => matchText([u.displayName, u.username], q)),
    photos: cachedData.photos.filter((p) => matchText([p.caption], q)),
    journals: cachedData.journals.filter((j) => matchText([j.title, j.content, ...(j.tags || [])], q)),
    life_events: cachedData.life_events.filter((e) => matchText([e.title, e.description], q)),
    habits: cachedData.habits.filter((h) => matchText([h.title], q)),
    expenses: cachedData.expenses.filter((e) => matchText([e.note, e.category], q)),
  };

  const groupsWithHits = GROUPS.filter((g) => matches[g.key].length > 0);
  emptyEl.classList.toggle("hidden", groupsWithHits.length > 0);

  resultsEl.replaceChildren(
    ...groupsWithHits.map((g) => {
      const hits = matches[g.key];
      const wrap = document.createElement("div");
      wrap.innerHTML = `
        <p class="px-2 text-[10px] uppercase tracking-[0.2em] text-textGray font-code mb-1.5">${t(g.labelKey)} &middot; ${hits.length} result${hits.length === 1 ? "" : "s"}</p>
        <div class="space-y-1">
          ${hits.slice(0, 5).map((r) => `
            <a href="${g.href(r)}" class="flex items-center gap-3 px-2.5 py-2 rounded-xl hover:bg-darkBg/40 transition-colors">
              <span class="w-7 h-7 rounded-lg bg-neonPurple/10 text-neonPurple flex items-center justify-center text-xs flex-shrink-0"><i class="fa-solid ${g.icon}"></i></span>
              <span class="min-w-0 text-sm text-white truncate">${resultLabel(g.key, r)}</span>
            </a>`).join("")}
        </div>`;
      return wrap;
    })
  );
}

onAuthStateChanged(auth, (user) => {
  if (user) injectUI();
});
