import { auth, googleProvider, db, canParticipate } from "./firebase-init.js";
import { t as i18nT, getLang } from "./js/i18n.js";
import { wirePlaceSearch } from "./js/location-search.js";
import { readLocationFields, wireExactLocationControls } from "./js/location-fields.js";
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
  Timestamp,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

const TYPE_META = {
  career: { label: "Career", icon: "fa-briefcase", text: "text-neonBlue", bg: "bg-neonBlue/10", border: "border-neonBlue/30" },
  education: { label: "Education", icon: "fa-graduation-cap", text: "text-neonPurple", bg: "bg-neonPurple/10", border: "border-neonPurple/30" },
  travel: { label: "Travel", icon: "fa-plane", text: "text-amber-400", bg: "bg-amber-400/10", border: "border-amber-400/30" },
  personal: { label: "Personal", icon: "fa-heart", text: "text-rose-400", bg: "bg-rose-400/10", border: "border-rose-400/30" },
};

const authControl = document.getElementById("auth-control");
const accessNote = document.getElementById("timeline-access-note");
const searchInput = document.getElementById("timeline-search");
const timelineContainer = document.getElementById("timeline-container");
const timelineEmpty = document.getElementById("timeline-empty");
const filterTabs = document.querySelectorAll(".filter-tab");
const privateTab = document.querySelector('.filter-tab[data-filter="private"]');
const connectionsTab = document.querySelector('.filter-tab[data-filter="connections"]');
const newEventBtn = document.getElementById("new-event-btn");
const eventModal = document.getElementById("event-modal");
const eventModalClose = document.getElementById("event-modal-close");
const eventModalBackdrop = document.getElementById("event-modal-backdrop");
const eventForm = document.getElementById("event-form");
const eventStatus = document.getElementById("event-status");
const eventEditModal = document.getElementById("event-edit-modal");
const eventEditModalClose = document.getElementById("event-edit-modal-close");
const eventEditModalBackdrop = document.getElementById("event-edit-modal-backdrop");
const eventEditForm = document.getElementById("event-edit-form");
const eventEditStatus = document.getElementById("event-edit-status");

let cachedEvents = [];
let activeFilter = "all";
let searchQuery = "";
const expandedIds = new Set();


let cachedCollections = null;
async function loadMyCollectionOptions() {
  const user = auth.currentUser;
  if (!user) return [];
  if (cachedCollections) return cachedCollections;
  try {
    const snap = await getDocs(query(collection(db, "collections"), where("uid", "==", user.uid)));
    cachedCollections = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.error("[timeline] collections fetch failed:", err.code || err);
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

function eventKey(event) {
  return `${event.uid}-${event.date?.toMillis?.() || 0}-${event.title}`;
}

function formatDate(ts) {
  if (!ts?.toDate) return "";
  return ts.toDate().toLocaleDateString(undefined, { month: "long", day: "numeric" });
}

function matchesSearch(event, q) {
  if (!q) return true;
  const year = event.date?.toDate?.()?.getFullYear().toString();
  return (
    event.title?.toLowerCase().includes(q) ||
    event.description?.toLowerCase().includes(q) ||
    year === q
  );
}

function visibleEvents() {
  const q = searchQuery.trim().toLowerCase();
  return cachedEvents.filter((e) => {
    if (activeFilter === "public" || activeFilter === "private" || activeFilter === "connections") {
      if (e.visibility !== activeFilter) return false;
    } else if (activeFilter !== "all" && e.type !== activeFilter) {
      return false;
    }
    return matchesSearch(e, q);
  });
}

function visibilityBadge(visibility) {
  if (visibility === "private") return { icon: "fa-lock", cls: "border-rose-400/30 bg-rose-400/10 text-rose-400" };
  if (visibility === "connections") return { icon: "fa-user-group", cls: "border-neonBlue/30 bg-neonBlue/10 text-neonBlue" };
  return { icon: "fa-globe", cls: "border-emerald-400/30 bg-emerald-400/10 text-emerald-400" };
}

function eventRow(event) {
  const meta = TYPE_META[event.type] || TYPE_META.personal;
  const vis = visibilityBadge(event.visibility);
  const key = eventKey(event);
  const expanded = expandedIds.has(key);

  const user = auth.currentUser;
  const isMine = !!user && event.uid === user.uid;

  const row = document.createElement("div");
  row.className = "is-visible relative pl-8";
  row.innerHTML = `
    <span class="absolute left-0 top-1 w-3 h-3 rounded-full ${meta.bg} border-2 ${meta.border}"></span>
    <div class="cursor-pointer">
      <div class="flex items-start justify-between gap-3">
        <div>
          <p class="text-[11px] font-code text-textGray">${formatDate(event.date)}</p>
          <h3 class="text-sm font-semibold mt-0.5">${event.title}</h3>
        </div>
        <div class="flex items-center gap-1.5 flex-shrink-0">
          <span class="text-[10px] font-code px-2 py-0.5 rounded-full border ${meta.border} ${meta.bg} ${meta.text}">
            <i class="fa-solid ${meta.icon} mr-1"></i>${meta.label}
          </span>
          <span class="text-[10px] font-code px-2 py-0.5 rounded-full border ${vis.cls}">
            <i class="fa-solid ${vis.icon}"></i>
          </span>
          ${isMine ? `<button class="edit-event-btn text-textGray hover:text-neonPurple transition-colors" title="${i18nT("common.edit_metadata")}"><i class="fa-solid fa-pen text-xs"></i></button>` : ""}
        </div>
      </div>
      ${event.description ? `<p class="text-xs text-textGray mt-2 leading-relaxed ${expanded ? "" : "hidden"}">${event.description}</p>` : ""}
      ${(event.tags || []).length || event.locationName ? `
        <div class="flex flex-wrap items-center gap-1.5 mt-2">
          ${(event.tags || []).map((t) => `<span class="text-[10px] font-code px-2 py-0.5 rounded-full border border-borderNeon text-textGray">#${t}</span>`).join("")}
          ${event.locationName ? `<span class="text-[10px] font-code px-2 py-0.5 rounded-full border border-borderNeon text-textGray"><i class="fa-solid fa-location-dot mr-1"></i>${event.locationName}</span>` : ""}
        </div>` : ""}
    </div>`;

  if (event.description) {
    row.querySelector(".cursor-pointer").addEventListener("click", (e) => {
      if (e.target.closest(".edit-event-btn")) return;
      if (expandedIds.has(key)) {
        expandedIds.delete(key);
      } else {
        expandedIds.add(key);
      }
      renderTimeline();
    });
  }

  const editBtn = row.querySelector(".edit-event-btn");
  if (editBtn) {
    editBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openEditModal(event);
    });
  }

  return row;
}

function renderTimeline() {
  const visible = visibleEvents();
  const groups = new Map();
  visible.forEach((e) => {
    const year = e.date?.toDate?.()?.getFullYear() || "Unknown";
    if (!groups.has(year)) groups.set(year, []);
    groups.get(year).push(e);
  });

  const sections = [...groups.entries()].map(([year, events]) => {
    const section = document.createElement("section");
    section.className = "is-visible";
    const heading = document.createElement("h2");
    heading.className = "font-cyber font-semibold text-lg text-neonPurple mb-4";
    heading.textContent = year;
    const list = document.createElement("div");
    list.className = "space-y-5 border-l border-borderNeon";
    events.forEach((e) => list.appendChild(eventRow(e)));
    section.appendChild(heading);
    section.appendChild(list);
    return section;
  });

  timelineContainer.replaceChildren(...sections);
  timelineEmpty.classList.toggle("hidden", visible.length > 0);
}

function setFilter(filter) {
  activeFilter = filter;
  filterTabs.forEach((btn) => {
    const active = btn.dataset.filter === filter;
    btn.classList.toggle("text-white", active);
    btn.classList.toggle("bg-neonPurple/15", active);
  });
  renderTimeline();
}

filterTabs.forEach((btn) => btn.addEventListener("click", () => setFilter(btn.dataset.filter)));
searchInput.addEventListener("input", (event) => {
  searchQuery = event.target.value;
  renderTimeline();
});

setFilter("all");

async function fetchVisibleEvents() {
  const user = auth.currentUser;
  const events = new Map();

  try {
    const publicSnap = await getDocs(query(collection(db, "life_events"), where("visibility", "==", "public")));
    publicSnap.forEach((d) => events.set(d.id, { id: d.id, ...d.data() }));
  } catch (err) {
    console.error("[timeline] public query failed:", err.code || err);
  }

  if (user) {
    try {
      const mineSnap = await getDocs(query(collection(db, "life_events"), where("uid", "==", user.uid)));
      mineSnap.forEach((d) => events.set(d.id, { id: d.id, ...d.data() }));
    } catch (err) {
      console.error("[timeline] own events query failed:", err.code || err);
    }
  }

  const mayParticipate = canParticipate();
  privateTab.classList.toggle("hidden", !mayParticipate);
  connectionsTab.classList.toggle("hidden", !mayParticipate);
  accessNote.classList.toggle("hidden", mayParticipate);
  if (!mayParticipate && (activeFilter === "private" || activeFilter === "connections")) setFilter("all");

  const list = [...events.values()];
  list.sort((a, b) => (b.date?.toMillis?.() || 0) - (a.date?.toMillis?.() || 0));
  cachedEvents = list;
  renderTimeline();
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
  connectionsTab.classList.add("hidden");
  newEventBtn.classList.add("hidden");
  if (activeFilter === "private" || activeFilter === "connections") setFilter("all");
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
  newEventBtn.classList.toggle("hidden", !mayParticipate);
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
  fetchVisibleEvents();
});

function openModal() {
  eventModal.classList.remove("hidden");
}
function closeModal() {
  eventModal.classList.add("hidden");
  eventForm.reset();
  eventStatus.textContent = "";
}

newEventBtn.addEventListener("click", () => populateCollectionSelect(document.getElementById("event-collection")));
newEventBtn.addEventListener("click", openModal);
eventModalClose.addEventListener("click", closeModal);
eventModalBackdrop.addEventListener("click", closeModal);

const syncEventLocation = wireExactLocationControls("event", i18nT);
const syncEventEditLocation = wireExactLocationControls("event-edit", i18nT);
wirePlaceSearch("event", syncEventLocation);
const eventEditPlaceSearch = wirePlaceSearch("event-edit", syncEventEditLocation);

function dateToInputValue(ts) {
  const d = ts?.toDate?.();
  if (!d) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

eventForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const user = auth.currentUser;
  if (!user || !canParticipate()) return;

  const title = document.getElementById("event-title").value.trim();
  const description = document.getElementById("event-description").value.trim();
  const dateValue = document.getElementById("event-date").value;
  const type = document.getElementById("event-type").value;
  const visibility = eventForm.querySelector('input[name="event-visibility"]:checked').value;
  const collectionId = document.getElementById("event-collection").value || null;
  const tags = document.getElementById("event-tags").value.split(",").map((t) => t.trim()).filter(Boolean);
  if (!title || !dateValue) return;

  eventStatus.textContent = i18nT("common.saving");
  try {
    const [year, month, day] = dateValue.split("-").map(Number);
    const date = Timestamp.fromDate(new Date(year, month - 1, day));

    const locationFields = readLocationFields("event");
    await addDoc(collection(db, "life_events"), {
      title,
      description,
      date,
      type,
      visibility,
      uid: user.uid,
      collectionId,
      tags,
      ...locationFields,
    });

    await fetchVisibleEvents();
    // Phase 4 UX: give a "View on Atlas" way out when this event actually carries valid
    // coordinates, instead of instantly wiping the success message via closeModal().
    if (locationFields.latitude != null && locationFields.longitude != null) {
      eventStatus.replaceChildren(document.createTextNode(`${i18nT("common.saved")} · `));
      const link = document.createElement("a");
      link.href = "atlas.html";
      link.className = "text-neonPurple hover:underline";
      link.textContent = i18nT("common.view_on_atlas");
      eventStatus.appendChild(link);
      setTimeout(closeModal, 2500);
    } else {
      eventStatus.textContent = i18nT("common.saved");
      closeModal();
    }
  } catch (err) {
    console.error("Save failed", err);
    eventStatus.textContent = i18nT("common.couldnt_save");
  }
});

// ---- Edit metadata ----

async function openEditModal(event) {
  document.getElementById("event-edit-id").value = event.id;
  document.getElementById("event-edit-title").value = event.title || "";
  document.getElementById("event-edit-description").value = event.description || "";
  document.getElementById("event-edit-date").value = dateToInputValue(event.date);
  document.getElementById("event-edit-type").value = event.type;
  document.querySelector(`#event-edit-form input[name="event-edit-visibility"][value="${event.visibility || "public"}"]`).checked = true;
  document.getElementById("event-edit-tags").value = (event.tags || []).join(", ");
  document.getElementById("event-edit-location-name").value = event.locationName || "";
  document.getElementById("event-edit-location-address").value = event.locationAddress || "";
  document.getElementById("event-edit-latitude").value = event.latitude ?? "";
  document.getElementById("event-edit-longitude").value = event.longitude ?? "";
  const isPlaceResolved = event.latitude != null && event.longitude != null && event.locationPrecision === "place_resolved";
  document.getElementById("event-edit-location-precision-hint").value = isPlaceResolved ? "place_resolved" : "";
  // See gallery.js's openEditModal for why this call matters: without it, a no-op "input"
  // event during this edit session could be mistaken for a manual rename and silently drop
  // these valid, already-confirmed coordinates before save.
  eventEditPlaceSearch.confirmPlace(isPlaceResolved ? event.locationName : null);
  syncEventEditLocation();
  await populateCollectionSelect(document.getElementById("event-edit-collection"), event.collectionId);
  eventEditStatus.textContent = "";
  eventEditModal.classList.remove("hidden");
}
function closeEditModal() {
  eventEditModal.classList.add("hidden");
  eventEditForm.reset();
  eventEditStatus.textContent = "";
}
eventEditModalClose.addEventListener("click", closeEditModal);
eventEditModalBackdrop.addEventListener("click", closeEditModal);

eventEditForm.addEventListener("submit", async (evt) => {
  evt.preventDefault();
  const user = auth.currentUser;
  if (!user) return;
  const id = document.getElementById("event-edit-id").value;
  const event = cachedEvents.find((e) => e.id === id);
  if (!event || event.uid !== user.uid) return;

  const dateValue = document.getElementById("event-edit-date").value;
  const [year, month, day] = dateValue.split("-").map(Number);
  const payload = {
    title: document.getElementById("event-edit-title").value.trim(),
    description: document.getElementById("event-edit-description").value.trim(),
    date: Timestamp.fromDate(new Date(year, month - 1, day)),
    type: document.getElementById("event-edit-type").value,
    visibility: document.querySelector('#event-edit-form input[name="event-edit-visibility"]:checked').value,
    collectionId: document.getElementById("event-edit-collection").value || null,
    tags: document.getElementById("event-edit-tags").value.split(",").map((t) => t.trim()).filter(Boolean),
    ...readLocationFields("event-edit"),
    updatedAt: serverTimestamp(),
  };
  try {
    await updateDoc(doc(db, "life_events", id), payload);
    // Same opt-in switch as atlas.js — verifies exactly what the edit wrote to Firestore.
    if (localStorage.getItem("eden_atlas_debug") === "1") console.log("[timeline:debug] edit saved", id, payload);
    eventEditStatus.textContent = i18nT("common.saved");
    await fetchVisibleEvents();
    closeEditModal();
  } catch (err) {
    console.error("[timeline] edit save failed:", err.code || err);
    eventEditStatus.textContent = i18nT("common.couldnt_save");
  }
});

// Re-render from the already-fetched cachedEvents ("Edit metadata" title, and anything else
// read through i18nT()) whenever the language switcher fires.
document.addEventListener("eden:langchange", () => {
  renderTimeline();
});
