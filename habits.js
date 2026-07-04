import { auth, googleProvider, db, isOwner } from "./firebase-init.js";
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
  arrayUnion,
  arrayRemove,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

const authControl = document.getElementById("auth-control");
const accessNote = document.getElementById("habits-access-note");
const habitsContainer = document.getElementById("habits-container");
const habitsEmpty = document.getElementById("habits-empty");
const filterTabs = document.querySelectorAll(".filter-tab");
const privateTab = document.querySelector('.filter-tab[data-filter="private"]');
const newHabitBtn = document.getElementById("new-habit-btn");
const habitModal = document.getElementById("habit-modal");
const habitModalClose = document.getElementById("habit-modal-close");
const habitModalBackdrop = document.getElementById("habit-modal-backdrop");
const habitForm = document.getElementById("habit-form");
const habitStatus = document.getElementById("habit-status");
const habitIconInput = document.getElementById("habit-icon");

let cachedHabits = [];
let activeFilter = "all";

function toDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function computeStreak(completedDates) {
  const set = new Set(completedDates || []);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const cursor = new Date(today);
  if (!set.has(toDateKey(cursor))) cursor.setDate(cursor.getDate() - 1);

  let streak = 0;
  while (set.has(toDateKey(cursor))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

function last7Days(completedDates) {
  const set = new Set(completedDates || []);
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push({ label: d.toLocaleDateString(undefined, { weekday: "narrow" }), done: set.has(toDateKey(d)) });
  }
  return days;
}

function monthlyCompletion(completedDates) {
  const set = new Set(completedDates || []);
  const now = new Date();
  const daysElapsed = now.getDate();
  let completed = 0;
  for (let day = 1; day <= daysElapsed; day++) {
    if (set.has(toDateKey(new Date(now.getFullYear(), now.getMonth(), day)))) completed++;
  }
  return Math.round((completed / daysElapsed) * 100);
}

function habitCard(habit) {
  const streak = computeStreak(habit.completedDates);
  const todayKey = toDateKey(new Date());
  const checkedToday = (habit.completedDates || []).includes(todayKey);
  const monthPct = monthlyCompletion(habit.completedDates);
  const week = last7Days(habit.completedDates);
  const isPrivate = habit.visibility === "private";
  const canCheckIn = isOwner(auth.currentUser);

  const card = document.createElement("div");
  card.className = "is-visible bg-cardBg/90 neon-border-purple rounded-2xl p-5 flex flex-col gap-4";
  card.innerHTML = `
    <div class="flex items-start justify-between gap-3">
      <div class="flex items-center gap-3">
        <div class="w-11 h-11 rounded-xl bg-neonPurple/10 flex items-center justify-center text-xl">${habit.icon || "✅"}</div>
        <div>
          <p class="font-semibold text-sm">${habit.title}</p>
          <p class="text-[11px] font-code text-textGray mt-0.5">
            <i class="fa-solid ${isPrivate ? "fa-lock" : "fa-globe"} mr-1"></i>${isPrivate ? "Private" : "Public"}
          </p>
        </div>
      </div>
      <div class="relative w-12 h-12 rounded-full flex items-center justify-center flex-shrink-0" style="background:conic-gradient(#a78bfa ${monthPct * 3.6}deg, #2a2833 0deg)">
        <div class="absolute inset-1 rounded-full bg-cardBg flex items-center justify-center text-[10px] font-code text-white">${monthPct}%</div>
      </div>
    </div>
    <div class="flex items-center gap-1.5">
      ${week.map((d) => `
        <div class="flex-1 flex flex-col items-center gap-1">
          <span class="text-[9px] font-code text-textGray">${d.label}</span>
          <span class="w-6 h-6 rounded-full flex items-center justify-center text-[10px] ${d.done ? "bg-neonPurple/25 text-neonPurple" : "bg-darkBg/60 text-textGray border border-borderNeon"}">
            ${d.done ? '<i class="fa-solid fa-check"></i>' : ""}
          </span>
        </div>`).join("")}
    </div>
    <div class="flex items-center justify-between pt-3 border-t border-borderNeon/40">
      <span class="inline-flex items-center gap-1.5 text-xs font-code text-amber-400 font-semibold">
        <i class="fa-solid fa-fire"></i> ${streak} day${streak === 1 ? "" : "s"}
      </span>
      <button class="checkin-btn px-3 py-1.5 rounded-lg text-xs font-cyber font-bold tracking-wider transition-all ${checkedToday ? "bg-emerald-400/15 text-emerald-400" : "bg-neonPurple/15 text-neonPurple hover:bg-neonPurple/25"}" ${canCheckIn ? "" : "disabled"}>
        ${checkedToday ? '<i class="fa-solid fa-check mr-1"></i> Done Today' : "Check In"}
      </button>
    </div>`;

  if (canCheckIn) {
    card.querySelector(".checkin-btn").addEventListener("click", () => toggleCheckIn(habit));
  }

  return card;
}

function renderHabits() {
  const visible = activeFilter === "all" ? cachedHabits : cachedHabits.filter((h) => h.visibility === activeFilter);
  habitsContainer.replaceChildren(...visible.map(habitCard));
  habitsEmpty.classList.toggle("hidden", visible.length > 0);
}

function setFilter(filter) {
  activeFilter = filter;
  filterTabs.forEach((btn) => {
    const active = btn.dataset.filter === filter;
    btn.classList.toggle("text-white", active);
    btn.classList.toggle("bg-neonPurple/15", active);
  });
  renderHabits();
}

filterTabs.forEach((btn) => btn.addEventListener("click", () => setFilter(btn.dataset.filter)));
setFilter("all");

async function fetchVisibleHabits() {
  const habits = [];

  const publicSnap = await getDocs(query(collection(db, "habits"), where("visibility", "==", "public")));
  publicSnap.forEach((d) => habits.push({ id: d.id, ...d.data() }));

  if (auth.currentUser) {
    try {
      const privateSnap = await getDocs(query(collection(db, "habits"), where("visibility", "==", "private")));
      privateSnap.forEach((d) => habits.push({ id: d.id, ...d.data() }));
      accessNote.classList.add("hidden");
      privateTab.classList.remove("hidden");
    } catch (err) {
      console.error("[habits] private query failed:", err.code || err);
      accessNote.classList.remove("hidden");
      privateTab.classList.add("hidden");
      if (activeFilter === "private") setFilter("all");
    }
  }

  habits.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
  cachedHabits = habits;
  renderHabits();
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
  newHabitBtn.classList.add("hidden");
  if (activeFilter === "private") setFilter("all");
}

function renderSignedIn(user) {
  authControl.innerHTML = `
    <span class="text-xs text-textGray font-code">Signed in as <span class="text-white">${user.displayName || user.email}</span></span>
    <button id="auth-signout-btn" class="px-4 py-2 bg-cardBg/70 border border-borderNeon rounded-xl text-xs font-cyber font-bold tracking-wider text-white hover:border-neonPurple transition-all">
      SIGN OUT
    </button>`;
  document.getElementById("auth-signout-btn").addEventListener("click", () => signOut(auth));

  newHabitBtn.classList.toggle("hidden", !isOwner(user));
}

onAuthStateChanged(auth, (user) => {
  if (user) {
    renderSignedIn(user);
  } else {
    renderSignedOut();
  }
  fetchVisibleHabits();
});

function openModal() {
  habitModal.classList.remove("hidden");
}
function closeModal() {
  habitModal.classList.add("hidden");
  habitForm.reset();
  habitStatus.textContent = "";
}

newHabitBtn.addEventListener("click", openModal);
habitModalClose.addEventListener("click", closeModal);
habitModalBackdrop.addEventListener("click", closeModal);

document.querySelectorAll(".icon-chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    habitIconInput.value = chip.dataset.icon;
  });
});

habitForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const user = auth.currentUser;
  if (!isOwner(user)) return;

  const title = document.getElementById("habit-title").value.trim();
  const icon = habitIconInput.value.trim();
  const visibility = habitForm.querySelector('input[name="habit-visibility"]:checked').value;
  if (!title || !icon) return;

  habitStatus.textContent = "Saving...";
  try {
    await addDoc(collection(db, "habits"), {
      uid: user.uid,
      title,
      icon,
      completedDates: [],
      visibility,
      createdAt: serverTimestamp(),
    });

    habitStatus.textContent = "Saved.";
    await fetchVisibleHabits();
    closeModal();
  } catch (err) {
    console.error("[habits] save failed:", err);
    habitStatus.textContent = "Save failed — check console.";
  }
});

// Best-effort local milestone alert: written by the owner's own client at check-in time
// since there's no backend to compute this server-side. See notifications.js for the read side.
async function checkStreakNotification(habit) {
  const user = auth.currentUser;
  if (!isOwner(user)) return;
  const streak = computeStreak(habit.completedDates);
  if (streak <= 0 || streak % 30 !== 0) return;

  const key = `lfj:lastStreakNotif:${habit.id}`;
  const lastNotified = Number(localStorage.getItem(key) || 0);
  if (streak <= lastNotified) return;
  localStorage.setItem(key, String(streak));

  try {
    await addDoc(collection(db, "notifications"), {
      uid: user.uid,
      type: "habit_streak",
      title: "Streak milestone",
      message: `🔥 ${streak}-day ${habit.title} streak achieved!`,
      read: false,
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    console.error("[habits] streak notification failed:", err.code || err);
  }
}

async function toggleCheckIn(habit) {
  const user = auth.currentUser;
  if (!isOwner(user)) return;
  const todayKey = toDateKey(new Date());
  const habitRef = doc(db, "habits", habit.id);
  const checked = (habit.completedDates || []).includes(todayKey);

  try {
    await updateDoc(habitRef, {
      completedDates: checked ? arrayRemove(todayKey) : arrayUnion(todayKey),
    });
    habit.completedDates = checked
      ? (habit.completedDates || []).filter((d) => d !== todayKey)
      : [...(habit.completedDates || []), todayKey];
    renderHabits();
    if (!checked) checkStreakNotification(habit);
  } catch (err) {
    console.error("[habits] check-in failed:", err.code || err);
  }
}
