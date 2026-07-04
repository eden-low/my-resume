import { auth, googleProvider, db } from "./firebase-init.js";
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

let allUsers = [];
const peopleSearchInput = document.getElementById("people-search");
const peopleResults = document.getElementById("people-results");
const peoplePublicView = document.getElementById("people-public-view");

async function loadUserDirectory() {
  try {
    const snap = await getDocs(collection(db, "users"));
    allUsers = snap.docs.map((d) => d.data());
  } catch (err) {
    console.error("[dashboard] users directory fetch failed:", err.code || err);
    allUsers = [];
  }
}

function renderPeopleResults(list) {
  peopleResults.replaceChildren(
    ...list.map((person) => {
      const el = document.createElement("button");
      el.className = "w-full flex items-center gap-3 p-2.5 rounded-xl hover:bg-darkBg/40 transition-colors text-left";
      el.innerHTML = `
        <div class="w-8 h-8 rounded-full bg-neonPurple/10 flex items-center justify-center text-neonPurple text-xs overflow-hidden flex-shrink-0">
          ${person.photoURL ? `<img src="${person.photoURL}" class="w-full h-full object-cover">` : `<i class="fa-solid fa-user"></i>`}
        </div>
        <div class="min-w-0">
          <p class="text-sm font-medium truncate">${person.displayName || person.email}</p>
          <p class="text-[11px] text-textGray font-code truncate">${person.email}</p>
        </div>`;
      el.addEventListener("click", () => showPersonPublicContent(person));
      return el;
    })
  );
}

peopleSearchInput.addEventListener("input", (event) => {
  const q = event.target.value.trim().toLowerCase();
  peoplePublicView.classList.add("hidden");
  if (!q) {
    peopleResults.replaceChildren();
    return;
  }
  const matches = allUsers
    .filter((p) => (p.displayName || "").toLowerCase().includes(q) || (p.email || "").toLowerCase().includes(q))
    .slice(0, 8);
  renderPeopleResults(matches);
});

async function fetchPublicFor(collectionName, uid) {
  try {
    const snap = await getDocs(query(collection(db, collectionName), where("uid", "==", uid), where("visibility", "==", "public")));
    return snap.docs.map((d) => d.data());
  } catch (err) {
    console.error(`[dashboard] public ${collectionName} for ${uid} failed:`, err.code || err);
    return [];
  }
}

async function showPersonPublicContent(person) {
  peoplePublicView.classList.remove("hidden");
  peoplePublicView.innerHTML = `<p class="text-xs font-code text-textGray">Loading&hellip;</p>`;

  const [photos, journals, events, habits] = await Promise.all([
    fetchPublicFor("photos", person.uid),
    fetchPublicFor("journals", person.uid),
    fetchPublicFor("life_events", person.uid),
    fetchPublicFor("habits", person.uid),
  ]);

  const items = [
    ...photos.map((p) => ({ icon: "fa-image", text: p.caption || "Photo", millis: p.uploadedAt?.toMillis?.() || 0 })),
    ...journals.map((j) => ({ icon: "fa-book", text: j.title, millis: j.createdAt?.toMillis?.() || 0 })),
    ...events.map((e) => ({ icon: "fa-timeline", text: e.title, millis: e.date?.toMillis?.() || 0 })),
  ].sort((a, b) => b.millis - a.millis).slice(0, 5);

  peoplePublicView.innerHTML = `
    <p class="text-sm font-semibold mb-3">${person.displayName || person.email}'s public activity</p>
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 text-sm mb-4">
      <div><p class="text-textGray text-xs">Public photos</p><p class="font-code font-semibold text-xl mt-1">${photos.length}</p></div>
      <div><p class="text-textGray text-xs">Public journal entries</p><p class="font-code font-semibold text-xl mt-1">${journals.length}</p></div>
      <div><p class="text-textGray text-xs">Public timeline events</p><p class="font-code font-semibold text-xl mt-1">${events.length}</p></div>
      <div><p class="text-textGray text-xs">Public habits</p><p class="font-code font-semibold text-xl mt-1">${habits.length}</p></div>
    </div>
    ${items.length ? `
      <div class="space-y-1.5">
        ${items.map((i) => `<p class="text-xs text-textGray"><i class="fa-solid ${i.icon} mr-2 text-neonPurple"></i>${i.text}</p>`).join("")}
      </div>` : `<p class="text-xs font-code text-textGray">No public activity yet.</p>`}`;
}

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
});

loadWeather();
