import { auth, db, isOwner, OWNER_EMAIL, canParticipate } from "./firebase-init.js";
import { getLang, setLang, init as initI18n, t } from "./js/i18n.js";
import { resolveDisplayName, computeDisplayName, invalidateIdentityCache } from "./js/identity.js";
import { excludeDeleted } from "./js/memory-filters.js";
import { fetchWeather } from "./js/weather-client.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import {
  collection,
  query,
  where,
  orderBy,
  limit,
  getDocs,
  getDoc,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  addDoc,
  serverTimestamp,
  Timestamp,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

const PALETTE = ["#a78bfa", "#6ea8fe", "#fbbf24", "#34d399", "#fb7185", "#f472b6"];
const SETTINGS_KEY = "lfj:settings";

const authControl = document.getElementById("auth-control");

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
  } catch {
    return {};
  }
}
function saveSettings(next) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
}

// Dark/Light audit fix: every light/dark override in styles.css keys off the `data-theme`
// attribute alone (plain CSS attribute selectors, no JS-rendered state depends on theme) — so
// toggling it applies instantly with no reload needed. This used to require a full
// `location.reload()` (see the old "Saved. Reloading to apply theme…" status message) purely to
// re-run each page's <head> theme-preload inline script, which is the only other place this
// attribute got set. Also keeps the theme-color meta tag (iPhone PWA status bar) in sync, since
// that tag has no attribute-selector equivalent to lean on.
function applyTheme(theme) {
  if (theme === "light") {
    document.documentElement.setAttribute("data-theme", "light");
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "light" ? "#f5f5f7" : "#09090e");
}
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

async function fetchMyCollection(name) {
  const user = auth.currentUser;
  if (!user) return [];
  try {
    const snap = await getDocs(query(collection(db, name), where("uid", "==", user.uid)));
    // Trashed Memories never count toward Overview's analytics/achievements — a no-op for
    // journals/expenses/habits, none of which carry deletedAt.
    return excludeDeleted(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  } catch (err) {
    console.error(`[me] ${name} query failed:`, err.code || err);
    return [];
  }
}

// ---- Tabs ----

const tabButtons = document.querySelectorAll(".me-tab");
const tabPanels = document.querySelectorAll(".me-panel");

function setActiveTab(tab) {
  tabButtons.forEach((btn) => {
    const active = btn.dataset.tab === tab;
    btn.classList.toggle("bg-neonPurple/15", active);
    btn.classList.toggle("text-white", active);
  });
  tabPanels.forEach((panel) => panel.classList.toggle("hidden", panel.id !== `tab-${tab}`));
}
tabButtons.forEach((btn) => btn.addEventListener("click", () => setActiveTab(btn.dataset.tab)));
setActiveTab("overview");

// ---- Header ----

async function renderHeader(user) {
  const avatarImg = document.getElementById("me-avatar");
  const avatarFallback = document.getElementById("me-avatar-fallback");
  if (user.photoURL) {
    avatarImg.src = user.photoURL;
    avatarImg.alt = user.displayName || user.email;
    avatarImg.classList.remove("hidden");
    avatarFallback.classList.add("hidden");
  } else {
    avatarImg.classList.add("hidden");
    avatarFallback.classList.remove("hidden");
  }
  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    const data = snap.data() || {};
    document.getElementById("me-name").textContent = computeDisplayName(data, user);
    // @username is the public handle — never falls back to showing the private email here.
    document.getElementById("me-username").textContent = data.username ? `@${data.username}` : "";
    document.getElementById("me-bio").textContent = data.bio || "";
    document.getElementById("me-location").innerHTML = data.location ? `<i class="fa-solid fa-location-dot mr-1"></i>${data.location}` : "";
    document.getElementById("me-joined").innerHTML = data.createdAt?.toDate
      ? `<i class="fa-solid fa-calendar mr-1"></i>Joined ${data.createdAt.toDate().toLocaleDateString(undefined, { month: "long", year: "numeric" })}`
      : "";
    // v3.3.2: friend-only "View My Profile" link — same ?u=username (preferred) / ?uid=
    // fallback shape used by profile.js's own resumeCta and career.js's
    // updatePublicTopbarProfileLink(), reusing the users/{uid} doc already fetched above
    // instead of a second query. Owner keeps other paths to their own profile; this stays
    // hidden for Owner Me (see the isOwner() check).
    const profileLink = document.getElementById("me-view-profile-link");
    if (!isOwner(user)) {
      profileLink.href = data.username ? `profile.html?u=${encodeURIComponent(data.username)}` : `profile.html?uid=${encodeURIComponent(user.uid)}`;
      profileLink.classList.remove("hidden");
    } else {
      profileLink.classList.add("hidden");
    }
  } catch (err) {
    console.error("[me] header directory fetch failed:", err.code || err);
    document.getElementById("me-name").textContent = user.displayName || "User";
  }
}

// ---- Profile tab ----

function renderProfile(user) {
  document.getElementById("profile-email").textContent = user.email || "—";
  document.getElementById("profile-created").textContent = user.metadata?.creationTime
    ? new Date(user.metadata.creationTime).toLocaleDateString(undefined, { dateStyle: "medium" })
    : "—";
  document.getElementById("profile-last-login").textContent = user.metadata?.lastSignInTime
    ? new Date(user.metadata.lastSignInTime).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : "—";
}

document.getElementById("signout-btn").addEventListener("click", async () => {
  await signOut(auth);
  location.href = "login.html";
});

const displaynameInput = document.getElementById("displayname-input");
const displaynameStatus = document.getElementById("displayname-status");
const saveDisplaynameBtn = document.getElementById("save-displayname-btn");

async function loadDisplayName(user) {
  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    displaynameInput.value = computeDisplayName(snap.data() || {}, user);
  } catch (err) {
    console.error("[me] display name load failed:", err);
  }
}

saveDisplaynameBtn.addEventListener("click", async () => {
  const user = auth.currentUser;
  if (!user) return;
  const next = displaynameInput.value.trim();
  if (!next) {
    displaynameStatus.textContent = t("me.invalid_display_name");
    return;
  }
  displaynameStatus.textContent = t("common.saving");
  saveDisplaynameBtn.disabled = true;
  try {
    await setDoc(doc(db, "users", user.uid), { uid: user.uid, displayName: next }, { merge: true });
    await setDoc(doc(db, "public_profiles", user.uid), { uid: user.uid, displayName: next }, { merge: true });
    invalidateIdentityCache(user.uid);
    displaynameStatus.textContent = t("common.saved");
    renderHeader(user);
  } catch (err) {
    console.error("[me] display name save failed:", err.code || err);
    displaynameStatus.textContent = t("common.couldnt_save");
  }
  saveDisplaynameBtn.disabled = false;
});

const usernameInput = document.getElementById("username-input");
const usernameStatus = document.getElementById("username-status");
const saveUsernameBtn = document.getElementById("save-username-btn");
// 3-24 chars: lowercase letters, numbers, underscore, dot — always stored lowercase (see
// CLAUDE.md's identity model, v3.1).
const USERNAME_RE = /^[a-z0-9_.]{3,24}$/;
let currentUsername = "";

async function loadUsername(user) {
  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    currentUsername = snap.data()?.username || "";
    usernameInput.value = currentUsername;
  } catch (err) {
    console.error("[me] username load failed:", err);
  }
}

async function describeUsernameFailure(username, err) {
  if (err.code !== "permission-denied") return t("common.couldnt_save");
  try {
    const snap = await getDoc(doc(db, "usernames", username));
    return snap.exists() ? t("me.username_unavailable") : t("common.couldnt_save");
  } catch {
    return t("common.couldnt_save");
  }
}

saveUsernameBtn.addEventListener("click", async () => {
  const user = auth.currentUser;
  if (!user) return;
  const next = usernameInput.value.trim().toLowerCase();
  usernameStatus.textContent = "";

  if (next === currentUsername) return;
  if (!USERNAME_RE.test(next)) {
    usernameStatus.textContent = t("me.invalid_username");
    return;
  }

  usernameStatus.textContent = t("common.saving");
  saveUsernameBtn.disabled = true;
  try {
    await setDoc(doc(db, "usernames", next), { uid: user.uid, createdAt: serverTimestamp() });
  } catch (err) {
    console.error("[me] username reservation failed:", err.code || err);
    usernameStatus.textContent = await describeUsernameFailure(next, err);
    saveUsernameBtn.disabled = false;
    return;
  }

  if (currentUsername) {
    try {
      await deleteDoc(doc(db, "usernames", currentUsername));
    } catch (err) {
      console.error("[me] old username release failed:", err);
    }
  }

  try {
    await setDoc(doc(db, "users", user.uid), { uid: user.uid, username: next }, { merge: true });
    await setDoc(doc(db, "public_profiles", user.uid), { uid: user.uid, username: next }, { merge: true });
    currentUsername = next;
    invalidateIdentityCache(user.uid);
    usernameStatus.textContent = t("me.username_saved");
    renderHeader(user);
  } catch (err) {
    console.error("[me] username profile update failed:", err);
    usernameStatus.textContent = t("common.couldnt_save");
  }
  saveUsernameBtn.disabled = false;
});

const bioInput = document.getElementById("bio-input");
const locationInput = document.getElementById("location-input");
const saveAboutBtn = document.getElementById("save-about-btn");
const aboutStatus = document.getElementById("about-status");

async function loadAbout(user) {
  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    const data = snap.data() || {};
    bioInput.value = data.bio || "";
    locationInput.value = data.location || "";
  } catch (err) {
    console.error("[me] about load failed:", err);
  }
}

saveAboutBtn.addEventListener("click", async () => {
  const user = auth.currentUser;
  if (!user) return;
  aboutStatus.textContent = t("common.saving");
  saveAboutBtn.disabled = true;
  try {
    await setDoc(doc(db, "users", user.uid), {
      uid: user.uid,
      bio: bioInput.value.trim(),
      location: locationInput.value.trim(),
    }, { merge: true });
    aboutStatus.textContent = t("common.saved");
    renderHeader(user);
  } catch (err) {
    console.error("[me] about save failed:", err);
    aboutStatus.textContent = t("common.couldnt_save");
  }
  saveAboutBtn.disabled = false;
});

// ---- Preferences tab ----

const themeButtons = document.querySelectorAll(".theme-choice-btn");
const visibilityButtons = document.querySelectorAll(".visibility-choice-btn");
const langButtons = document.querySelectorAll(".lang-choice-btn");
const defaultCityInput = document.getElementById("default-city");
const preferencesStatus = document.getElementById("preferences-status");

function setActiveChoice(buttons, value, attr) {
  buttons.forEach((btn) => {
    const active = btn.dataset[attr] === value;
    btn.classList.toggle("bg-neonPurple/20", active);
    btn.classList.toggle("text-white", active);
    btn.classList.toggle("text-textGray", !active);
  });
}

function renderPrivacyTab() {
  const s = loadSettings();
  const vis = s.defaultVisibility || "public";
  document.getElementById("privacy-default-visibility").textContent = cap(vis);
}

async function renderPreferences() {
  const s = loadSettings();
  setActiveChoice(themeButtons, s.theme || "dark", "themeChoice");
  setActiveChoice(visibilityButtons, s.defaultVisibility || "public", "visibilityChoice");
  defaultCityInput.value = s.defaultCity || "";
  renderPrivacyTab();

  await initI18n();
  setActiveChoice(langButtons, getLang(), "langChoice");
}

document.addEventListener("eden:langchange", () => {
  setActiveChoice(langButtons, getLang(), "langChoice");
});

themeButtons.forEach((btn) => btn.addEventListener("click", () => setActiveChoice(themeButtons, btn.dataset.themeChoice, "themeChoice")));
visibilityButtons.forEach((btn) => btn.addEventListener("click", () => setActiveChoice(visibilityButtons, btn.dataset.visibilityChoice, "visibilityChoice")));
langButtons.forEach((btn) => btn.addEventListener("click", async () => {
  setActiveChoice(langButtons, btn.dataset.langChoice, "langChoice");
  await setLang(btn.dataset.langChoice);
}));

document.getElementById("save-preferences-btn").addEventListener("click", () => {
  const theme = document.querySelector(".theme-choice-btn.text-white")?.dataset.themeChoice || "dark";
  const defaultVisibility = document.querySelector(".visibility-choice-btn.text-white")?.dataset.visibilityChoice || "public";
  saveSettings({ theme, defaultVisibility, defaultCity: defaultCityInput.value.trim() });
  applyTheme(theme);
  preferencesStatus.textContent = t("common.saved");
  renderPrivacyTab();
});

renderPreferences();

// ---- Connections tab (whitelist, owner only) ----

async function loadWhitelistManagement() {
  const list = document.getElementById("whitelist-list");
  const empty = document.getElementById("whitelist-empty");

  let logsSnap, friendsSnap;
  try {
    [logsSnap, friendsSnap] = await Promise.all([
      getDocs(collection(db, "login_logs")),
      getDocs(collection(db, "friends")),
    ]);
  } catch (err) {
    console.error("[me] whitelist read failed:", err);
    empty.textContent = "Couldn't load user access data — check that firestore.rules has been pasted into the Firebase Console.";
    empty.classList.remove("hidden");
    return;
  }

  const users = new Map();
  logsSnap.forEach((d) => {
    const data = d.data();
    const email = (data.email || "").toLowerCase();
    if (!email) return;
    const existing = users.get(email);
    const loginMillis = data.loginTime?.toMillis?.() || 0;
    if (!existing || loginMillis > existing.loginMillis) {
      users.set(email, { email: data.email, lastLogin: data.loginTime, loginMillis });
    }
  });

  const friendEmails = new Set();
  friendsSnap.forEach((d) => friendEmails.add(d.id.toLowerCase()));

  const rows = [...users.values()].sort((a, b) => b.loginMillis - a.loginMillis);
  empty.classList.toggle("hidden", rows.length > 0);

  function formatTimestamp(ts) {
    if (!ts?.toDate) return "—";
    return ts.toDate().toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  }

  list.replaceChildren(
    ...rows.map((row) => {
      const emailLower = row.email.toLowerCase();
      const isTheOwner = emailLower === OWNER_EMAIL.toLowerCase();
      const isFriend = isTheOwner || friendEmails.has(emailLower);

      const el = document.createElement("div");
      el.className = "flex items-center justify-between gap-4 border-b border-borderNeon/40 py-2.5 last:border-0";
      el.innerHTML = `
        <div>
          <p class="font-medium">${row.email}${isTheOwner ? ' <span class="text-[10px] text-neonPurple font-code">(owner)</span>' : ""}</p>
          <p class="text-xs text-textGray font-code mt-0.5">Last login ${formatTimestamp(row.lastLogin)}</p>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <span class="px-2 py-0.5 rounded-full border text-[10px] font-code ${isFriend ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-400" : "border-borderNeon bg-darkBg/60 text-textGray"}">
            ${isFriend ? "Friend" : "Viewer"}
          </span>
          ${isTheOwner ? "" : `<button data-email="${emailLower}" data-action="${isFriend ? "demote" : "promote"}" class="whitelist-toggle-btn px-3 py-1.5 rounded-lg text-xs font-cyber font-bold tracking-wider ${isFriend ? "bg-rose-400/10 text-rose-400 hover:bg-rose-400/20" : "bg-neonPurple/10 text-neonPurple hover:bg-neonPurple/20"} transition-colors">${isFriend ? "Demote" : "Promote"}</button>`}
        </div>`;
      return el;
    })
  );

  list.querySelectorAll(".whitelist-toggle-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const email = btn.dataset.email;
      btn.disabled = true;
      try {
        if (btn.dataset.action === "promote") {
          await setDoc(doc(db, "friends", email), {
            addedAt: serverTimestamp(),
            addedBy: auth.currentUser.email,
          });
        } else {
          await deleteDoc(doc(db, "friends", email));
        }
        await loadWhitelistManagement();
      } catch (err) {
        console.error("[me] whitelist toggle failed:", err);
        btn.disabled = false;
      }
    });
  });
}

// ---- System Logs tab (owner only) ----

function shortDevice(ua) {
  if (!ua) return "Unknown device";
  if (/iPhone|iPad/.test(ua)) return "iOS · " + (/Safari/.test(ua) ? "Safari" : "Browser");
  if (/Android/.test(ua)) return "Android · " + (/Chrome/.test(ua) ? "Chrome" : "Browser");
  if (/Windows/.test(ua)) return "Windows · " + (/Edg\//.test(ua) ? "Edge" : /Chrome/.test(ua) ? "Chrome" : /Firefox/.test(ua) ? "Firefox" : "Browser");
  if (/Macintosh/.test(ua)) return "macOS · " + (/Chrome/.test(ua) ? "Chrome" : /Safari/.test(ua) ? "Safari" : "Browser");
  if (/Linux/.test(ua)) return "Linux · Browser";
  return ua.slice(0, 40);
}

async function loadSystemLogs() {
  const list = document.getElementById("login-logs-list");
  const empty = document.getElementById("login-logs-empty");

  let snap;
  try {
    snap = await getDocs(query(collection(db, "login_logs"), orderBy("loginTime", "desc"), limit(20)));
  } catch (err) {
    console.error("[me] login_logs read failed:", err);
    empty.textContent = "Couldn't load login history — check that firestore.rules has been pasted into the Firebase Console.";
    empty.classList.remove("hidden");
    return;
  }
  const rows = [];
  snap.forEach((d) => rows.push(d.data()));

  empty.classList.toggle("hidden", rows.length > 0);
  list.replaceChildren(
    ...rows.map((row) => {
      const el = document.createElement("div");
      el.className = "flex items-center justify-between border-b border-borderNeon/40 py-2.5 last:border-0";
      el.innerHTML = `
        <div>
          <p class="font-medium">${row.email}</p>
          <p class="text-xs text-textGray font-code mt-0.5">${shortDevice(row.device)}</p>
        </div>
        <span class="text-xs text-textGray font-code">${row.loginTime?.toDate ? row.loginTime.toDate().toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—"}</span>`;
      return el;
    })
  );
}

// ---- Overview: Gallery / Expense / Journal analytics + System status ----

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

// Finance is Owner-only (v3.3) — Friends no longer get this section on their own Overview tab.
async function renderExpenseAnalytics(user) {
  const section = document.getElementById("expense-analytics-section");
  section.classList.toggle("hidden", !isOwner(user));
  if (!isOwner(user)) return;
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

async function renderSystemStatus(user) {
  document.getElementById("sys-session").textContent = user ? await resolveDisplayName(user) : "Signed out";
}

// Production Hardening Phase 1 (task C): this used to call OpenWeatherMap directly with an API
// key hardcoded in this file's own source — see netlify/functions/weather.js, which now proxies
// the call server-side (the browser only ever sends its own Firebase ID token). This page never
// used geolocation for its weather line (just the same fixed city query the Function still
// falls back to), so no coords are passed here — behavior is unchanged, just the transport.
// Requires a signed-in user (the Function verifies a Firebase ID token), so this is now called
// from onAuthStateChanged below rather than unconditionally at module load.
async function loadWeather() {
  const el = document.getElementById("sys-weather");
  const result = await fetchWeather();
  if (!result.ok) {
    console.error("[me] weather failed:", result.error);
    el.textContent = "Unavailable";
    return;
  }
  el.textContent = `${result.tempC}°C, ${result.condition || ""}`;
}

// ---- Goals ----

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
          ${deadline ? `<span>${deadline}</span>` : ""}
        </div>
        <div class="flex items-center gap-2 mt-3">
          <input type="number" step="any" class="goal-progress-input w-24 bg-darkBg/60 border border-borderNeon rounded-lg px-2 py-1 text-xs text-white">
          <button class="goal-progress-btn px-3 py-1 bg-neonPurple/15 text-neonPurple rounded-lg text-[11px] font-code hover:bg-neonPurple/25 transition-colors">${t("me.update_progress")}</button>
        </div>`;

      el.querySelector(".goal-delete-btn").addEventListener("click", async () => {
        try {
          await deleteDoc(doc(db, "goals", g.id));
          cachedGoals = cachedGoals.filter((x) => x.id !== g.id);
          renderGoals();
        } catch (err) {
          console.error("[me] goal delete failed:", err.code || err);
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
          console.error("[me] goal progress update failed:", err.code || err);
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
  statusEl.textContent = t("common.saving");
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
    statusEl.textContent = t("common.saved");
    event.target.reset();
    setTimeout(() => goalModal.classList.add("hidden"), 500);
    loadGoals();
  } catch (err) {
    console.error("[me] goal create failed:", err.code || err);
    statusEl.textContent = t("common.couldnt_save");
  }
});

// ---- Time Capsule summary ----

// Time Capsule is Owner-only (v3.3), same as Finance.
async function loadCapsulesSummary(user) {
  const section = document.getElementById("capsules-summary-section");
  section.classList.toggle("hidden", !isOwner(user));
  if (!isOwner(user)) return;
  const capsules = await fetchMyCollection("time_capsules");
  const now = new Date();
  const sealed = capsules.filter((c) => c.status === "sealed" && !(c.openAt?.toDate && c.openAt.toDate() <= now));
  const ready = capsules.filter((c) => c.status === "sealed" && c.openAt?.toDate && c.openAt.toDate() <= now);
  document.getElementById("capsules-sealed-count").textContent = sealed.length;
  document.getElementById("capsules-ready-count").textContent = ready.length;
}

// ---- Friend Me cleanup (v3.3.2): Connections/Habits basic stats ----
// Memories/Journal counts already show for everyone via renderGalleryAnalytics()/
// renderJournalAnalytics() above — this only fills the two that were missing. Owner-hidden
// (same isOwner(user) gate as renderExpenseAnalytics()/loadCapsulesSummary()), so Owner Me is
// unchanged.
async function renderFriendStats(user) {
  const section = document.getElementById("friend-stats-section");
  section.classList.toggle("hidden", isOwner(user));
  if (isOwner(user)) return;
  try {
    const [friendsSnap, habits] = await Promise.all([
      getDocs(collection(db, "friendships", user.uid, "friends")),
      fetchMyCollection("habits"),
    ]);
    document.getElementById("friend-stat-connections").textContent = friendsSnap.size;
    document.getElementById("friend-stat-habits").textContent = habits.length;
  } catch (err) {
    console.error("[me] friend stats fetch failed:", err.code || err);
  }
}

// ---- Achievements ----

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
  { key: "photos", labelKey: "me.achievement_photos", icon: "fa-image", tiers: [10, 50, 100, 500] },
  { key: "journals", labelKey: "me.achievement_journals", icon: "fa-book", tiers: [10, 50, 100, 365] },
  { key: "expenses", labelKey: "me.achievement_expenses", icon: "fa-wallet", tiers: [10, 100, 250, 500] },
  { key: "streak", labelKey: "me.achievement_streak", icon: "fa-fire", tiers: [7, 30, 100, 365] },
];

function achievementTile(def, count) {
  const unlockedTier = [...def.tiers].reverse().find((tier) => count >= tier) || null;
  const nextTier = def.tiers.find((tier) => count < tier);
  const pct = nextTier ? Math.round((count / nextTier) * 100) : 100;
  const el = document.createElement("div");
  el.className = `rounded-xl p-4 border ${unlockedTier ? "border-neonPurple/40 bg-neonPurple/5" : "border-borderNeon bg-darkBg/40"}`;
  el.innerHTML = `
    <div class="w-9 h-9 rounded-lg ${unlockedTier ? "bg-neonPurple/15 text-neonPurple" : "bg-darkBg/60 text-textGray"} flex items-center justify-center mb-2"><i class="fa-solid ${def.icon}"></i></div>
    <p class="text-sm font-semibold text-white">${t(def.labelKey)}</p>
    <p class="text-[11px] font-code text-textGray mt-0.5">${unlockedTier ? `${unlockedTier}+ ${t("me.reached_suffix")}` : t("me.not_started")}</p>
    ${nextTier ? `
      <div class="h-1.5 rounded-full bg-borderNeon/60 overflow-hidden mt-2">
        <div class="h-full bg-neonPurple" style="width:${pct}%"></div>
      </div>
      <p class="text-[10px] font-code text-textGray mt-1">${count} / ${nextTier}</p>` : `<p class="text-[10px] font-code text-emerald-400 mt-2">${t("me.max_tier_reached")}</p>`}`;
  return el;
}

async function renderAchievements() {
  const user = auth.currentUser;
  // Expenses is always private and Owner-only (v3.3) — never surface this tile for a Friend,
  // same reasoning profile.js's PUBLIC_ACHIEVEMENTS already applies to other people's profiles.
  const defs = user && isOwner(user) ? ACHIEVEMENTS : ACHIEVEMENTS.filter((d) => d.key !== "expenses");
  const [photos, journals, expenses, habits] = await Promise.all([
    fetchMyCollection("photos"), fetchMyCollection("journals"), fetchMyCollection("expenses"), fetchMyCollection("habits"),
  ]);
  const bestStreak = habits.length ? Math.max(...habits.map((h) => computeStreak(h.completedDates))) : 0;
  const counts = { photos: photos.length, journals: journals.length, expenses: expenses.length, streak: bestStreak };
  document.getElementById("achievements-list").replaceChildren(...defs.map((def) => achievementTile(def, counts[def.key])));
}

// ---- Auth control ----

async function renderSignedIn(user) {
  const name = await resolveDisplayName(user);
  authControl.innerHTML = `
    <span class="text-xs text-textGray font-code hidden sm:inline">${t("common.signed_in_as")} <span class="text-white">${name}</span></span>`;
}

onAuthStateChanged(auth, (user) => {
  if (!user) return;
  renderSignedIn(user);
  renderHeader(user);
  renderProfile(user);
  loadDisplayName(user);
  loadUsername(user);
  loadAbout(user);
  renderSystemStatus(user);
  renderGalleryAnalytics();
  renderExpenseAnalytics(user);
  renderJournalAnalytics();
  loadGoals();
  loadCapsulesSummary(user);
  renderFriendStats(user);
  renderAchievements();
  loadWeather();

  if (isOwner(user)) {
    document.querySelector('.me-tab[data-tab="connections"]').classList.remove("hidden");
    document.querySelector('.me-tab[data-tab="logs"]').classList.remove("hidden");
    loadWhitelistManagement();
    loadSystemLogs();
  }
});

document.addEventListener("eden:langchange", () => {
  renderGoals();
  renderAchievements();
  const user = auth.currentUser;
  if (user) renderSignedIn(user);
});
