import { auth, googleProvider, db, canParticipate } from "./firebase-init.js";
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
const newEventBtn = document.getElementById("new-event-btn");
const eventModal = document.getElementById("event-modal");
const eventModalClose = document.getElementById("event-modal-close");
const eventModalBackdrop = document.getElementById("event-modal-backdrop");
const eventForm = document.getElementById("event-form");
const eventStatus = document.getElementById("event-status");

let cachedEvents = [];
let activeFilter = "all";
let searchQuery = "";
const expandedIds = new Set();

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
    if (activeFilter === "public" || activeFilter === "private") {
      if (e.visibility !== activeFilter) return false;
    } else if (activeFilter !== "all" && e.type !== activeFilter) {
      return false;
    }
    return matchesSearch(e, q);
  });
}

function eventRow(event) {
  const meta = TYPE_META[event.type] || TYPE_META.personal;
  const isPrivate = event.visibility === "private";
  const key = eventKey(event);
  const expanded = expandedIds.has(key);

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
          <span class="text-[10px] font-code px-2 py-0.5 rounded-full border ${isPrivate ? "border-rose-400/30 bg-rose-400/10 text-rose-400" : "border-emerald-400/30 bg-emerald-400/10 text-emerald-400"}">
            <i class="fa-solid ${isPrivate ? "fa-lock" : "fa-globe"}"></i>
          </span>
        </div>
      </div>
      ${event.description ? `<p class="text-xs text-textGray mt-2 leading-relaxed ${expanded ? "" : "hidden"}">${event.description}</p>` : ""}
    </div>`;

  if (event.description) {
    row.addEventListener("click", () => {
      if (expandedIds.has(key)) {
        expandedIds.delete(key);
      } else {
        expandedIds.add(key);
      }
      renderTimeline();
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
  accessNote.classList.toggle("hidden", mayParticipate);
  if (!mayParticipate && activeFilter === "private") setFilter("all");

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
  newEventBtn.classList.add("hidden");
  if (activeFilter === "private") setFilter("all");
}

function renderSignedIn(user) {
  authControl.innerHTML = `
    <span class="text-xs text-textGray font-code">Signed in as <span class="text-white">${user.displayName || user.email}</span></span>
    <button id="auth-signout-btn" class="px-4 py-2 bg-cardBg/70 border border-borderNeon rounded-xl text-xs font-cyber font-bold tracking-wider text-white hover:border-neonPurple transition-all">
      SIGN OUT
    </button>`;
  document.getElementById("auth-signout-btn").addEventListener("click", () => signOut(auth));

  newEventBtn.classList.toggle("hidden", !canParticipate());
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

newEventBtn.addEventListener("click", openModal);
eventModalClose.addEventListener("click", closeModal);
eventModalBackdrop.addEventListener("click", closeModal);

eventForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const user = auth.currentUser;
  if (!user || !canParticipate()) return;

  const title = document.getElementById("event-title").value.trim();
  const description = document.getElementById("event-description").value.trim();
  const dateValue = document.getElementById("event-date").value;
  const type = document.getElementById("event-type").value;
  const visibility = eventForm.querySelector('input[name="event-visibility"]:checked').value;
  if (!title || !dateValue) return;

  eventStatus.textContent = "Saving...";
  try {
    const [year, month, day] = dateValue.split("-").map(Number);
    const date = Timestamp.fromDate(new Date(year, month - 1, day));

    await addDoc(collection(db, "life_events"), {
      title,
      description,
      date,
      type,
      visibility,
      uid: user.uid,
    });

    eventStatus.textContent = "Saved.";
    await fetchVisibleEvents();
    closeModal();
  } catch (err) {
    console.error("Save failed", err);
    eventStatus.textContent = "Save failed — check console.";
  }
});
