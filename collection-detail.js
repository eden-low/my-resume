import { auth, db } from "./firebase-init.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import {
  collection,
  query,
  where,
  getDocs,
  getDoc,
  doc,
  updateDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import { getLang, t as i18nT } from "./js/i18n.js";
import { excludeDeleted } from "./js/memory-filters.js";

const id = new URLSearchParams(location.search).get("id");
const isUncategorized = id === "uncategorized";

function curLang() {
  return getLang() === "zh-CN" ? "zh" : "en";
}
function bi(obj, field) {
  const lang = curLang();
  return (lang === "zh" ? obj[field + "_zh"] : obj[field + "_en"]) || obj[field + "_en"] || obj[field + "_zh"] || "";
}
function formatTimestamp(ts) {
  if (!ts?.toDate) return "";
  return ts.toDate().toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}

// Cached from the last successful fetch, so the eden:langchange listener below can re-render
// bilingual content (the collection's own title/description, and career.js-style title_en/zh
// project fields) without re-querying Firestore — same "re-render from cached data" contract
// collections.js and career.js follow.
let cachedC = null;
let cachedIsOwner = false;
let cachedPhotos = [];
let cachedJournals = [];
let cachedEvents = [];
let cachedProjects = [];
let cachedExpenses = [];

async function mergeMinePublic(name) {
  const user = auth.currentUser;
  const map = new Map();
  try {
    const publicSnap = await getDocs(query(collection(db, name), where("visibility", "==", "public")));
    publicSnap.forEach((d) => map.set(d.id, { id: d.id, ...d.data() }));
  } catch (err) {
    console.error(`[collection-detail] ${name} public query failed:`, err.code || err);
  }
  if (user) {
    try {
      const mineSnap = await getDocs(query(collection(db, name), where("uid", "==", user.uid)));
      mineSnap.forEach((d) => map.set(d.id, { id: d.id, ...d.data() }));
    } catch (err) {
      console.error(`[collection-detail] ${name} mine query failed:`, err.code || err);
    }
  }
  // Trashed Memories never appear inside a Collection's detail view either — a no-op for the
  // other types this is called with, which never carry deletedAt.
  return excludeDeleted([...map.values()]);
}

async function fetchMyOnly(name) {
  const user = auth.currentUser;
  if (!user) return [];
  try {
    const snap = await getDocs(query(collection(db, name), where("uid", "==", user.uid)));
    return excludeDeleted(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  } catch (err) {
    console.error(`[collection-detail] ${name} mine query failed:`, err.code || err);
    return [];
  }
}

function renderMemories(photos) {
  const gridEl = document.getElementById("memories-grid");
  const emptyEl = document.getElementById("memories-empty");
  gridEl.innerHTML = photos.slice(0, 24).map((p) => `<img src="${p.url}" alt="" class="w-full h-24 object-cover rounded-lg">`).join("");
  emptyEl.classList.toggle("hidden", photos.length > 0);
}

function renderJournal(entries) {
  const listEl = document.getElementById("journal-list");
  const emptyEl = document.getElementById("journal-empty");
  listEl.innerHTML = entries.slice(0, 20).map((e) => `
    <div class="bg-darkBg/40 border border-borderNeon/60 rounded-xl p-3">
      <div class="flex items-center justify-between gap-3">
        <h3 class="text-sm font-medium">${e.title}</h3>
        <span class="text-[10px] font-code text-textGray flex-shrink-0">${formatTimestamp(e.createdAt)}</span>
      </div>
    </div>`).join("");
  emptyEl.classList.toggle("hidden", entries.length > 0);
}

function renderFinance(expenses) {
  const listEl = document.getElementById("finance-list");
  const emptyEl = document.getElementById("finance-empty");
  listEl.innerHTML = expenses.slice(0, 30).map((e) => `
    <div class="flex items-center justify-between bg-darkBg/40 border border-borderNeon/60 rounded-lg px-3 py-2">
      <span class="text-xs text-textGray truncate">${e.note || e.category}</span>
      <span class="font-code text-xs font-semibold flex-shrink-0">RM ${Number(e.amount).toFixed(2)}</span>
    </div>`).join("");
  emptyEl.classList.toggle("hidden", expenses.length > 0);
}

function renderJourney(events) {
  const listEl = document.getElementById("journey-list");
  const emptyEl = document.getElementById("journey-empty");
  listEl.innerHTML = events.slice(0, 20).map((e) => `
    <div class="bg-darkBg/40 border border-borderNeon/60 rounded-xl p-3">
      <div class="flex items-center justify-between gap-3">
        <h3 class="text-sm font-medium">${e.title}</h3>
        <span class="text-[10px] font-code text-textGray flex-shrink-0">${formatTimestamp(e.date)}</span>
      </div>
    </div>`).join("");
  emptyEl.classList.toggle("hidden", events.length > 0);
}

function renderCareer(projects) {
  const listEl = document.getElementById("career-list");
  const emptyEl = document.getElementById("career-empty");
  listEl.innerHTML = projects.slice(0, 20).map((p) => `
    <div class="bg-darkBg/40 border border-borderNeon/60 rounded-xl p-3">
      <h3 class="text-sm font-medium">${bi(p, "title")}</h3>
      <p class="text-xs text-textGray mt-1 line-clamp-2">${bi(p, "summary")}</p>
    </div>`).join("");
  emptyEl.classList.toggle("hidden", projects.length > 0);
}

function filterByCollection(list) {
  return list.filter((item) => (item.collectionId || null) === (isUncategorized ? null : id));
}

// Pure re-render from whatever's already cached — no refetch. Used both right after a fetch and
// from the eden:langchange listener (bilingual career project titles/summaries are the only
// language-dependent part of these sections, but re-running all of them is cheap and keeps this
// in one place rather than special-casing just renderCareer).
function renderAllSections() {
  renderMemories(filterByCollection(cachedPhotos));
  renderJournal(filterByCollection(cachedJournals));
  renderJourney(filterByCollection(cachedEvents));
  renderCareer(filterByCollection(cachedProjects));
  if (isUncategorized || cachedIsOwner) {
    renderFinance(filterByCollection(cachedExpenses));
  }
}

async function loadSections(isOwner) {
  cachedIsOwner = isOwner;

  if (isUncategorized) {
    const [photos, journals, events, projects, expenses] = await Promise.all([
      fetchMyOnly("photos"),
      fetchMyOnly("journals"),
      fetchMyOnly("life_events"),
      fetchMyOnly("career_projects"),
      fetchMyOnly("expenses"),
    ]);
    cachedPhotos = photos;
    cachedJournals = journals;
    cachedEvents = events;
    cachedProjects = projects;
    cachedExpenses = expenses;
    renderAllSections();
    document.getElementById("section-finance").classList.remove("hidden");
    return;
  }

  const [photos, journals, events, projects] = await Promise.all([
    mergeMinePublic("photos"),
    mergeMinePublic("journals"),
    mergeMinePublic("life_events"),
    mergeMinePublic("career_projects"),
  ]);
  cachedPhotos = photos;
  cachedJournals = journals;
  cachedEvents = events;
  cachedProjects = projects;
  renderMemories(filterByCollection(photos));
  renderJournal(filterByCollection(journals));
  renderJourney(filterByCollection(events));
  renderCareer(filterByCollection(projects));

  // Expenses are always private and never shown on anyone else's collection.
  document.getElementById("section-finance").classList.toggle("hidden", !isOwner);
  if (isOwner) {
    const expenses = await fetchMyOnly("expenses");
    cachedExpenses = expenses;
    renderFinance(filterByCollection(expenses));
  }
}

// Re-render the collection header's bilingual title/description and the bilingual career
// project cards from cache whenever the language switcher fires — mirrors career.js's
// eden:langchange listener and collections.js's own (added alongside this fix).
document.addEventListener("eden:langchange", () => {
  if (!cachedC) return;
  renderHeaderText(cachedC);
  renderAllSections();
});

// Just the language-dependent bit of the header — split out so the eden:langchange listener can
// re-render it alone, without re-wiring the edit/save-notes button listeners renderHeader() below
// also sets up (those must only ever be wired once per page load, not once per language switch).
function renderHeaderText(c) {
  document.getElementById("collection-title").textContent = isUncategorized ? i18nT("common.uncategorized") : bi(c, "title");
  document.getElementById("collection-description").textContent = isUncategorized ? "" : bi(c, "description");
}

function renderHeader(c, isOwner) {
  cachedC = c;
  renderHeaderText(c);
  const cover = document.getElementById("collection-cover");
  if (!isUncategorized && c.coverImageUrl) {
    cover.innerHTML = `<img src="${c.coverImageUrl}" alt="" class="w-full h-full object-cover">`;
  } else {
    const color = c?.color || "#a78bfa";
    cover.style.background = `${color}22`;
    cover.innerHTML = `<i data-lucide="${isUncategorized ? "inbox" : (c.icon || "layers")}" class="w-10 h-10" style="color:${color}"></i>`;
  }
  const badge = document.getElementById("collection-visibility-badge");
  if (isUncategorized) {
    badge.classList.add("hidden");
  } else {
    const vis = c.visibility === "private"
      ? { icon: "fa-lock", cls: "border-rose-400/30 bg-rose-400/10 text-rose-400" }
      : c.visibility === "connections"
        ? { icon: "fa-user-group", cls: "border-neonBlue/30 bg-neonBlue/10 text-neonBlue" }
        : { icon: "fa-globe", cls: "border-emerald-400/30 bg-emerald-400/10 text-emerald-400" };
    badge.classList.remove("hidden");
    badge.className = `text-[10px] font-code px-2 py-0.5 rounded-full border ${vis.cls}`;
    badge.innerHTML = `<i class="fa-solid ${vis.icon}"></i>`;
  }

  const editBtn = document.getElementById("edit-collection-btn");
  editBtn.classList.toggle("hidden", isUncategorized || !isOwner);
  if (isOwner && !isUncategorized) editBtn.addEventListener("click", () => { location.href = `collections.html?edit=${c.id}`; });

  const notesTextarea = document.getElementById("notes-textarea");
  const saveNotesBtn = document.getElementById("save-notes-btn");
  document.getElementById("section-notes").classList.toggle("hidden", isUncategorized);
  if (!isUncategorized) {
    notesTextarea.value = c.notes || "";
    notesTextarea.disabled = !isOwner;
    saveNotesBtn.classList.toggle("hidden", !isOwner);
    if (isOwner) {
      saveNotesBtn.addEventListener("click", async () => {
        try {
          await updateDoc(doc(db, "collections", c.id), { notes: notesTextarea.value.trim(), updatedAt: serverTimestamp() });
          saveNotesBtn.textContent = i18nT("common.saved");
          setTimeout(() => { saveNotesBtn.textContent = i18nT("common.save"); }, 1500);
        } catch (err) {
          console.error("[collection-detail] notes save failed:", err.code || err);
        }
      });
    }
  }

  if (window.lucide) window.lucide.createIcons();
}

async function init(user) {
  if (!id) {
    document.getElementById("private-notice").classList.remove("hidden");
    document.getElementById("private-notice").textContent = "No collection specified.";
    document.getElementById("collection-sections").classList.add("hidden");
    return;
  }

  if (isUncategorized) {
    if (!user) {
      document.getElementById("private-notice").classList.remove("hidden");
      document.getElementById("collection-sections").classList.add("hidden");
      return;
    }
    renderHeader({}, true);
    await loadSections(true);
    return;
  }

  let snap;
  try {
    snap = await getDoc(doc(db, "collections", id));
  } catch (err) {
    console.error("[collection-detail] fetch failed:", err.code || err);
  }

  if (!snap || !snap.exists()) {
    document.getElementById("private-notice").classList.remove("hidden");
    document.getElementById("collection-sections").classList.add("hidden");
    return;
  }

  const c = { id: snap.id, ...snap.data() };
  const isOwner = !!user && c.uid === user.uid;
  renderHeader(c, isOwner);
  await loadSections(isOwner);
}

onAuthStateChanged(auth, (user) => {
  init(user);
});
