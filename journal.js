import { auth, googleProvider, db, storage, canParticipate } from "./firebase-init.js";
import { t as i18nT, getLang, init as initI18n } from "./js/i18n.js";
import { resolveDisplayName } from "./js/identity.js";
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
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import {
  ref,
  uploadBytes,
  getDownloadURL,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-storage.js";

const MOOD_META = {
  happy: { emoji: "😊", i18nKey: "journal.mood_happy" },
  calm: { emoji: "😌", i18nKey: "journal.mood_calm" },
  excited: { emoji: "🎉", i18nKey: "journal.mood_excited" },
  sad: { emoji: "😔", i18nKey: "journal.mood_sad" },
  frustrated: { emoji: "😤", i18nKey: "journal.mood_frustrated" },
  tired: { emoji: "😴", i18nKey: "journal.mood_tired" },
};

const authControl = document.getElementById("auth-control");
const accessNote = document.getElementById("journal-access-note");
const searchInput = document.getElementById("journal-search");
const journalGrid = document.getElementById("journal-grid");
const journalEmpty = document.getElementById("journal-empty");
const filterTabs = document.querySelectorAll(".filter-tab");
const privateTab = document.querySelector('.filter-tab[data-filter="private"]');
const moodFilterContainer = document.getElementById("mood-filters");
const newJournalBtn = document.getElementById("new-journal-btn");
const journalModal = document.getElementById("journal-modal");
const journalModalClose = document.getElementById("journal-modal-close");
const journalModalBackdrop = document.getElementById("journal-modal-backdrop");
const journalForm = document.getElementById("journal-form");
const journalStatus = document.getElementById("journal-status");
const moodSelect = document.getElementById("journal-mood");
const journalEditModal = document.getElementById("journal-edit-modal");
const journalEditModalClose = document.getElementById("journal-edit-modal-close");
const journalEditModalBackdrop = document.getElementById("journal-edit-modal-backdrop");
const journalEditForm = document.getElementById("journal-edit-form");
const journalEditStatus = document.getElementById("journal-edit-status");

// Wraps the callback-based Geolocation API in a promise that never rejects — same pattern
// index.html's weather widget uses, duplicated per this codebase's per-page convention.
function getBrowserLocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      () => resolve(null),
      { timeout: 8000, maximumAge: 0 }
    );
  });
}

function wireUseLocationBtn(btn, nameInput, latInput, lonInput) {
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = "Locating...";
    const loc = await getBrowserLocation();
    btn.disabled = false;
    btn.textContent = original;
    if (!loc) return;
    latInput.value = loc.lat;
    lonInput.value = loc.lon;
    if (!nameInput.value.trim()) nameInput.value = `${loc.lat.toFixed(3)}, ${loc.lon.toFixed(3)}`;
  });
}

let cachedCollections = null;
async function loadMyCollectionOptions() {
  const user = auth.currentUser;
  if (!user) return [];
  if (cachedCollections) return cachedCollections;
  try {
    const snap = await getDocs(query(collection(db, "collections"), where("uid", "==", user.uid)));
    cachedCollections = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.error("[journal] collections fetch failed:", err.code || err);
    cachedCollections = [];
  }
  return cachedCollections;
}

function collectionLabel(c) {
  const lang = getLang() === "zh-CN" ? "zh" : "en";
  return (lang === "zh" ? c.title_zh : c.title_en) || c.title_en || c.title_zh || "Untitled";
}

async function populateCollectionSelect(selectEl, selectedId) {
  const cols = await loadMyCollectionOptions();
  selectEl.innerHTML = `<option value="">${i18nT("common.uncategorized")}</option>` +
    cols.map((c) => `<option value="${c.id}">${collectionLabel(c)}</option>`).join("");
  selectEl.value = selectedId || "";
}

let cachedEntries = [];
let activeVisibility = "all";
let activeMood = "all";
let searchQuery = "";
const expandedIds = new Set();

// Populate the mood <select> in the compose form and the mood filter chips from one source of
// truth. Re-run on language change (see eden:langchange listener below) since the labels are
// baked into these elements' textContent at creation time, not read live via data-i18n.
function renderMoodOptions() {
  const prevMoodValue = moodSelect.value;
  moodSelect.innerHTML = "";
  moodFilterContainer.querySelectorAll(".mood-tab[data-mood]:not([data-mood='all'])").forEach((b) => b.remove());

  Object.entries(MOOD_META).forEach(([key, meta]) => {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = `${meta.emoji} ${i18nT(meta.i18nKey)}`;
    moodSelect.appendChild(opt);

    const btn = document.createElement("button");
    btn.dataset.mood = key;
    btn.className = "mood-tab px-3 py-1.5 rounded-full hover:text-neonPurple hover:bg-neonPurple/10 transition-colors";
    btn.textContent = `${meta.emoji} ${i18nT(meta.i18nKey)}`;
    moodFilterContainer.appendChild(btn);
  });
  if (prevMoodValue) moodSelect.value = prevMoodValue;
}
// Wait for the dictionary to be ready before the first render — this runs synchronously at
// module load, ahead of any Firestore fetch, so (unlike postCard/journalCard/etc., which only
// ever render after an async auth+Firestore round trip has already given i18n.js time to load)
// it would otherwise have a real chance of painting raw "journal.mood_happy"-style keys.
initI18n().then(renderMoodOptions);

function formatTimestamp(ts) {
  if (!ts?.toDate) return "";
  return ts.toDate().toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function snippet(text, max = 160) {
  const flat = text.replace(/[#*_`>~-]/g, "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}&hellip;` : flat;
}

function entryKey(entry) {
  return `${entry.uid}-${entry.createdAt?.toMillis?.() || 0}-${entry.title}`;
}

const JOURNAL_REMINDER_DAYS = 3;

function todayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Best-effort local reminder: written by each user's own client when they next load this
// page, deduped per calendar day via localStorage (no backend to compute this server-side).
async function checkJournalReminder(entries) {
  const user = auth.currentUser;
  if (!user || !canParticipate()) return;

  const newestMillis = entries.reduce((latest, e) => Math.max(latest, e.createdAt?.toMillis?.() || 0), 0);
  const daysSince = newestMillis ? (Date.now() - newestMillis) / (1000 * 60 * 60 * 24) : Infinity;
  if (daysSince < JOURNAL_REMINDER_DAYS) return;

  const storageKey = "lfj:notifiedJournalReminder";
  const today = todayKey();
  if (localStorage.getItem(storageKey) === today) return;
  localStorage.setItem(storageKey, today);

  try {
    await addDoc(collection(db, "notifications"), {
      uid: user.uid,
      type: "journal_reminder",
      title: "Journal reminder",
      message: `No journal entries in ${JOURNAL_REMINDER_DAYS} days.`,
      read: false,
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    console.error("[journal] reminder notification failed:", err.code || err);
  }
}

function journalCard(entry) {
  const mood = MOOD_META[entry.mood] || null;
  const isPrivate = entry.visibility === "private";
  const key = entryKey(entry);
  const expanded = expandedIds.has(key);

  const card = document.createElement("article");
  card.className = "is-visible bg-cardBg/90 neon-border-purple rounded-2xl overflow-hidden cursor-pointer";
  card.dataset.key = key;

  const tagsHtml = (entry.tags || [])
    .map((t) => `<span class="text-[10px] font-code px-2 py-0.5 rounded-full border border-borderNeon text-textGray">#${t}</span>`)
    .join(" ");
  const user = auth.currentUser;
  const isMine = !!user && entry.uid === user.uid;

  card.innerHTML = `
    ${entry.imageUrl ? `<img src="${entry.imageUrl}" alt="" class="w-full h-40 object-cover">` : ""}
    <div class="p-4 space-y-2.5">
      <div class="flex items-start justify-between gap-3">
        <h2 class="text-sm font-semibold leading-snug">${mood ? `${mood.emoji} ` : ""}${entry.title}</h2>
        <div class="flex items-center gap-1.5 flex-shrink-0">
          <span class="text-[10px] font-code px-2 py-0.5 rounded-full border ${isPrivate ? "border-rose-400/30 bg-rose-400/10 text-rose-400" : "border-emerald-400/30 bg-emerald-400/10 text-emerald-400"}">
            <i class="fa-solid ${isPrivate ? "fa-lock" : "fa-globe"}"></i>
          </span>
          ${isMine ? `<button class="edit-entry-btn text-textGray hover:text-neonPurple transition-colors" title="${i18nT("common.edit_metadata")}"><i class="fa-solid fa-pen text-xs"></i></button>` : ""}
        </div>
      </div>
      <div class="text-sm text-textGray leading-relaxed journal-body">${expanded ? marked.parse(entry.content || "") : snippet(entry.content || "")}</div>
      <div class="flex flex-wrap items-center gap-1.5">${tagsHtml}${entry.locationName ? `<span class="text-[10px] font-code px-2 py-0.5 rounded-full border border-borderNeon text-textGray"><i class="fa-solid fa-location-dot mr-1"></i>${entry.locationName}</span>` : ""}</div>
      <p class="text-[11px] text-textGray/70 font-code">${formatTimestamp(entry.createdAt)}</p>
    </div>`;

  card.addEventListener("click", (event) => {
    if (event.target.closest("a") || event.target.closest(".edit-entry-btn")) return;
    if (expandedIds.has(key)) {
      expandedIds.delete(key);
    } else {
      expandedIds.add(key);
    }
    renderGrid();
  });

  const editBtn = card.querySelector(".edit-entry-btn");
  if (editBtn) {
    editBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      openEditModal(entry);
    });
  }

  return card;
}

function visibleEntries() {
  const q = searchQuery.trim().toLowerCase();
  return cachedEntries.filter((e) => {
    if (activeVisibility !== "all" && e.visibility !== activeVisibility) return false;
    if (activeMood !== "all" && e.mood !== activeMood) return false;
    if (!q) return true;
    const inTitle = e.title?.toLowerCase().includes(q);
    const inContent = e.content?.toLowerCase().includes(q);
    const inTags = (e.tags || []).some((t) => t.toLowerCase().includes(q));
    return inTitle || inContent || inTags;
  });
}

function renderGrid() {
  const visible = visibleEntries();
  journalGrid.replaceChildren(...visible.map(journalCard));
  journalEmpty.classList.toggle("hidden", visible.length > 0);
}

function setVisibilityFilter(filter) {
  activeVisibility = filter;
  filterTabs.forEach((btn) => {
    const active = btn.dataset.filter === filter;
    btn.classList.toggle("text-white", active);
    btn.classList.toggle("bg-neonPurple/15", active);
  });
  renderGrid();
}

function setMoodFilter(mood) {
  activeMood = mood;
  document.querySelectorAll(".mood-tab").forEach((btn) => {
    const active = btn.dataset.mood === mood;
    btn.classList.toggle("text-white", active);
    btn.classList.toggle("bg-neonPurple/15", active);
  });
  renderGrid();
}

filterTabs.forEach((btn) => btn.addEventListener("click", () => setVisibilityFilter(btn.dataset.filter)));
moodFilterContainer.addEventListener("click", (event) => {
  const btn = event.target.closest(".mood-tab");
  if (btn) setMoodFilter(btn.dataset.mood);
});
searchInput.addEventListener("input", (event) => {
  searchQuery = event.target.value;
  renderGrid();
});

setVisibilityFilter("all");
setMoodFilter("all");

async function fetchVisibleEntries() {
  const user = auth.currentUser;
  const entries = new Map();

  try {
    const publicSnap = await getDocs(query(collection(db, "journals"), where("visibility", "==", "public")));
    publicSnap.forEach((d) => entries.set(d.id, { id: d.id, ...d.data() }));
  } catch (err) {
    console.error("[journal] public query failed:", err.code || err);
  }

  if (user) {
    try {
      const mineSnap = await getDocs(query(collection(db, "journals"), where("uid", "==", user.uid)));
      mineSnap.forEach((d) => entries.set(d.id, { id: d.id, ...d.data() }));
    } catch (err) {
      console.error("[journal] own entries query failed:", err.code || err);
    }
  }

  const mayParticipate = canParticipate();
  privateTab.classList.toggle("hidden", !mayParticipate);
  accessNote.classList.toggle("hidden", mayParticipate);
  if (!mayParticipate && activeVisibility === "private") setVisibilityFilter("all");

  const list = [...entries.values()];
  list.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
  cachedEntries = list;
  renderGrid();
  if (user) checkJournalReminder(list.filter((e) => e.uid === user.uid));
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
  privateTab.classList.add("hidden");
  newJournalBtn.classList.add("hidden");
  if (activeVisibility === "private") setVisibilityFilter("all");
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
  newJournalBtn.classList.toggle("hidden", !mayParticipate);
  maybeAutoOpenFromQuickAdd(mayParticipate);
}

// Mobile Quick Add (js/mobile-nav.js) links here with ?new=1 to jump straight into the form.
let autoOpenedFromQuickAdd = false;
function maybeAutoOpenFromQuickAdd(mayParticipate) {
  if (autoOpenedFromQuickAdd || !mayParticipate) return;
  if (new URLSearchParams(location.search).get("new") === "1") {
    autoOpenedFromQuickAdd = true;
    openModal();
  }
}

onAuthStateChanged(auth, (user) => {
  if (user) {
    renderSignedIn(user);
  } else {
    renderSignedOut();
  }
  fetchVisibleEntries();
});

function openModal() {
  journalModal.classList.remove("hidden");
}
function closeModal() {
  journalModal.classList.add("hidden");
  journalForm.reset();
  journalStatus.textContent = "";
}

newJournalBtn.addEventListener("click", () => populateCollectionSelect(document.getElementById("journal-collection")));
newJournalBtn.addEventListener("click", openModal);
journalModalClose.addEventListener("click", closeModal);
journalModalBackdrop.addEventListener("click", closeModal);

wireUseLocationBtn(
  document.getElementById("journal-use-location-btn"),
  document.getElementById("journal-location-name"),
  document.getElementById("journal-latitude"),
  document.getElementById("journal-longitude")
);
wireUseLocationBtn(
  document.getElementById("journal-edit-use-location-btn"),
  document.getElementById("journal-edit-location-name"),
  document.getElementById("journal-edit-latitude"),
  document.getElementById("journal-edit-longitude")
);

journalForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const user = auth.currentUser;
  if (!user || !canParticipate()) return;

  const title = document.getElementById("journal-title").value.trim();
  const content = document.getElementById("journal-content").value.trim();
  const mood = moodSelect.value;
  const tags = document.getElementById("journal-tags").value
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const visibility = journalForm.querySelector('input[name="journal-visibility"]:checked').value;
  const file = document.getElementById("journal-image").files[0];
  const collectionId = document.getElementById("journal-collection").value || null;
  const locationName = document.getElementById("journal-location-name").value.trim() || null;
  const latRaw = document.getElementById("journal-latitude").value;
  const lonRaw = document.getElementById("journal-longitude").value;
  if (!title || !content) return;

  journalStatus.textContent = i18nT("common.saving");
  try {
    let imageUrl = null;
    if (file) {
      const storagePath = `journal/${user.uid}/${visibility}/${Date.now()}-${file.name}`;
      const fileRef = ref(storage, storagePath);
      await uploadBytes(fileRef, file);
      imageUrl = await getDownloadURL(fileRef);
    }

    await addDoc(collection(db, "journals"), {
      title,
      content,
      mood,
      tags,
      visibility,
      imageUrl,
      createdAt: serverTimestamp(),
      uid: user.uid,
      collectionId,
      locationName,
      latitude: latRaw ? Number(latRaw) : null,
      longitude: lonRaw ? Number(lonRaw) : null,
    });

    journalStatus.textContent = i18nT("common.saved");
    await fetchVisibleEntries();
    closeModal();
  } catch (err) {
    console.error("Save failed", err);
    journalStatus.textContent = i18nT("common.couldnt_save");
  }
});

// ---- Edit metadata ----

async function openEditModal(entry) {
  document.getElementById("journal-edit-id").value = entry.id;
  document.getElementById("journal-edit-title").value = entry.title || "";
  document.getElementById("journal-edit-content").value = entry.content || "";
  document.querySelector(`#journal-edit-form input[name="journal-edit-visibility"][value="${entry.visibility || "public"}"]`).checked = true;
  document.getElementById("journal-edit-tags").value = (entry.tags || []).join(", ");
  document.getElementById("journal-edit-location-name").value = entry.locationName || "";
  document.getElementById("journal-edit-latitude").value = entry.latitude ?? "";
  document.getElementById("journal-edit-longitude").value = entry.longitude ?? "";
  await populateCollectionSelect(document.getElementById("journal-edit-collection"), entry.collectionId);
  journalEditStatus.textContent = "";
  journalEditModal.classList.remove("hidden");
}
function closeEditModal() {
  journalEditModal.classList.add("hidden");
  journalEditForm.reset();
  journalEditStatus.textContent = "";
}
journalEditModalClose.addEventListener("click", closeEditModal);
journalEditModalBackdrop.addEventListener("click", closeEditModal);

journalEditForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const user = auth.currentUser;
  if (!user) return;
  const id = document.getElementById("journal-edit-id").value;
  const entry = cachedEntries.find((e) => e.id === id);
  if (!entry || entry.uid !== user.uid) return;

  const latRaw = document.getElementById("journal-edit-latitude").value;
  const lonRaw = document.getElementById("journal-edit-longitude").value;
  const payload = {
    title: document.getElementById("journal-edit-title").value.trim(),
    content: document.getElementById("journal-edit-content").value.trim(),
    visibility: document.querySelector('#journal-edit-form input[name="journal-edit-visibility"]:checked').value,
    tags: document.getElementById("journal-edit-tags").value.split(",").map((t) => t.trim()).filter(Boolean),
    collectionId: document.getElementById("journal-edit-collection").value || null,
    locationName: document.getElementById("journal-edit-location-name").value.trim() || null,
    latitude: latRaw ? Number(latRaw) : null,
    longitude: lonRaw ? Number(lonRaw) : null,
    updatedAt: serverTimestamp(),
  };
  try {
    await updateDoc(doc(db, "journals", id), payload);
    journalEditStatus.textContent = i18nT("common.saved");
    await fetchVisibleEntries();
    closeEditModal();
  } catch (err) {
    console.error("[journal] edit save failed:", err.code || err);
    journalEditStatus.textContent = i18nT("common.couldnt_save");
  }
});

// Re-render mood options/chips and cached entries (labels, "Edit metadata" title) whenever the
// language switcher fires.
document.addEventListener("eden:langchange", () => {
  renderMoodOptions();
  setMoodFilter(activeMood);
  renderGrid();
});
