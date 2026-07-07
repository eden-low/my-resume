import { auth, db, isOwner, OWNER_EMAIL } from "./firebase-init.js";
import { getLang, setLang, init as initI18n } from "./js/i18n.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import {
  collection,
  query,
  orderBy,
  limit,
  getDocs,
  getDoc,
  doc,
  setDoc,
  deleteDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

const SETTINGS_KEY = "lfj:settings";

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

function formatTimestamp(ts) {
  if (!ts?.toDate) return "—";
  return ts.toDate().toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function shortDevice(ua) {
  if (!ua) return "Unknown device";
  if (/iPhone|iPad/.test(ua)) return "iOS · " + (/Safari/.test(ua) ? "Safari" : "Browser");
  if (/Android/.test(ua)) return "Android · " + (/Chrome/.test(ua) ? "Chrome" : "Browser");
  if (/Windows/.test(ua)) return "Windows · " + (/Edg\//.test(ua) ? "Edge" : /Chrome/.test(ua) ? "Chrome" : /Firefox/.test(ua) ? "Firefox" : "Browser");
  if (/Macintosh/.test(ua)) return "macOS · " + (/Chrome/.test(ua) ? "Chrome" : /Safari/.test(ua) ? "Safari" : "Browser");
  if (/Linux/.test(ua)) return "Linux · Browser";
  return ua.slice(0, 40);
}

// ---- Profile ----

function renderProfile(user) {
  const avatarImg = document.getElementById("profile-avatar");
  const avatarFallback = document.getElementById("profile-avatar-fallback");
  if (user.photoURL) {
    avatarImg.src = user.photoURL;
    avatarImg.alt = user.displayName || user.email;
    avatarImg.classList.remove("hidden");
    avatarFallback.classList.add("hidden");
  } else {
    avatarImg.classList.add("hidden");
    avatarFallback.classList.remove("hidden");
  }
  document.getElementById("profile-name").textContent = user.displayName || "—";
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

// ---- Username (@handle for Search People) ----

const usernameInput = document.getElementById("username-input");
const usernameStatus = document.getElementById("username-status");
const saveUsernameBtn = document.getElementById("save-username-btn");
const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
let currentUsername = "";

async function loadUsername(user) {
  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    currentUsername = snap.data()?.username || "";
    usernameInput.value = currentUsername;
  } catch (err) {
    console.error("[settings] username load failed:", err);
  }
}

// A denied `create` on usernames/{next} means either it's genuinely taken, or
// firestore.rules hasn't been deployed yet (the collection has no matching rule at all,
// so Firestore denies everything on it — same error code as a real conflict). Telling these
// apart: a read is allowed for any signed-in user under the *intended* rules, so if reading
// the doc also comes back permission-denied, the rules themselves aren't live yet.
async function describeUsernameFailure(username, err) {
  if (err.code !== "permission-denied") return "Couldn't save — check console.";
  try {
    const snap = await getDoc(doc(db, "usernames", username));
    return snap.exists() ? "That username is already taken." : "Couldn't save — check console.";
  } catch {
    return "Couldn't save — check that firestore.rules has been deployed to the Firebase Console.";
  }
}

saveUsernameBtn.addEventListener("click", async () => {
  const user = auth.currentUser;
  if (!user) return;
  const next = usernameInput.value.trim().toLowerCase();
  usernameStatus.textContent = "";

  if (next === currentUsername) return;
  if (!USERNAME_RE.test(next)) {
    usernameStatus.textContent = "3-20 characters: lowercase letters, numbers, underscore only.";
    return;
  }

  usernameStatus.textContent = "Saving…";
  saveUsernameBtn.disabled = true;
  try {
    // Doc ID = the handle itself, so this create fails with permission-denied if it's
    // already reserved by someone else (see firestore.rules — no update allowed on this doc).
    await setDoc(doc(db, "usernames", next), { uid: user.uid, createdAt: serverTimestamp() });
  } catch (err) {
    console.error("[settings] username reservation failed:", err.code || err);
    usernameStatus.textContent = await describeUsernameFailure(next, err);
    saveUsernameBtn.disabled = false;
    return;
  }

  if (currentUsername) {
    try {
      await deleteDoc(doc(db, "usernames", currentUsername));
    } catch (err) {
      console.error("[settings] old username release failed:", err);
    }
  }

  try {
    // firestore.rules requires every write to users/{uid} to include a matching `uid` field
    // (a deliberate guard, not just an update — see login.html's upsert for the same pattern),
    // so this can't be a bare `{ username: next }` merge.
    await setDoc(doc(db, "users", user.uid), { uid: user.uid, username: next }, { merge: true });
    currentUsername = next;
    usernameStatus.textContent = "Saved.";
  } catch (err) {
    console.error("[settings] username profile update failed:", err);
    usernameStatus.textContent = "Handle reserved, but profile update failed — check console.";
  }
  saveUsernameBtn.disabled = false;
});

// ---- About (bio + location, shown on the public profile) ----

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
    console.error("[settings] about load failed:", err);
  }
}

saveAboutBtn.addEventListener("click", async () => {
  const user = auth.currentUser;
  if (!user) return;
  aboutStatus.textContent = "Saving…";
  saveAboutBtn.disabled = true;
  try {
    await setDoc(doc(db, "users", user.uid), {
      uid: user.uid,
      bio: bioInput.value.trim(),
      location: locationInput.value.trim(),
    }, { merge: true });
    aboutStatus.textContent = "Saved.";
  } catch (err) {
    console.error("[settings] about save failed:", err);
    aboutStatus.textContent = "Couldn't save — check console.";
  }
  saveAboutBtn.disabled = false;
});

// ---- Preferences ----

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

// Language buttons need the *resolved* language, not whatever `currentLang` happens to be at
// this module's own top-level eval time — i18n.js's init() (localStorage → Firestore → browser
// language) runs on DOMContentLoaded and may not have finished yet when this file first
// evaluates, since ES modules on a page don't wait on one another. Awaiting the same init()
// promise here (safe to call repeatedly — see js/i18n.js) guarantees the toggle always reflects
// the language that's actually been applied to the page.
async function renderPreferences() {
  const s = loadSettings();
  setActiveChoice(themeButtons, s.theme || "dark", "themeChoice");
  setActiveChoice(visibilityButtons, s.defaultVisibility || "public", "visibilityChoice");
  defaultCityInput.value = s.defaultCity || "";

  await initI18n();
  setActiveChoice(langButtons, getLang(), "langChoice");
}

// Repaint if the language changed via another control (e.g. the mobile drawer's own switcher,
// present in the DOM on every page including this one) — both call the exact same setLanguage().
document.addEventListener("eden:langchange", () => {
  setActiveChoice(langButtons, getLang(), "langChoice");
});

themeButtons.forEach((btn) => btn.addEventListener("click", () => setActiveChoice(themeButtons, btn.dataset.themeChoice, "themeChoice")));
visibilityButtons.forEach((btn) => btn.addEventListener("click", () => setActiveChoice(visibilityButtons, btn.dataset.visibilityChoice, "visibilityChoice")));
// Language applies immediately (no reload needed — see js/i18n.js), unlike the other
// preferences here which only take effect after Save + reload.
langButtons.forEach((btn) => btn.addEventListener("click", async () => {
  setActiveChoice(langButtons, btn.dataset.langChoice, "langChoice");
  await setLang(btn.dataset.langChoice);
}));

document.getElementById("save-preferences-btn").addEventListener("click", () => {
  const theme = document.querySelector(".theme-choice-btn.text-white")?.dataset.themeChoice || "dark";
  const defaultVisibility = document.querySelector(".visibility-choice-btn.text-white")?.dataset.visibilityChoice || "public";
  saveSettings({ theme, defaultVisibility, defaultCity: defaultCityInput.value.trim() });
  preferencesStatus.textContent = "Saved. Reloading to apply theme…";
  setTimeout(() => location.reload(), 600);
});

renderPreferences();

// ---- System Logs + Access Management (owner only) ----

async function loadSystemLogs() {
  const section = document.getElementById("system-logs-section");
  const list = document.getElementById("login-logs-list");
  const empty = document.getElementById("login-logs-empty");
  section.classList.remove("hidden");

  let snap;
  try {
    snap = await getDocs(query(collection(db, "login_logs"), orderBy("loginTime", "desc"), limit(20)));
  } catch (err) {
    console.error("[settings] login_logs read failed:", err);
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
        <span class="text-xs text-textGray font-code">${formatTimestamp(row.loginTime)}</span>`;
      return el;
    })
  );
}

// Whitelist Friend Management (owner only) — promoting someone into `friends` gives them
// their own private expenses/journal/photos/timeline/habits space (see firestore.rules).
async function loadWhitelistManagement() {
  const section = document.getElementById("whitelist-section");
  const list = document.getElementById("whitelist-list");
  const empty = document.getElementById("whitelist-empty");
  section.classList.remove("hidden");

  let logsSnap, friendsSnap;
  try {
    [logsSnap, friendsSnap] = await Promise.all([
      getDocs(collection(db, "login_logs")),
      getDocs(collection(db, "friends")),
    ]);
  } catch (err) {
    console.error("[settings] whitelist read failed:", err);
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
        console.error("[settings] whitelist toggle failed:", err);
        btn.disabled = false;
      }
    });
  });
}

onAuthStateChanged(auth, (user) => {
  if (!user) return;
  renderProfile(user);
  loadUsername(user);
  loadAbout(user);
  // Export & Backup is for anyone signed in now — everyone has their own data to back up.
  document.getElementById("export-section").classList.remove("hidden");
  if (isOwner(user)) {
    loadSystemLogs();
    loadWhitelistManagement();
  }
});
