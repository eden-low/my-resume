import { auth, googleProvider, db, getUserMode } from "./firebase-init.js";
import { t } from "./js/i18n.js";
import { resolveDisplayName, publicDisplayName, formatHandle } from "./js/identity.js";
import {
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import { collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

const authControl = document.getElementById("auth-control");

// ---- Connections (Apple Contacts-style discovery, not a social feed) ----
//
// Visibility is role-gated (mirroring firestore.rules' isFriend()/isOwner() intent, enforced
// here client-side against the public `role` field every user's own login.html upsert writes
// to their `users/{uid}` doc — see CLAUDE.md): a Viewer may only find the Owner; a Friend or
// the Owner may find the Owner and any Friend. There is no follow/request graph in Firestore —
// "Your Connections" is simply everyone this account is currently allowed to see (the same set
// Search People has always used), "Recommended" is a small recently-joined highlight strip
// drawn from that same set, and "Connection Requests" is a placeholder with no backing data,
// per the brief. Opening a card always navigates to profile.html, a dedicated read-only page.

let allUsers = [];
const collectionsCountCache = new Map();

const peopleSearchInput = document.getElementById("people-search");
const searchResultsSection = document.getElementById("search-results-section");
const searchResultsList = document.getElementById("search-results-list");
const searchResultsEmpty = document.getElementById("search-results-empty");
const browseSections = document.getElementById("browse-sections");
const recommendedList = document.getElementById("recommended-list");
const recommendedEmpty = document.getElementById("recommended-empty");
const connectionsList = document.getElementById("connections-list");
const connectionsEmpty = document.getElementById("connections-empty");

async function loadUserDirectory() {
  try {
    const snap = await getDocs(collection(db, "users"));
    allUsers = snap.docs.map((d) => d.data());
  } catch (err) {
    console.error("[dashboard] users directory fetch failed:", err.code || err);
    allUsers = [];
  }
  renderBrowseSections();
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

async function publicCollectionsCount(uid) {
  if (collectionsCountCache.has(uid)) return collectionsCountCache.get(uid);
  try {
    const snap = await getDocs(query(collection(db, "collections"), where("uid", "==", uid), where("visibility", "==", "public")));
    collectionsCountCache.set(uid, snap.size);
    return snap.size;
  } catch (err) {
    console.error("[dashboard] public collections count failed:", err.code || err);
    return 0;
  }
}

// ---- Card rendering (shared by Recommended / Your Connections / Search Results) ----

// Card never renders `person.email` anywhere — Search People/Connections is a discovery
// surface by @username or Display Name only, never by the private account email (see
// js/identity.js's publicDisplayName()/formatHandle(), which are deliberately email-blind).
function personCard(person) {
  const handle = formatHandle(person.username);
  const el = document.createElement("div");
  el.className = "flex items-start gap-3 p-4 rounded-xl border border-borderNeon bg-darkBg/40 hover:border-neonPurple/40 transition-colors";
  el.innerHTML = `
    <a href="profile.html?${person.username ? "u=" + encodeURIComponent(person.username) : "uid=" + encodeURIComponent(person.uid)}" class="card-lift flex items-start gap-3 min-w-0 flex-1">
      <div class="w-11 h-11 rounded-full bg-neonPurple/10 flex items-center justify-center text-neonPurple text-sm overflow-hidden flex-shrink-0">
        ${person.photoURL ? `<img src="${person.photoURL}" class="w-full h-full object-cover">` : `<i class="fa-solid fa-user"></i>`}
      </div>
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-1.5 min-w-0">
          <p class="text-sm font-semibold text-white truncate">${publicDisplayName(person)}</p>
          ${person.role === "owner" ? `<i class="fa-solid fa-star text-neonPurple text-[10px]" title="${t("people.owner_badge")}"></i>` : ""}
        </div>
        ${handle ? `<p class="text-[11px] text-textGray font-code truncate">${handle}</p>` : ""}
        ${person.bio ? `<p class="text-xs text-white/80 mt-1.5 line-clamp-2">${person.bio}</p>` : ""}
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-[10px] font-code text-textGray">
          ${person.location ? `<span><i class="fa-solid fa-location-dot mr-1"></i>${person.location}</span>` : ""}
          <span class="collections-count-slot"><i class="fa-solid fa-layer-group mr-1"></i>&hellip;</span>
        </div>
        <span class="inline-flex items-center gap-1.5 mt-3 text-[11px] font-code text-neonPurple">
          <span data-i18n="people.open_profile">Open Profile</span> <i class="fa-solid fa-arrow-right text-[9px]"></i>
        </span>
      </div>
    </a>
    <button type="button" class="connect-btn flex-shrink-0 px-3 py-1.5 rounded-lg text-[11px] font-code text-textGray border border-borderNeon hover:border-neonPurple/40 hover:text-neonPurple transition-colors" data-i18n="people.connect">${t("people.connect")}</button>`;

  const countSlot = el.querySelector(".collections-count-slot");
  publicCollectionsCount(person.uid).then((count) => {
    countSlot.innerHTML = `<i class="fa-solid fa-layer-group mr-1"></i>${count} ${count === 1 ? t("people.collection") : t("people.collections")}`;
  });

  // No connection-request graph exists in Firestore (same "future placeholder, no backing
  // data" decision as the Connection Requests card below) — this only ever shows a one-line
  // acknowledgement, never writes anything.
  const connectBtn = el.querySelector(".connect-btn");
  connectBtn.addEventListener("click", () => {
    connectBtn.textContent = t("people.connect_sent");
    connectBtn.disabled = true;
    connectBtn.classList.add("opacity-60");
  });

  return el;
}

// ---- Recommended + Your Connections (default browse mode) ----

function renderBrowseSections() {
  const searchable = searchableUsers();

  const recommended = [...searchable]
    .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0))
    .slice(0, 4);
  recommendedEmpty.classList.toggle("hidden", recommended.length > 0);
  recommendedList.replaceChildren(...recommended.map(personCard));

  const connections = [...searchable].sort((a, b) =>
    publicDisplayName(a).localeCompare(publicDisplayName(b))
  );
  connectionsEmpty.classList.toggle("hidden", connections.length > 0);
  connectionsList.replaceChildren(...connections.map(personCard));
}

// ---- Search (query mode) ----

peopleSearchInput.addEventListener("input", (event) => {
  const q = event.target.value.trim().toLowerCase().replace(/^@/, "");
  if (!q) {
    searchResultsSection.classList.add("hidden");
    browseSections.classList.remove("hidden");
    return;
  }
  browseSections.classList.add("hidden");
  searchResultsSection.classList.remove("hidden");

  // Username/Display Name only — never matched against email (see CLAUDE.md/js/identity.js:
  // Connections discovery is by @handle or name, the private account email is not a search key).
  const matches = searchableUsers()
    .filter((p) => (p.displayName || "").toLowerCase().includes(q) || (p.username || "").toLowerCase().includes(q))
    .slice(0, 12);

  searchResultsEmpty.classList.toggle("hidden", matches.length > 0);
  searchResultsList.replaceChildren(...matches.map(personCard));
});

function renderSignedOut() {
  authControl.innerHTML = `
    <button id="auth-signin-btn" class="px-4 py-2 bg-gradient-to-r from-neonViolet to-neonPurple rounded-full text-xs font-semibold text-white hover:scale-105 transition-transform">
      <i class="fa-brands fa-google mr-2"></i> <span data-i18n="common.sign_in">Sign In</span>
    </button>`;
  document.getElementById("auth-signin-btn").addEventListener("click", () => {
    signInWithPopup(auth, googleProvider).catch((err) => console.error("Sign-in failed", err));
  });
}

async function renderSignedIn(user) {
  const name = await resolveDisplayName(user);
  authControl.innerHTML = `
    <span class="text-xs text-textGray font-code hidden sm:inline">${t("common.signed_in_as")} <span class="text-white">${name}</span></span>`;
}

onAuthStateChanged(auth, (user) => {
  if (user) {
    renderSignedIn(user);
  } else {
    renderSignedOut();
  }
  loadUserDirectory();
});

// Re-render browse sections (person cards carry a translated collections-count label) and the
// search results (if a search is currently active) whenever the language switches — cheap,
// since allUsers is already cached and no refetch is needed.
document.addEventListener("eden:langchange", () => {
  if (auth.currentUser) renderSignedIn(auth.currentUser);
  renderBrowseSections();
  if (peopleSearchInput.value.trim()) {
    peopleSearchInput.dispatchEvent(new Event("input"));
  }
});
