import { auth, googleProvider, db, storage, canParticipate } from "./firebase-init.js";
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
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import {
  ref,
  uploadBytes,
  getDownloadURL,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-storage.js";

const MOOD_META = {
  happy: { emoji: "😊", label: "Happy" },
  calm: { emoji: "😌", label: "Calm" },
  excited: { emoji: "🎉", label: "Excited" },
  sad: { emoji: "😔", label: "Sad" },
  frustrated: { emoji: "😤", label: "Frustrated" },
  tired: { emoji: "😴", label: "Tired" },
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

let cachedEntries = [];
let activeVisibility = "all";
let activeMood = "all";
let searchQuery = "";
const expandedIds = new Set();

// Populate the mood <select> in the compose form and the mood filter chips from one source of truth.
Object.entries(MOOD_META).forEach(([key, meta]) => {
  const opt = document.createElement("option");
  opt.value = key;
  opt.textContent = `${meta.emoji} ${meta.label}`;
  moodSelect.appendChild(opt);

  const btn = document.createElement("button");
  btn.dataset.mood = key;
  btn.className = "mood-tab px-3 py-1.5 rounded-full hover:text-neonPurple hover:bg-neonPurple/10 transition-colors";
  btn.textContent = `${meta.emoji} ${meta.label}`;
  moodFilterContainer.appendChild(btn);
});

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

  card.innerHTML = `
    ${entry.imageUrl ? `<img src="${entry.imageUrl}" alt="" class="w-full h-40 object-cover">` : ""}
    <div class="p-4 space-y-2.5">
      <div class="flex items-start justify-between gap-3">
        <h2 class="text-sm font-semibold leading-snug">${mood ? `${mood.emoji} ` : ""}${entry.title}</h2>
        <span class="text-[10px] font-code px-2 py-0.5 rounded-full flex-shrink-0 border ${isPrivate ? "border-rose-400/30 bg-rose-400/10 text-rose-400" : "border-emerald-400/30 bg-emerald-400/10 text-emerald-400"}">
          <i class="fa-solid ${isPrivate ? "fa-lock" : "fa-globe"}"></i>
        </span>
      </div>
      <div class="text-sm text-textGray leading-relaxed journal-body">${expanded ? marked.parse(entry.content || "") : snippet(entry.content || "")}</div>
      <div class="flex flex-wrap items-center gap-1.5">${tagsHtml}</div>
      <p class="text-[11px] text-textGray/70 font-code">${formatTimestamp(entry.createdAt)}</p>
    </div>`;

  card.addEventListener("click", (event) => {
    if (event.target.closest("a")) return;
    if (expandedIds.has(key)) {
      expandedIds.delete(key);
    } else {
      expandedIds.add(key);
    }
    renderGrid();
  });

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

function renderSignedIn(user) {
  authControl.innerHTML = `
    <span class="text-xs text-textGray font-code">Signed in as <span class="text-white">${user.displayName || user.email}</span></span>
    <button id="auth-signout-btn" class="px-4 py-2 bg-cardBg/70 border border-borderNeon rounded-xl text-xs font-cyber font-bold tracking-wider text-white hover:border-neonPurple transition-all">
      SIGN OUT
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

newJournalBtn.addEventListener("click", openModal);
journalModalClose.addEventListener("click", closeModal);
journalModalBackdrop.addEventListener("click", closeModal);

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
  if (!title || !content) return;

  journalStatus.textContent = "Saving...";
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
    });

    journalStatus.textContent = "Saved.";
    await fetchVisibleEntries();
    closeModal();
  } catch (err) {
    console.error("Save failed", err);
    journalStatus.textContent = "Save failed — check console.";
  }
});
