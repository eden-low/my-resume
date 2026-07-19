import { auth, googleProvider, db, getUserMode } from "./firebase-init.js";
import { t } from "./js/i18n.js";
import { resolveDisplayName, publicDisplayName, formatHandle } from "./js/identity.js";
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
  getDoc,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  addDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

const authControl = document.getElementById("auth-control");

// Security audit fix: publicDisplayName(person)/person.bio are Firestore-stored free text any
// signed-in user can set on their own users/{uid} doc (readable by any signed-in user per
// firestore.rules), and this page renders every discoverable person's card -- every
// interpolation into innerHTML below must be escaped. Same implementation as calendar.js's
// pre-existing esc().
function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---- Connections (v3.2 "Trusted Connections") ----
//
// A real, mutual-consent friend-request graph — separate from the legacy owner/friend/viewer
// role whitelist (`friends/{email}`, still used only for canParticipate()/role gating). See
// firestore.rules' friend_requests/{toUid}/incoming/{fromUid} and friendships/{uid}/friends/
// {friendUid} collections, and CLAUDE.md's v3.2 section for the full design rationale — in
// particular why the accept flow never needs a cross-uid write or a transaction: each side only
// ever writes documents under their own uid path, and the *other* side's mirror is created lazily
// by that side's own client the next time it loads this page (reconcileFriendships() below).
//
// Discovery (Search People/Recommended) is still role-gated the same way it always was (a Viewer
// only finds the Owner; a Friend/Owner finds each other) — that's unrelated to this new graph,
// which layers "did we actually connect" on top of "can we find each other at all."

let allUsers = [];
const collectionsCountCache = new Map();
const myFriendUids = new Set();
const myIncomingMap = new Map(); // fromUid -> { status, ...requestData }
const outgoingStatusCache = new Map(); // targetUid -> "pending" | "none" (only meaningful values we store)
let sentRequestPeople = [];

const peopleSearchInput = document.getElementById("people-search");
const searchResultsSection = document.getElementById("search-results-section");
const searchResultsList = document.getElementById("search-results-list");
const searchResultsEmpty = document.getElementById("search-results-empty");
const browseSections = document.getElementById("browse-sections");
const recommendedList = document.getElementById("recommended-list");
const recommendedEmpty = document.getElementById("recommended-empty");
const connectionsList = document.getElementById("connections-list");
const connectionsEmpty = document.getElementById("connections-empty");
const requestsList = document.getElementById("requests-list");
const requestsEmpty = document.getElementById("requests-empty");
const sentRequestsList = document.getElementById("sent-requests-list");
const sentRequestsEmpty = document.getElementById("sent-requests-empty");

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

// ---- Friend graph: load my own two collection listings (no `where`, just the caller's own uid
// path — always rule-permitted, see firestore.rules), then self-heal any missing/stale mirrors. ----

async function loadMyFriendships() {
  const user = auth.currentUser;
  myFriendUids.clear();
  if (!user) return;
  try {
    const snap = await getDocs(collection(db, "friendships", user.uid, "friends"));
    snap.forEach((d) => myFriendUids.add(d.id));
  } catch (err) {
    console.error("[dashboard] friendships fetch failed:", err.code || err);
  }
}

async function loadMyIncomingRequests() {
  const user = auth.currentUser;
  myIncomingMap.clear();
  if (!user) return;
  try {
    const snap = await getDocs(collection(db, "friend_requests", user.uid, "incoming"));
    snap.forEach((d) => myIncomingMap.set(d.id, d.data()));
  } catch (err) {
    console.error("[dashboard] incoming requests fetch failed:", err.code || err);
  }
}

function friendshipDoc(targetPerson) {
  return {
    uid: auth.currentUser.uid,
    friendUid: targetPerson.uid,
    friendDisplayName: publicDisplayName(targetPerson),
    friendUsername: targetPerson.username || null,
    friendPhotoURL: targetPerson.photoURL || null,
    createdAt: serverTimestamp(),
  };
}

// Loop the already-fetched user directory (personal-app scale — same convention as
// publicCollectionsCount's per-card getDoc) to find who I've sent a still-pending request to
// (-> "Sent Requests"), and to self-heal: if someone I requested has since accepted but I don't
// have my own friendships/{me}/friends/{them} mirror yet, create it now (the accepting side only
// ever writes their own half — see the module comment above).
async function loadSentRequestsAndHeal() {
  const user = auth.currentUser;
  sentRequestPeople = [];
  if (!user) return;
  const candidates = allUsers.filter((p) => p.uid !== user.uid && !myFriendUids.has(p.uid));
  await Promise.all(candidates.map(async (person) => {
    try {
      const snap = await getDoc(doc(db, "friend_requests", person.uid, "incoming", user.uid));
      if (!snap.exists()) return;
      const status = snap.data().status;
      if (status === "pending") {
        outgoingStatusCache.set(person.uid, "pending");
        sentRequestPeople.push(person);
      } else if (status === "accepted") {
        await setDoc(doc(db, "friendships", user.uid, "friends", person.uid), {
          ...friendshipDoc(person),
          sourceRequestFromUid: user.uid,
          sourceRequestToUid: person.uid,
        });
        myFriendUids.add(person.uid);
      }
    } catch (err) {
      console.error("[dashboard] outgoing request check failed:", err.code || err);
    }
  }));
}

// Prune my own friendships mirror when the other side has removed theirs (Remove Friend can only
// delete the remover's own half — see firestore.rules — so the removed side self-prunes here).
async function pruneStaleFriendships() {
  const user = auth.currentUser;
  if (!user) return;
  await Promise.all([...myFriendUids].map(async (friendUid) => {
    try {
      const reciprocal = await getDoc(doc(db, "friendships", friendUid, "friends", user.uid));
      if (!reciprocal.exists()) {
        await deleteDoc(doc(db, "friendships", user.uid, "friends", friendUid));
        myFriendUids.delete(friendUid);
      }
    } catch (err) {
      console.error("[dashboard] friendship prune failed:", err.code || err);
    }
  }));
}

function relationshipState(person) {
  const user = auth.currentUser;
  if (!user || person.uid === user.uid) return "self";
  if (myFriendUids.has(person.uid)) return "friend";
  if (myIncomingMap.get(person.uid)?.status === "pending") return "pending_incoming";
  if (outgoingStatusCache.get(person.uid) === "pending") return "pending_sent";
  return "none";
}

// ---- Friend actions ----

async function sendFriendRequest(person) {
  const user = auth.currentUser;
  if (!user) return;
  const me = allUsers.find((p) => p.uid === user.uid);
  const myName = (me && publicDisplayName(me)) || user.displayName || "Someone";
  try {
    await setDoc(doc(db, "friend_requests", person.uid, "incoming", user.uid), {
      fromUid: user.uid,
      toUid: person.uid,
      status: "pending",
      fromDisplayName: myName,
      fromUsername: me?.username || null,
      fromPhotoURL: me?.photoURL || user.photoURL || null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    await addDoc(collection(db, "notifications"), {
      uid: person.uid,
      type: "friend_request",
      fromUid: user.uid,
      title: t("inbox.friend_request_title"),
      message: t("inbox.friend_request_message", { name: myName }),
      read: false,
      createdAt: serverTimestamp(),
    });
    outgoingStatusCache.set(person.uid, "pending");
    sentRequestPeople.push(person);
    renderSentRequests();
  } catch (err) {
    console.error("[dashboard] send friend request failed:", err.code || err);
  }
}

async function acceptRequest(fromUid) {
  const user = auth.currentUser;
  if (!user) return;
  const reqRef = doc(db, "friend_requests", user.uid, "incoming", fromUid);
  try {
    const reqSnap = await getDoc(reqRef);
    if (!reqSnap.exists()) return;
    const reqData = reqSnap.data();
    await updateDoc(reqRef, { status: "accepted", updatedAt: serverTimestamp() });
    await setDoc(doc(db, "friendships", user.uid, "friends", fromUid), {
      uid: user.uid,
      friendUid: fromUid,
      friendDisplayName: reqData.fromDisplayName || "",
      friendUsername: reqData.fromUsername || null,
      friendPhotoURL: reqData.fromPhotoURL || null,
      createdAt: serverTimestamp(),
      sourceRequestFromUid: fromUid,
      sourceRequestToUid: user.uid,
    });
    myFriendUids.add(fromUid);
    myIncomingMap.delete(fromUid);

    const me = allUsers.find((p) => p.uid === user.uid);
    const myName = (me && publicDisplayName(me)) || user.displayName || "Someone";
    await addDoc(collection(db, "notifications"), {
      uid: fromUid,
      type: "friend_accepted",
      fromUid: user.uid,
      title: t("inbox.friend_accepted_title"),
      message: t("inbox.friend_accepted_message", { name: myName }),
      read: false,
      createdAt: serverTimestamp(),
    });
    renderRequests();
    renderBrowseSections();
  } catch (err) {
    console.error("[dashboard] accept request failed:", err.code || err);
  }
}

async function declineRequest(fromUid) {
  const user = auth.currentUser;
  if (!user) return;
  try {
    await updateDoc(doc(db, "friend_requests", user.uid, "incoming", fromUid), { status: "declined", updatedAt: serverTimestamp() });
    myIncomingMap.delete(fromUid);
    renderRequests();
  } catch (err) {
    console.error("[dashboard] decline request failed:", err.code || err);
  }
}

async function removeFriend(friendUid) {
  const user = auth.currentUser;
  if (!user) return;
  try {
    await deleteDoc(doc(db, "friendships", user.uid, "friends", friendUid));
    myFriendUids.delete(friendUid);
    renderBrowseSections();
  } catch (err) {
    console.error("[dashboard] remove friend failed:", err.code || err);
  }
}

// ---- Card rendering (shared by Recommended / My Friends / Search Results) ----

// Card never renders `person.email` anywhere — Search People/Connections is a discovery
// surface by @username or Display Name only, never by the private account email (see
// js/identity.js's publicDisplayName()/formatHandle(), which are deliberately email-blind).
function personCard(person) {
  const handle = formatHandle(person.username);
  const state = relationshipState(person);
  const el = document.createElement("div");
  el.className = "flex items-start gap-3 p-4 rounded-xl border border-borderNeon bg-darkBg/40 hover:border-neonPurple/40 transition-colors";
  el.innerHTML = `
    <a href="profile.html?${person.username ? "u=" + encodeURIComponent(person.username) : "uid=" + encodeURIComponent(person.uid)}" class="card-lift flex items-start gap-3 min-w-0 flex-1">
      <div class="w-11 h-11 rounded-full bg-neonPurple/10 flex items-center justify-center text-neonPurple text-sm overflow-hidden flex-shrink-0">
        ${person.photoURL ? `<img src="${esc(person.photoURL)}" class="w-full h-full object-cover">` : `<i class="fa-solid fa-user"></i>`}
      </div>
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-1.5 min-w-0">
          <p class="text-sm font-semibold text-white truncate">${esc(publicDisplayName(person))}</p>
          ${person.role === "owner" ? `<i class="fa-solid fa-star text-neonPurple text-[10px]" title="${t("people.owner_badge")}"></i>` : ""}
          ${state === "friend" ? `<i class="fa-solid fa-user-check text-emerald-400 text-[10px]" title="${t("people.friend")}"></i>` : ""}
        </div>
        ${handle ? `<p class="text-[11px] text-textGray font-code truncate">${esc(handle)}</p>` : ""}
        ${person.bio ? `<p class="text-xs text-white/80 mt-1.5 line-clamp-2">${esc(person.bio)}</p>` : ""}
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-[10px] font-code text-textGray">
          ${person.location ? `<span><i class="fa-solid fa-location-dot mr-1"></i>${esc(person.location)}</span>` : ""}
          <span class="collections-count-slot"><i class="fa-solid fa-layer-group mr-1"></i>&hellip;</span>
        </div>
        <span class="inline-flex items-center gap-1.5 mt-3 text-[11px] font-code text-neonPurple">
          <span data-i18n="people.open_profile">Open Profile</span> <i class="fa-solid fa-arrow-right text-[9px]"></i>
        </span>
      </div>
    </a>
    <div class="action-slot flex-shrink-0 flex flex-col items-end gap-1.5"></div>`;

  const countSlot = el.querySelector(".collections-count-slot");
  publicCollectionsCount(person.uid).then((count) => {
    countSlot.innerHTML = `<i class="fa-solid fa-layer-group mr-1"></i>${count} ${count === 1 ? t("people.collection") : t("people.collections")}`;
  });

  el.querySelector(".action-slot").replaceChildren(...relationshipActionButtons(person, state));
  return el;
}

function actionButton(label, extraClass) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `px-3 py-1.5 rounded-lg text-[11px] font-code transition-colors whitespace-nowrap ${extraClass}`;
  btn.textContent = label;
  return btn;
}

function relationshipActionButtons(person, state) {
  if (state === "friend") {
    const removeBtn = actionButton(t("people.remove_friend"), "text-rose-400 border border-rose-400/30 hover:bg-rose-400/10");
    removeBtn.addEventListener("click", async () => {
      if (!confirm(t("people.remove_friend_confirm"))) return;
      removeBtn.disabled = true;
      await removeFriend(person.uid);
    });
    return [removeBtn];
  }
  if (state === "pending_sent") {
    const btn = actionButton(t("people.pending"), "text-textGray border border-borderNeon opacity-60 cursor-default");
    btn.disabled = true;
    return [btn];
  }
  if (state === "pending_incoming") {
    const acceptBtn = actionButton(t("common.accept"), "text-emerald-400 border border-emerald-400/30 hover:bg-emerald-400/10");
    acceptBtn.addEventListener("click", async () => {
      acceptBtn.disabled = true;
      await acceptRequest(person.uid);
    });
    const declineBtn = actionButton(t("common.decline"), "text-textGray border border-borderNeon hover:border-rose-400/40 hover:text-rose-400");
    declineBtn.addEventListener("click", async () => {
      declineBtn.disabled = true;
      await declineRequest(person.uid);
    });
    return [acceptBtn, declineBtn];
  }
  if (state === "self") return [];
  const addBtn = actionButton(t("people.add_friend"), "text-textGray border border-borderNeon hover:border-neonPurple/40 hover:text-neonPurple");
  addBtn.addEventListener("click", async () => {
    addBtn.disabled = true;
    addBtn.textContent = t("people.request_sent");
    await sendFriendRequest(person);
  });
  return [addBtn];
}

// ---- Friend Requests (incoming) ----

function renderRequests() {
  const pending = [...myIncomingMap.entries()].filter(([, r]) => r.status === "pending");
  requestsEmpty.classList.toggle("hidden", pending.length > 0);
  requestsList.replaceChildren(
    ...pending.map(([fromUid, reqData]) => {
      const person = allUsers.find((p) => p.uid === fromUid) || {
        uid: fromUid,
        displayName: reqData.fromDisplayName,
        username: reqData.fromUsername,
        photoURL: reqData.fromPhotoURL,
      };
      return personCard(person);
    })
  );
}

// ---- Sent Requests ----

function renderSentRequests() {
  sentRequestsEmpty.classList.toggle("hidden", sentRequestPeople.length > 0);
  sentRequestsList.replaceChildren(...sentRequestPeople.map(personCard));
}

// ---- Recommended + My Friends (default browse mode) ----

function renderBrowseSections() {
  const searchable = searchableUsers();

  const recommended = [...searchable]
    .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0))
    .slice(0, 4);
  recommendedEmpty.classList.toggle("hidden", recommended.length > 0);
  recommendedList.replaceChildren(...recommended.map(personCard));

  const friends = allUsers
    .filter((p) => myFriendUids.has(p.uid))
    .sort((a, b) => publicDisplayName(a).localeCompare(publicDisplayName(b)));
  connectionsEmpty.classList.toggle("hidden", friends.length > 0);
  connectionsList.replaceChildren(...friends.map(personCard));

  renderRequests();
  renderSentRequests();
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

onAuthStateChanged(auth, async (user) => {
  if (user) {
    renderSignedIn(user);
    await loadUserDirectory();
    await Promise.all([loadMyFriendships(), loadMyIncomingRequests()]);
    await pruneStaleFriendships();
    await loadSentRequestsAndHeal();
    renderBrowseSections();
  } else {
    renderSignedOut();
    allUsers = [];
  }
});

// Re-render browse sections (person cards carry a translated collections-count label) and the
// search results (if a search is currently active) whenever the language switches — cheap,
// since allUsers/friendship state are already cached and no refetch is needed.
document.addEventListener("eden:langchange", () => {
  if (auth.currentUser) renderSignedIn(auth.currentUser);
  renderBrowseSections();
  if (peopleSearchInput.value.trim()) {
    peopleSearchInput.dispatchEvent(new Event("input"));
  }
});
