import { auth, googleProvider, db, canParticipate } from "./firebase-init.js";
import { excludeDeleted } from "./js/memory-filters.js";
import {
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import {
  collection,
  query,
  where,
  getDocs,
  addDoc,
  doc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import { getLang, t as i18nT } from "./js/i18n.js";
import { resolveDisplayName } from "./js/identity.js";

// Security audit fix: collection title/description/coverImageUrl/color/icon are Firestore-stored
// free text any participant can write, and collections default to isMineOrPublic (public/
// connections collections are readable by other signed-in users) -- every interpolation into
// innerHTML below must be escaped. Same implementation as calendar.js's pre-existing esc().
function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const authControl = document.getElementById("auth-control");
const accessNote = document.getElementById("collections-access-note");
const grid = document.getElementById("collections-grid");
const emptyEl = document.getElementById("collections-empty");
const newBtn = document.getElementById("new-collection-btn");
const modal = document.getElementById("collection-modal");
const modalTitle = document.getElementById("collection-modal-title");
const modalClose = document.getElementById("collection-modal-close");
const modalBackdrop = document.getElementById("collection-modal-backdrop");
const form = document.getElementById("collection-form");
const statusEl = document.getElementById("collection-status");
const coverPickBtn = document.getElementById("collection-pick-cover-btn");
const coverPicker = document.getElementById("collection-cover-picker");

let cachedCollections = [];
let cachedPhotos = [];
let cachedJournals = [];
let cachedExpenses = [];
let cachedEvents = [];
let cachedProjects = [];

function curLang() {
  return getLang() === "zh-CN" ? "zh" : "en";
}
function bi(obj, field) {
  const lang = curLang();
  return (lang === "zh" ? obj[field + "_zh"] : obj[field + "_en"]) || obj[field + "_en"] || obj[field + "_zh"] || "";
}

// Same mine+public merge-by-doc-id pattern used on gallery/journal/timeline.
async function mergeMinePublic(name) {
  const user = auth.currentUser;
  const map = new Map();
  try {
    const publicSnap = await getDocs(query(collection(db, name), where("visibility", "==", "public")));
    publicSnap.forEach((d) => map.set(d.id, { id: d.id, ...d.data() }));
  } catch (err) {
    console.error(`[collections] ${name} public query failed:`, err.code || err);
  }
  if (user) {
    try {
      const mineSnap = await getDocs(query(collection(db, name), where("uid", "==", user.uid)));
      mineSnap.forEach((d) => map.set(d.id, { id: d.id, ...d.data() }));
    } catch (err) {
      console.error(`[collections] ${name} mine query failed:`, err.code || err);
    }
  }
  // Trashed Memories never count toward a Collection's item counts — a no-op for every other
  // type this is called with (journals/life_events/career_projects), which never carry
  // deletedAt.
  return excludeDeleted([...map.values()]);
}

async function fetchMyExpenses() {
  const user = auth.currentUser;
  if (!user || !canParticipate()) return [];
  try {
    const snap = await getDocs(query(collection(db, "expenses"), where("uid", "==", user.uid)));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.error("[collections] expenses fetch failed:", err.code || err);
    return [];
  }
}

function countsFor(collectionId) {
  const match = (item) => (item.collectionId || null) === collectionId;
  return {
    memories: cachedPhotos.filter(match).length,
    journal: cachedJournals.filter(match).length,
    finance: cachedExpenses.filter(match).length,
    journey: cachedEvents.filter(match).length,
    career: cachedProjects.filter(match).length,
  };
}

function countBadges(counts) {
  const items = [
    { key: "memories", icon: "fa-images", value: counts.memories },
    { key: "journal", icon: "fa-book", value: counts.journal },
    { key: "finance", icon: "fa-wallet", value: counts.finance },
    { key: "journey", icon: "fa-timeline", value: counts.journey },
    { key: "career", icon: "fa-briefcase", value: counts.career },
  ];
  return items.map((i) => `<span class="flex items-center gap-1 text-textGray"><i class="fa-solid ${i.icon}"></i>${i.value}</span>`).join("");
}

function visibilityBadge(visibility) {
  if (visibility === "private") return { icon: "fa-lock", cls: "border-rose-400/30 bg-rose-400/10 text-rose-400" };
  if (visibility === "connections") return { icon: "fa-user-group", cls: "border-neonBlue/30 bg-neonBlue/10 text-neonBlue" };
  return { icon: "fa-globe", cls: "border-emerald-400/30 bg-emerald-400/10 text-emerald-400" };
}

function collectionCard(c, isUncategorized = false) {
  const user = auth.currentUser;
  const isMine = isUncategorized ? true : !!user && c.uid === user.uid;
  const vis = visibilityBadge(c.visibility);
  const counts = countsFor(isUncategorized ? null : c.id);
  const title = isUncategorized ? i18nT("common.uncategorized") : bi(c, "title");
  const description = isUncategorized ? "" : bi(c, "description");
  const color = c.color || "#a78bfa";
  const cover = c.coverImageUrl;

  const card = document.createElement("article");
  card.className = "is-visible bg-cardBg/90 neon-border-purple rounded-2xl overflow-hidden card-lift";
  card.innerHTML = `
    <a href="collection-detail.html?id=${isUncategorized ? "uncategorized" : encodeURIComponent(c.id)}" class="block">
      ${cover ? `<img src="${esc(cover)}" alt="" class="w-full h-32 object-cover">`
        : `<div class="w-full h-32 flex items-center justify-center" style="background:${esc(color)}22"><i data-lucide="${esc(c.icon || "layers")}" class="w-8 h-8" style="color:${esc(color)}"></i></div>`}
      <div class="p-4 space-y-2">
        <div class="flex items-center justify-between gap-2">
          <h2 class="text-sm font-semibold truncate">${esc(title)}</h2>
          ${!isUncategorized ? `
            <span class="text-[10px] font-code px-2 py-0.5 rounded-full flex-shrink-0 border ${vis.cls}">
              <i class="fa-solid ${vis.icon}"></i>
            </span>` : ""}
        </div>
        ${description ? `<p class="text-xs text-textGray line-clamp-2">${esc(description)}</p>` : ""}
        <div class="flex flex-wrap items-center gap-3 text-[10px] font-code pt-1">${countBadges(counts)}</div>
      </div>
    </a>
    ${isMine && !isUncategorized ? `
      <div class="flex items-center gap-2 px-4 pb-4">
        <button class="edit-collection-btn text-[11px] font-code text-textGray hover:text-neonPurple transition-colors"><i class="fa-solid fa-pen mr-1"></i>${i18nT("common.edit")}</button>
        <button class="delete-collection-btn text-[11px] font-code text-textGray hover:text-rose-400 transition-colors"><i class="fa-solid fa-trash mr-1"></i>${i18nT("common.delete")}</button>
      </div>` : ""}`;

  const editBtn = card.querySelector(".edit-collection-btn");
  if (editBtn) editBtn.addEventListener("click", (e) => { e.preventDefault(); openForm(c.id); });
  const deleteBtn = card.querySelector(".delete-collection-btn");
  if (deleteBtn) deleteBtn.addEventListener("click", (e) => { e.preventDefault(); deleteCollection(c, counts); });

  if (window.lucide) window.lucide.createIcons();
  return card;
}

function renderGrid() {
  const user = auth.currentUser;
  const cards = [...cachedCollections.map((c) => collectionCard(c))];
  const uncategorizedCounts = countsFor(null);
  const hasUncategorized = Object.values(uncategorizedCounts).some((v) => v > 0);
  if (hasUncategorized) cards.push(collectionCard({}, true));

  grid.replaceChildren(...cards);
  emptyEl.classList.toggle("hidden", cards.length > 0);
}

async function loadAll() {
  [cachedCollections, cachedPhotos, cachedJournals, cachedEvents, cachedProjects, cachedExpenses] = await Promise.all([
    mergeMinePublic("collections"),
    mergeMinePublic("photos"),
    mergeMinePublic("journals"),
    mergeMinePublic("life_events"),
    mergeMinePublic("career_projects"),
    fetchMyExpenses(),
  ]);
  renderGrid();
}

// Re-render bilingual titles/descriptions (not just chrome — see js/i18n.js's applyTranslations
// for that) from the already-fetched cachedCollections whenever the language switcher fires, so
// an open Collections page updates instantly instead of only picking up the new language on the
// next page load. Mirrors career.js's eden:langchange listener.
document.addEventListener("eden:langchange", () => {
  renderGrid();
});

async function deleteCollection(c, counts) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total > 0) {
    alert(i18nT("collections.delete_blocked", { count: total }));
    return;
  }
  if (!confirm(i18nT("common.delete_confirm"))) return;
  try {
    await deleteDoc(doc(db, "collections", c.id));
    await loadAll();
  } catch (err) {
    console.error("[collections] delete failed:", err.code || err);
  }
}

function renderSignedOut() {
  authControl.innerHTML = `
    <button id="auth-signin-btn" class="px-4 py-2 bg-gradient-to-r from-neonViolet to-neonPurple rounded-xl text-xs font-cyber font-bold tracking-wider text-white hover:scale-105 transition-all">
      <i class="fa-brands fa-google mr-2"></i> SIGN IN
    </button>`;
  document.getElementById("auth-signin-btn").addEventListener("click", () => {
    signInWithPopup(auth, googleProvider).catch((err) => console.error("Sign-in failed", err));
  });
  accessNote.classList.add("hidden");
  newBtn.classList.add("hidden");
}

async function renderSignedIn(user) {
  const name = await resolveDisplayName(user);
  authControl.innerHTML = `
    <span class="text-xs text-textGray font-code">${i18nT("common.signed_in_as")} <span class="text-white">${name}</span></span>
    <button id="auth-signout-btn" class="px-4 py-2 bg-cardBg/70 border border-borderNeon rounded-xl text-xs font-cyber font-bold tracking-wider text-white hover:border-neonPurple transition-all">
      ${i18nT("common.sign_out")}
    </button>`;
  document.getElementById("auth-signout-btn").addEventListener("click", () => signOut(auth));

  const mayParticipate = canParticipate();
  newBtn.classList.toggle("hidden", !mayParticipate);
  accessNote.classList.toggle("hidden", mayParticipate);
}

let autoOpenedFromQuickAdd = false;
function maybeAutoOpenFromQuickAdd(mayParticipate) {
  if (autoOpenedFromQuickAdd || !mayParticipate) return;
  const params = new URLSearchParams(location.search);
  const editId = params.get("edit");
  if (editId) {
    autoOpenedFromQuickAdd = true;
    openForm(editId);
    return;
  }
  if (params.get("new") === "1") {
    autoOpenedFromQuickAdd = true;
    openForm(null);
  }
}

onAuthStateChanged(auth, async (user) => {
  if (user) renderSignedIn(user);
  else renderSignedOut();
  await loadAll();
  maybeAutoOpenFromQuickAdd(!!user && canParticipate());
});

// ---- Create / Edit form ----

function setActiveColor(hex) {
  document.getElementById("collection-color").value = hex;
  document.querySelectorAll(".color-swatch").forEach((btn) => {
    btn.classList.toggle("border-white/40", btn.dataset.color === hex);
    btn.classList.toggle("border-transparent", btn.dataset.color !== hex);
  });
}

document.querySelectorAll(".color-swatch").forEach((btn) => {
  btn.addEventListener("click", () => setActiveColor(btn.dataset.color));
});

function openForm(id) {
  const c = id ? cachedCollections.find((x) => x.id === id) : null;
  document.getElementById("collection-form-id").value = id || "";
  modalTitle.textContent = id ? "Edit Collection" : "New Collection";
  document.getElementById("collection-title-en").value = c?.title_en || "";
  document.getElementById("collection-title-zh").value = c?.title_zh || "";
  document.getElementById("collection-description-en").value = c?.description_en || "";
  document.getElementById("collection-description-zh").value = c?.description_zh || "";
  document.getElementById("collection-icon").value = c?.icon || "layers";
  document.getElementById("collection-cover-url").value = c?.coverImageUrl || "";
  document.getElementById("collection-notes").value = c?.notes || "";
  setActiveColor(c?.color || "#a78bfa");
  document.querySelector(`#collection-form input[name="collection-visibility"][value="${c?.visibility || "public"}"]`).checked = true;
  coverPicker.classList.add("hidden");
  statusEl.textContent = "";
  modal.classList.remove("hidden");
}

function closeForm() {
  modal.classList.add("hidden");
  form.reset();
  statusEl.textContent = "";
}

newBtn.addEventListener("click", () => openForm(null));
modalClose.addEventListener("click", closeForm);
modalBackdrop.addEventListener("click", closeForm);

coverPickBtn.addEventListener("click", () => {
  const user = auth.currentUser;
  const mine = cachedPhotos.filter((p) => user && p.uid === user.uid);
  coverPicker.innerHTML = mine.length
    ? mine.slice(0, 30).map((p) => `<img src="${p.url}" data-url="${p.url}" class="cover-pick-thumb w-full h-14 object-cover rounded-md cursor-pointer border border-borderNeon hover:border-neonPurple transition-colors">`).join("")
    : `<p class="col-span-5 text-xs font-code text-textGray">${i18nT("common.none_yet")}</p>`;
  coverPicker.classList.toggle("hidden");
  coverPicker.querySelectorAll(".cover-pick-thumb").forEach((img) => {
    img.addEventListener("click", () => {
      document.getElementById("collection-cover-url").value = img.dataset.url;
      coverPicker.classList.add("hidden");
    });
  });
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const user = auth.currentUser;
  if (!user || !canParticipate()) return;

  const id = document.getElementById("collection-form-id").value;
  const payload = {
    uid: user.uid,
    title_en: document.getElementById("collection-title-en").value.trim(),
    title_zh: document.getElementById("collection-title-zh").value.trim(),
    description_en: document.getElementById("collection-description-en").value.trim(),
    description_zh: document.getElementById("collection-description-zh").value.trim(),
    icon: document.getElementById("collection-icon").value.trim() || "layers",
    color: document.getElementById("collection-color").value,
    coverImageUrl: document.getElementById("collection-cover-url").value.trim() || null,
    notes: document.getElementById("collection-notes").value.trim(),
    visibility: document.querySelector('#collection-form input[name="collection-visibility"]:checked').value,
    updatedAt: serverTimestamp(),
  };
  if (!payload.title_en) return;

  statusEl.textContent = i18nT("common.saving");
  try {
    if (id) {
      await updateDoc(doc(db, "collections", id), payload);
    } else {
      await addDoc(collection(db, "collections"), { ...payload, createdAt: serverTimestamp() });
    }
    statusEl.textContent = i18nT("common.saved");
    await loadAll();
    closeForm();
  } catch (err) {
    console.error("[collections] save failed:", err.code || err);
    statusEl.textContent = i18nT("common.couldnt_save");
  }
});
