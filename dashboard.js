import { auth, googleProvider, db, getUserMode, canParticipate } from "./firebase-init.js";
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
  Timestamp,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

const WEATHER_API_KEY = "4708932833bff8ef44d180197bfc4664";
const PALETTE = ["#a78bfa", "#6ea8fe", "#fbbf24", "#34d399", "#fb7185", "#f472b6"];

const authControl = document.getElementById("auth-control");

function cap(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "—";
}

function mostCommon(values) {
  if (!values.length) return null;
  const counts = {};
  values.forEach((v) => { counts[v] = (counts[v] || 0) + 1; });
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

function chartOptions() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { grid: { display: false }, ticks: { color: "#9793ab", font: { size: 9 } } },
      y: { grid: { color: "rgba(255,255,255,0.06)" }, ticks: { color: "#9793ab", font: { size: 9 } } },
    },
  };
}

function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `W${weekNo}`;
}

// This dashboard is personal analytics — every section below reads only the signed-in
// user's own docs (uid == me), not everyone's public content too.
async function fetchMyCollection(name) {
  const user = auth.currentUser;
  if (!user) return [];
  try {
    const snap = await getDocs(query(collection(db, name), where("uid", "==", user.uid)));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.error(`[dashboard] ${name} query failed:`, err.code || err);
    return [];
  }
}

// ---- Search People ----
//
// Visibility of search results is role-gated (mirroring firestore.rules' isFriend()/isOwner()
// intent, but enforced here client-side against the `role` field every user's own login.html
// upsert writes to their `users/{uid}` doc — see CLAUDE.md): a Viewer may only find the Owner;
// a Friend or the Owner may find the Owner and any Friend. Plain Viewers are never listed
// (canParticipate() is false for them, so they'd have nothing to show anyway). Opening a
// result navigates to profile.html, a dedicated read-only IG-style profile page, rather than
// showing an inline summary — that page re-checks this same role gate before fetching anything.

let allUsers = [];
const peopleSearchInput = document.getElementById("people-search");
const peopleResults = document.getElementById("people-results");

async function loadUserDirectory() {
  try {
    const snap = await getDocs(collection(db, "users"));
    allUsers = snap.docs.map((d) => d.data());
  } catch (err) {
    console.error("[dashboard] users directory fetch failed:", err.code || err);
    allUsers = [];
  }
}

function searchableUsers() {
  const myRole = getUserMode(); // OWNER / FRIEND / VIEWER
  return allUsers.filter((p) => {
    if (p.uid === auth.currentUser?.uid) return false;
    if (myRole === "OWNER") return p.role === "owner" || p.role === "friend";
    if (myRole === "FRIEND") return p.role === "owner" || p.role === "friend";
    return p.role === "owner";
  });
}

function renderPeopleResults(list) {
  peopleResults.replaceChildren(
    ...list.map((person) => {
      const el = document.createElement("a");
      el.href = `profile.html?uid=${encodeURIComponent(person.uid)}`;
      el.className = "w-full flex items-center gap-3 p-2.5 rounded-xl hover:bg-darkBg/40 transition-colors text-left";
      el.innerHTML = `
        <div class="w-8 h-8 rounded-full bg-neonPurple/10 flex items-center justify-center text-neonPurple text-xs overflow-hidden flex-shrink-0">
          ${person.photoURL ? `<img src="${person.photoURL}" class="w-full h-full object-cover">` : `<i class="fa-solid fa-user"></i>`}
        </div>
        <div class="min-w-0">
          <p class="text-sm font-medium truncate">${person.displayName || person.email}</p>
          <p class="text-[11px] text-textGray font-code truncate">${person.username ? "@" + person.username : person.email}</p>
        </div>`;
      return el;
    })
  );
}

peopleSearchInput.addEventListener("input", (event) => {
  const q = event.target.value.trim().toLowerCase().replace(/^@/, "");
  if (!q) {
    peopleResults.replaceChildren();
    return;
  }
  const matches = searchableUsers()
    .filter((p) => (p.displayName || "").toLowerCase().includes(q) || (p.username || "").toLowerCase().includes(q) || (p.email || "").toLowerCase().includes(q))
    .slice(0, 8);
  renderPeopleResults(matches);
});

async function renderGalleryAnalytics() {
  const photos = await fetchMyCollection("photos");
  document.getElementById("gal-total").textContent = photos.length;
  document.getElementById("gal-public").textContent = photos.filter((p) => p.visibility === "public").length;
  document.getElementById("gal-private").textContent = photos.filter((p) => p.visibility === "private").length;
  document.getElementById("gal-top-category").textContent = cap(mostCommon(photos.map((p) => p.category).filter(Boolean)));

  const lastUpload = photos.reduce((max, p) => Math.max(max, p.uploadedAt?.toMillis?.() || 0), 0);
  document.getElementById("gal-last-upload").textContent = lastUpload
    ? new Date(lastUpload).toLocaleDateString(undefined, { dateStyle: "medium" })
    : "—";
}

let monthlyChart, categoryPieChart, weeklyChart;

async function renderExpenseAnalytics() {
  const expenses = await fetchMyCollection("expenses");
  const now = new Date();

  const monthTotal = expenses
    .filter((e) => { const d = e.createdAt?.toDate?.(); return d && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear(); })
    .reduce((sum, e) => sum + Number(e.amount), 0);
  const yearTotal = expenses
    .filter((e) => { const d = e.createdAt?.toDate?.(); return d && d.getFullYear() === now.getFullYear(); })
    .reduce((sum, e) => sum + Number(e.amount), 0);
  const avgDaily = monthTotal / now.getDate();

  const categoryTotals = {};
  expenses.forEach((e) => { categoryTotals[e.category] = (categoryTotals[e.category] || 0) + Number(e.amount); });
  const topCategory = Object.entries(categoryTotals).sort((a, b) => b[1] - a[1])[0]?.[0];

  document.getElementById("exp-month-total").textContent = `RM ${monthTotal.toFixed(2)}`;
  document.getElementById("exp-year-total").textContent = `RM ${yearTotal.toFixed(2)}`;
  document.getElementById("exp-avg-daily").textContent = `RM ${(avgDaily || 0).toFixed(2)}`;
  document.getElementById("exp-top-category").textContent = cap(topCategory);

  const monthlyTotals = new Map();
  expenses.forEach((e) => {
    const d = e.createdAt?.toDate?.();
    if (!d) return;
    const key = d.toLocaleDateString(undefined, { month: "short", year: "2-digit" });
    monthlyTotals.set(key, (monthlyTotals.get(key) || 0) + Number(e.amount));
  });
  const monthlyLabels = [...monthlyTotals.keys()].slice(-6);
  const monthlyValues = monthlyLabels.map((k) => monthlyTotals.get(k));

  monthlyChart?.destroy();
  monthlyChart = new Chart(document.getElementById("monthly-chart").getContext("2d"), {
    type: "line",
    data: { labels: monthlyLabels, datasets: [{ data: monthlyValues, borderColor: "#a78bfa", backgroundColor: "rgba(167,139,250,0.15)", fill: true, tension: 0.3, pointRadius: 2 }] },
    options: chartOptions(),
  });

  const catKeys = Object.keys(categoryTotals);
  categoryPieChart?.destroy();
  categoryPieChart = new Chart(document.getElementById("category-pie-chart").getContext("2d"), {
    type: "pie",
    data: { labels: catKeys.map(cap), datasets: [{ data: catKeys.map((k) => categoryTotals[k]), backgroundColor: PALETTE, borderColor: "#17151f", borderWidth: 2 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom", labels: { color: "#9793ab", font: { size: 9 }, boxWidth: 8 } } } },
  });

  const weeklyTotals = new Map();
  expenses.forEach((e) => {
    const d = e.createdAt?.toDate?.();
    if (!d) return;
    const key = isoWeekKey(d);
    weeklyTotals.set(key, (weeklyTotals.get(key) || 0) + Number(e.amount));
  });
  const weeklyKeys = [...weeklyTotals.keys()].sort().slice(-8);
  weeklyChart?.destroy();
  weeklyChart = new Chart(document.getElementById("weekly-chart").getContext("2d"), {
    type: "bar",
    data: { labels: weeklyKeys, datasets: [{ data: weeklyKeys.map((k) => weeklyTotals.get(k)), backgroundColor: "rgba(110,168,254,0.55)", borderRadius: 4, maxBarThickness: 24 }] },
    options: chartOptions(),
  });
}

async function renderJournalAnalytics() {
  const entries = await fetchMyCollection("journals");
  document.getElementById("jnl-total").textContent = entries.length;
  const pub = entries.filter((e) => e.visibility === "public").length;
  document.getElementById("jnl-visibility").textContent = `${pub} / ${entries.length - pub}`;
  document.getElementById("jnl-top-mood").textContent = cap(mostCommon(entries.map((e) => e.mood).filter(Boolean)));

  const tagCounts = {};
  entries.forEach((e) => (e.tags || []).forEach((t) => { tagCounts[t] = (tagCounts[t] || 0) + 1; }));
  const topTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => `#${t}`).join(" ");
  document.getElementById("jnl-top-tags").textContent = topTags || "—";
}

function renderSystemStatus(user) {
  document.getElementById("sys-session").textContent = user ? `Signed in as ${user.displayName || user.email}` : "Signed out";
  document.getElementById("sys-created").textContent = user?.metadata?.creationTime
    ? new Date(user.metadata.creationTime).toLocaleDateString(undefined, { dateStyle: "medium" })
    : "—";
  document.getElementById("sys-last-login").textContent = user?.metadata?.lastSignInTime
    ? new Date(user.metadata.lastSignInTime).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : "—";
}

async function loadWeather() {
  const el = document.getElementById("sys-weather");
  try {
    const res = await fetch(`https://api.openweathermap.org/data/2.5/weather?q=Kuching,MY&units=metric&appid=${WEATHER_API_KEY}`);
    if (!res.ok) throw new Error(`Weather API ${res.status}`);
    const data = await res.json();
    el.textContent = `${Math.round(data.main.temp)}°C, ${data.weather?.[0]?.main || ""}`;
  } catch (err) {
    console.error("[dashboard] weather failed:", err);
    el.textContent = "Unavailable";
  }
}

// ---- Goals ----
//
// Always the signed-in user's own goals, same shape as Expenses (no `visibility` — personal
// targets have no public story). Write-gated by canParticipate() like every other "New X".

let cachedGoals = [];

async function loadGoals() {
  const section = document.getElementById("goals-section");
  section.classList.toggle("hidden", !canParticipate());
  if (!canParticipate()) return;
  cachedGoals = await fetchMyCollection("goals");
  renderGoals();
}

function renderGoals() {
  const listEl = document.getElementById("goals-list");
  const emptyEl = document.getElementById("goals-empty");
  emptyEl.classList.toggle("hidden", cachedGoals.length > 0);
  listEl.replaceChildren(
    ...cachedGoals.map((g) => {
      const pct = g.target > 0 ? Math.min(100, Math.round(((g.current || 0) / g.target) * 100)) : 0;
      const deadline = g.deadline?.toDate ? g.deadline.toDate().toLocaleDateString(undefined, { dateStyle: "medium" }) : null;
      const el = document.createElement("div");
      el.className = "bg-darkBg/40 border border-borderNeon rounded-xl p-4";
      el.innerHTML = `
        <div class="flex items-center justify-between gap-3 mb-2">
          <p class="text-sm font-semibold text-white truncate">${g.title}</p>
          <button class="goal-delete-btn text-textGray hover:text-rose-400 text-xs flex-shrink-0"><i class="fa-solid fa-trash"></i></button>
        </div>
        <div class="h-2 rounded-full bg-borderNeon/60 overflow-hidden">
          <div class="h-full bg-gradient-to-r from-neonViolet to-neonPurple" style="width:${pct}%"></div>
        </div>
        <div class="flex items-center justify-between mt-2 text-[11px] font-code text-textGray">
          <span>${g.current || 0} / ${g.target} ${g.unit || ""} &middot; ${pct}%</span>
          ${deadline ? `<span>Due ${deadline}</span>` : ""}
        </div>
        <div class="flex items-center gap-2 mt-3">
          <input type="number" step="any" class="goal-progress-input w-24 bg-darkBg/60 border border-borderNeon rounded-lg px-2 py-1 text-xs text-white" placeholder="Update">
          <button class="goal-progress-btn px-3 py-1 bg-neonPurple/15 text-neonPurple rounded-lg text-[11px] font-code hover:bg-neonPurple/25 transition-colors">Update progress</button>
        </div>`;

      el.querySelector(".goal-delete-btn").addEventListener("click", async () => {
        try {
          await deleteDoc(doc(db, "goals", g.id));
          cachedGoals = cachedGoals.filter((x) => x.id !== g.id);
          renderGoals();
        } catch (err) {
          console.error("[dashboard] goal delete failed:", err.code || err);
        }
      });
      el.querySelector(".goal-progress-btn").addEventListener("click", async () => {
        const input = el.querySelector(".goal-progress-input");
        const next = parseFloat(input.value);
        if (Number.isNaN(next)) return;
        try {
          await updateDoc(doc(db, "goals", g.id), { current: next });
          g.current = next;
          renderGoals();
        } catch (err) {
          console.error("[dashboard] goal progress update failed:", err.code || err);
        }
      });
      return el;
    })
  );
}

const goalModal = document.getElementById("goal-modal");
document.getElementById("new-goal-btn").addEventListener("click", () => goalModal.classList.remove("hidden"));
document.getElementById("goal-modal-close").addEventListener("click", () => goalModal.classList.add("hidden"));
document.getElementById("goal-modal-backdrop").addEventListener("click", () => goalModal.classList.add("hidden"));

document.getElementById("goal-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const user = auth.currentUser;
  if (!user || !canParticipate()) return;
  const statusEl = document.getElementById("goal-status");
  const deadlineVal = document.getElementById("goal-deadline").value;
  statusEl.textContent = "Saving…";
  try {
    await addDoc(collection(db, "goals"), {
      title: document.getElementById("goal-title").value.trim(),
      target: parseFloat(document.getElementById("goal-target").value) || 0,
      current: 0,
      unit: document.getElementById("goal-unit").value.trim(),
      deadline: deadlineVal ? Timestamp.fromDate(new Date(deadlineVal)) : null,
      createdAt: serverTimestamp(),
      uid: user.uid,
    });
    statusEl.textContent = "Saved.";
    event.target.reset();
    setTimeout(() => goalModal.classList.add("hidden"), 500);
    loadGoals();
  } catch (err) {
    console.error("[dashboard] goal create failed:", err.code || err);
    statusEl.textContent = "Couldn't save — check console.";
  }
});

// ---- Achievements ----
//
// 100% data-driven from live counts/streaks (no hardcoded personal-history milestones — see
// CLAUDE.md). Tiered so progress feels achievable rather than a single all-or-nothing target.

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

const ACHIEVEMENTS = [
  { key: "photos", label: "Photos Uploaded", icon: "fa-image", tiers: [10, 50, 100, 500] },
  { key: "journals", label: "Journal Entries", icon: "fa-book", tiers: [10, 50, 100, 365] },
  { key: "expenses", label: "Expenses Recorded", icon: "fa-wallet", tiers: [10, 100, 250, 500] },
  { key: "streak", label: "Longest Active Streak", icon: "fa-fire", tiers: [7, 30, 100, 365] },
];

function achievementTile(def, count) {
  const unlockedTier = [...def.tiers].reverse().find((t) => count >= t) || null;
  const nextTier = def.tiers.find((t) => count < t);
  const pct = nextTier ? Math.round((count / nextTier) * 100) : 100;
  const el = document.createElement("div");
  el.className = `rounded-xl p-4 border ${unlockedTier ? "border-neonPurple/40 bg-neonPurple/5" : "border-borderNeon bg-darkBg/40"}`;
  el.innerHTML = `
    <div class="w-9 h-9 rounded-lg ${unlockedTier ? "bg-neonPurple/15 text-neonPurple" : "bg-darkBg/60 text-textGray"} flex items-center justify-center mb-2"><i class="fa-solid ${def.icon}"></i></div>
    <p class="text-sm font-semibold text-white">${def.label}</p>
    <p class="text-[11px] font-code text-textGray mt-0.5">${unlockedTier ? `${unlockedTier}+ reached` : "Not started"}</p>
    ${nextTier ? `
      <div class="h-1.5 rounded-full bg-borderNeon/60 overflow-hidden mt-2">
        <div class="h-full bg-neonPurple" style="width:${pct}%"></div>
      </div>
      <p class="text-[10px] font-code text-textGray mt-1">${count} / ${nextTier}</p>` : `<p class="text-[10px] font-code text-emerald-400 mt-2">Max tier reached</p>`}`;
  return el;
}

async function renderAchievements() {
  const [photos, journals, expenses, habits] = await Promise.all([
    fetchMyCollection("photos"), fetchMyCollection("journals"), fetchMyCollection("expenses"), fetchMyCollection("habits"),
  ]);
  const bestStreak = habits.length ? Math.max(...habits.map((h) => computeStreak(h.completedDates))) : 0;
  const counts = { photos: photos.length, journals: journals.length, expenses: expenses.length, streak: bestStreak };
  document.getElementById("achievements-list").replaceChildren(...ACHIEVEMENTS.map((def) => achievementTile(def, counts[def.key])));
}

function renderSignedOut() {
  authControl.innerHTML = `
    <button id="auth-signin-btn" class="px-4 py-2 bg-gradient-to-r from-neonViolet to-neonPurple rounded-xl text-xs font-cyber font-bold tracking-wider text-white hover:scale-105 transition-all">
      <i class="fa-brands fa-google mr-2"></i> SIGN IN
    </button>`;
  document.getElementById("auth-signin-btn").addEventListener("click", () => {
    signInWithPopup(auth, googleProvider).catch((err) => console.error("Sign-in failed", err));
  });
}

function renderSignedIn(user) {
  authControl.innerHTML = `
    <span class="text-xs text-textGray font-code">Signed in as <span class="text-white">${user.displayName || user.email}</span></span>
    <button id="auth-signout-btn" class="px-4 py-2 bg-cardBg/70 border border-borderNeon rounded-xl text-xs font-cyber font-bold tracking-wider text-white hover:border-neonPurple transition-all">
      SIGN OUT
    </button>`;
  document.getElementById("auth-signout-btn").addEventListener("click", () => signOut(auth));
}

onAuthStateChanged(auth, (user) => {
  if (user) {
    renderSignedIn(user);
  } else {
    renderSignedOut();
  }
  renderSystemStatus(user);
  renderGalleryAnalytics();
  renderExpenseAnalytics();
  renderJournalAnalytics();
  loadUserDirectory();
  if (user) {
    loadGoals();
    renderAchievements();
  }
});

loadWeather();
