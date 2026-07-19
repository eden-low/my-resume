import { auth, googleProvider, db, storage, canParticipate } from "./firebase-init.js";
import { t as i18nT, getLang } from "./js/i18n.js";
import { wirePlaceSearch } from "./js/location-search.js";
import { readLocationFields, wireExactLocationControls, wireRemoveLocation, normalizeLocation } from "./js/location-fields.js";
import { resolveDisplayName } from "./js/identity.js";
import { excludeDeleted, isDeleted } from "./js/memory-filters.js";
import {
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import {
  collection,
  query,
  where,
  orderBy,
  getDocs,
  addDoc,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import {
  ref,
  uploadBytes,
  getDownloadURL,
  deleteObject,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-storage.js";

// Security audit fix: post.caption/comment text are Firestore-stored free text from any
// participant, and photos default to isMineOrPublic (public/connections posts are readable by
// other signed-in users) — every interpolation into innerHTML below must be escaped. Same
// implementation as calendar.js's pre-existing esc(), for consistency.
function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Albums, replacing the old Personal/Event/Work/Project categories.
const CATEGORY_META = {
  travel: { i18nKey: "memories.album_travel", text: "text-neonBlue", bg: "bg-neonBlue/10", border: "border-neonBlue/30" },
  projects: { i18nKey: "memories.album_projects", text: "text-emerald-400", bg: "bg-emerald-400/10", border: "border-emerald-400/30" },
  events: { i18nKey: "memories.album_events", text: "text-amber-400", bg: "bg-amber-400/10", border: "border-amber-400/30" },
  dailylife: { i18nKey: "memories.album_dailylife", text: "text-neonPurple", bg: "bg-neonPurple/10", border: "border-neonPurple/30" },
};

// Photos uploaded before the album relabel still carry the old category values in Firestore —
// alias them into the new taxonomy for display/filtering rather than migrating production data.
const LEGACY_CATEGORY_ALIAS = { personal: "dailylife", event: "events", work: "projects", project: "projects" };

function albumOf(post) {
  return LEGACY_CATEGORY_ALIAS[post.category] || post.category;
}

let cachedCollections = null;
async function loadMyCollectionOptions() {
  const user = auth.currentUser;
  if (!user) return [];
  if (cachedCollections) return cachedCollections;
  try {
    const snap = await getDocs(query(collection(db, "collections"), where("uid", "==", user.uid)));
    cachedCollections = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.error("[gallery] collections fetch failed:", err.code || err);
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

const authControl = document.getElementById("auth-control");
const accessNote = document.getElementById("gallery-access-note");
const feedContainer = document.getElementById("feed-container");
const feedEmpty = document.getElementById("feed-empty");
const feedEmptyCta = document.getElementById("feed-empty-cta");
const filterTabs = document.querySelectorAll(".filter-tab");
const privateTab = document.querySelector('.filter-tab[data-filter="private"]');
const connectionsTab = document.querySelector('.filter-tab[data-filter="connections"]');
const newPostBtn = document.getElementById("new-post-btn");
const postModal = document.getElementById("post-modal");
const postModalClose = document.getElementById("post-modal-close");
const postModalBackdrop = document.getElementById("post-modal-backdrop");
const postForm = document.getElementById("post-form");
const postStatus = document.getElementById("post-status");
const selectModeBtn = document.getElementById("select-mode-btn");
const postEditModal = document.getElementById("post-edit-modal");
const postEditModalClose = document.getElementById("post-edit-modal-close");
const postEditModalBackdrop = document.getElementById("post-edit-modal-backdrop");
const postEditForm = document.getElementById("post-edit-form");
const postEditStatus = document.getElementById("post-edit-status");
const bulkMoveBar = document.getElementById("bulk-move-bar");
const bulkMoveCount = document.getElementById("bulk-move-count");
const bulkMoveCollection = document.getElementById("bulk-move-collection");
const bulkMoveBtn = document.getElementById("bulk-move-btn");
const bulkMoveCancel = document.getElementById("bulk-move-cancel");

// ---- Trash ----
const trashViewBtn = document.getElementById("trash-view-btn");
const trashViewCount = document.getElementById("trash-view-count");
const feedToolbar = document.getElementById("feed-toolbar");
const trashView = document.getElementById("trash-view");
const trashBackBtn = document.getElementById("trash-back-btn");
const trashLoading = document.getElementById("trash-loading");
const trashError = document.getElementById("trash-error");
const trashRetryBtn = document.getElementById("trash-retry-btn");
const trashEmpty = document.getElementById("trash-empty");
const trashGrid = document.getElementById("trash-grid");
const trashConfirmModal = document.getElementById("trash-confirm-modal");
const trashConfirmBackdrop = document.getElementById("trash-confirm-backdrop");
const trashConfirmThumb = document.getElementById("trash-confirm-thumb");
const trashConfirmCaption = document.getElementById("trash-confirm-caption");
const trashConfirmError = document.getElementById("trash-confirm-error");
const trashConfirmCancel = document.getElementById("trash-confirm-cancel");
const trashConfirmSubmit = document.getElementById("trash-confirm-submit");
const deleteConfirmModal = document.getElementById("delete-confirm-modal");
const deleteConfirmBackdrop = document.getElementById("delete-confirm-backdrop");
const deleteConfirmThumb = document.getElementById("delete-confirm-thumb");
const deleteConfirmCaption = document.getElementById("delete-confirm-caption");
const deleteConfirmError = document.getElementById("delete-confirm-error");
const deleteConfirmCancel = document.getElementById("delete-confirm-cancel");
const deleteConfirmSubmit = document.getElementById("delete-confirm-submit");
const postEditTrashBtn = document.getElementById("post-edit-trash-btn");
const memoryToast = document.getElementById("memory-toast");
const memoryToastText = document.getElementById("memory-toast-text");
const memoryToastAction = document.getElementById("memory-toast-action");
const memoryToastClose = document.getElementById("memory-toast-close");

let cachedPosts = [];
let cachedTrashedPosts = [];
let trashMode = false;
let pendingTrashPost = null;
let pendingDeletePost = null;
const inFlightMemoryOps = new Set();
let activeFilter = "all";
const viewedThisSession = new Set();
const expandedComments = new Set();
const expandedAnalytics = new Set();
const commentsCache = new Map();
let selectMode = false;
const selectedIds = new Set();

function formatTimestamp(ts) {
  if (!ts?.toDate) return "";
  return ts.toDate().toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

// Recognizes ownership on both current (`uid`) and legacy pre-v2.0 (`uploadedBy`) posts.
function isMyPost(post, user) {
  return !!user && (post.uid === user.uid || post.uploadedBy === user.uid);
}

function visibilityBadge(visibility) {
  if (visibility === "private") return { icon: "fa-lock", cls: "border-rose-400/30 bg-rose-400/10 text-rose-400", label: i18nT("common.private") };
  if (visibility === "connections") return { icon: "fa-user-group", cls: "border-neonBlue/30 bg-neonBlue/10 text-neonBlue", label: i18nT("common.connections") };
  return { icon: "fa-globe", cls: "border-emerald-400/30 bg-emerald-400/10 text-emerald-400", label: i18nT("common.public") };
}

function postCard(post) {
  const meta = CATEGORY_META[albumOf(post)] || CATEGORY_META.dailylife;
  const vis = visibilityBadge(post.visibility);
  const user = auth.currentUser;
  const isMine = isMyPost(post, user);
  const commentsOpen = expandedComments.has(post.id);
  const analyticsOpen = expandedAnalytics.has(post.id);

  const card = document.createElement("article");
  card.className = "is-visible relative bg-cardBg/90 backdrop-blur-sm rounded-2xl neon-border-purple overflow-hidden";
  card.dataset.postId = post.id; // used by maybeFocusPostFromQuery() to deep-link from the Atlas Assistant's source chips
  card.tabIndex = -1; // programmatically focusable (for the deep-link highlight) without joining the normal Tab order
  card.innerHTML = `
    ${isMine && selectMode ? `
      <label class="absolute top-3 left-3 z-10 w-6 h-6 rounded-md bg-darkBg/80 border border-borderNeon flex items-center justify-center cursor-pointer">
        <input type="checkbox" class="select-checkbox w-4 h-4" ${selectedIds.has(post.id) ? "checked" : ""}>
      </label>` : ""}
    <img src="${esc(post.url)}" alt="${esc(post.caption || "Gallery post")}" class="w-full max-h-[520px] object-cover">
    <div class="p-4 space-y-3">
      ${post.caption ? `<p class="text-sm text-white">${esc(post.caption)}</p>` : ""}
      <div class="flex flex-wrap items-center gap-2 text-[10px] font-code">
        <span class="px-2 py-0.5 rounded-full border ${meta.border} ${meta.bg} ${meta.text}">${i18nT(meta.i18nKey)}</span>
        <span class="px-2 py-0.5 rounded-full border ${vis.cls}">
          <i class="fa-solid ${vis.icon} mr-1"></i>${vis.label}
        </span>
        ${isMine ? `<span class="px-2 py-0.5 rounded-full border border-borderNeon bg-darkBg/60 text-textGray">me</span>` : ""}
        ${(post.tags || []).map((t) => `<span class="px-2 py-0.5 rounded-full border border-borderNeon bg-darkBg/40 text-textGray">#${t}</span>`).join("")}
        ${post.locationName ? `<span class="px-2 py-0.5 rounded-full border border-borderNeon bg-darkBg/40 text-textGray"><i class="fa-solid fa-location-dot mr-1"></i>${post.locationName}</span>` : ""}
        <span class="text-textGray">${formatTimestamp(post.uploadedAt)}</span>
      </div>
      <div class="flex items-center gap-4 pt-3 border-t border-borderNeon/40">
        <button class="like-btn flex items-center gap-1.5 text-xs font-code ${post.likedByMe ? "text-rose-400" : "text-textGray"} hover:text-rose-400 transition-colors" ${user ? "" : "disabled"}>
          <i class="fa-${post.likedByMe ? "solid" : "regular"} fa-heart"></i> ${post.likeCount || 0}
        </button>
        <button class="comment-toggle-btn flex items-center gap-1.5 text-xs font-code text-textGray hover:text-neonPurple transition-colors">
          <i class="fa-regular fa-comment"></i> ${post.commentCount || 0}
        </button>
        ${isMine ? `
          <button class="featured-toggle-btn flex items-center gap-1.5 text-xs font-code ${post.featured ? "text-amber-400" : "text-textGray"} hover:text-amber-400 transition-colors" title="${post.featured ? "Remove from Favorites" : "Add to Favorites"}">
            <i class="fa-${post.featured ? "solid" : "regular"} fa-star"></i>
          </button>
          <button class="edit-post-btn flex items-center gap-1.5 text-xs font-code text-textGray hover:text-neonPurple transition-colors" title="${i18nT("common.edit_metadata")}">
            <i class="fa-solid fa-pen"></i>
          </button>
          <button class="trash-post-btn flex items-center gap-1.5 text-xs font-code text-textGray hover:text-rose-400 transition-colors" title="${i18nT("memories.move_to_trash")}">
            <i class="fa-solid fa-trash-can"></i>
          </button>
          <button class="analytics-toggle-btn ml-auto flex items-center gap-1.5 text-xs font-code text-textGray hover:text-neonBlue transition-colors">
            <i class="fa-solid fa-eye"></i> Analytics
          </button>` : ""}
      </div>
      <div class="comments-panel ${commentsOpen ? "" : "hidden"}"></div>
      <div class="analytics-panel ${analyticsOpen ? "" : "hidden"}"></div>
    </div>`;

  card.querySelector(".like-btn").addEventListener("click", () => toggleLike(post));
  card.querySelector(".comment-toggle-btn").addEventListener("click", () => toggleComments(post));
  const featuredBtn = card.querySelector(".featured-toggle-btn");
  if (featuredBtn) featuredBtn.addEventListener("click", () => toggleFeatured(post));
  const editBtn = card.querySelector(".edit-post-btn");
  if (editBtn) editBtn.addEventListener("click", () => openEditModal(post));
  const trashBtn = card.querySelector(".trash-post-btn");
  if (trashBtn) trashBtn.addEventListener("click", () => openTrashConfirm(post));
  const analyticsBtn = card.querySelector(".analytics-toggle-btn");
  if (analyticsBtn) analyticsBtn.addEventListener("click", () => toggleAnalytics(post));
  const checkbox = card.querySelector(".select-checkbox");
  if (checkbox) {
    checkbox.addEventListener("click", (e) => e.stopPropagation());
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selectedIds.add(post.id);
      else selectedIds.delete(post.id);
      updateBulkMoveBar();
    });
  }

  if (commentsOpen) renderCommentsPanel(post, card);
  if (analyticsOpen) renderAnalyticsPanel(post, card);

  return card;
}

function renderFeed() {
  const visible = activeFilter === "all"
    ? cachedPosts
    : activeFilter === "public" || activeFilter === "private" || activeFilter === "connections"
      ? cachedPosts.filter((p) => p.visibility === activeFilter)
      : activeFilter === "featured"
        ? cachedPosts.filter((p) => p.featured)
        : cachedPosts.filter((p) => albumOf(p) === activeFilter);

  feedContainer.replaceChildren(...visible.map(postCard));
  feedEmpty.classList.toggle("hidden", visible.length > 0);
}

function setActiveTab(filter) {
  activeFilter = filter;
  filterTabs.forEach((btn) => {
    const active = btn.dataset.filter === filter;
    btn.classList.toggle("text-white", active);
    btn.classList.toggle("bg-neonPurple/15", active);
  });
  renderFeed();
}

filterTabs.forEach((btn) => btn.addEventListener("click", () => setActiveTab(btn.dataset.filter)));
setActiveTab("all");

async function attachSocialCounts(post) {
  const user = auth.currentUser;
  try {
    const likesSnap = await getDocs(collection(db, "photos", post.id, "likes"));
    post.likeCount = likesSnap.size;
    post.likedByMe = !!user && likesSnap.docs.some((d) => d.id === user.uid);
  } catch (err) {
    console.error("[gallery] likes fetch failed:", err.code || err);
    post.likeCount = 0;
    post.likedByMe = false;
  }
  try {
    const commentsSnap = await getDocs(collection(db, "photos", post.id, "comments"));
    post.commentCount = commentsSnap.size;
  } catch (err) {
    console.error("[gallery] comments count fetch failed:", err.code || err);
    post.commentCount = 0;
  }
}

function recordViews(posts) {
  const user = auth.currentUser;
  if (!user) return;
  posts.forEach(async (post) => {
    if (isMyPost(post, user)) return; // don't log viewing your own post
    if (viewedThisSession.has(post.id)) return;
    viewedThisSession.add(post.id);
    try {
      await addDoc(collection(db, "photos", post.id, "views"), {
        viewerUid: user.uid,
        viewerEmail: user.email,
        viewedAt: serverTimestamp(),
      });
    } catch (err) {
      console.error("[gallery] view record failed:", err.code || err);
    }
  });
}

// Best-effort "someone liked your photo" alert: there's no backend to push this the instant
// a like happens, so each poster's own client detects growth against a locally-cached count
// the next time they load the gallery. See notifications.js for the read side.
function checkLikeNotifications(posts) {
  const user = auth.currentUser;
  if (!user) return;
  posts.filter((post) => isMyPost(post, user)).forEach(async (post) => {
    const key = `lfj:lastSeenLikes:${post.id}`;
    const raw = localStorage.getItem(key);
    const lastSeen = raw === null ? null : Number(raw);
    const current = post.likeCount || 0;
    localStorage.setItem(key, String(current));
    if (lastSeen !== null && current > lastSeen) {
      try {
        await addDoc(collection(db, "notifications"), {
          uid: user.uid,
          type: "gallery",
          title: "New like on your photo",
          message: post.caption ? `Someone liked "${post.caption}".` : "Someone liked your photo.",
          read: false,
          createdAt: serverTimestamp(),
        });
      } catch (err) {
        console.error("[gallery] like notification write failed:", err.code || err);
      }
    }
  });
}

// Shared ownership-merge/dedup helper: every "all of my own photos" fetch in this file (the
// normal feed's "mine" half, and the Trash view) goes through this one function instead of
// each re-implementing its own uid+uploadedBy merge. Ownership is recognized on either the
// current `uid` field or the legacy pre-v2.0 `uploadedBy` field (firestore.rules'
// isPhotoMineOrPublic() accepts either) — a doc that happens to carry both is still only
// returned once, deduped by Firestore document ID via the Map.
async function fetchOwnPosts(uid) {
  const map = new Map();
  try {
    const mineSnap = await getDocs(query(collection(db, "photos"), where("uid", "==", uid)));
    mineSnap.forEach((d) => map.set(d.id, { id: d.id, ...d.data() }));
  } catch (err) {
    console.error("[gallery] own posts query failed:", err.code || err);
  }
  // Legacy posts from before the uploadedBy -> uid rename (no data migration was run).
  try {
    const legacySnap = await getDocs(query(collection(db, "photos"), where("uploadedBy", "==", uid)));
    legacySnap.forEach((d) => map.set(d.id, { id: d.id, ...d.data() }));
  } catch (err) {
    console.error("[gallery] legacy own posts query failed:", err.code || err);
  }
  return [...map.values()];
}

async function fetchVisiblePosts() {
  const user = auth.currentUser;
  const posts = new Map();

  try {
    const publicSnap = await getDocs(query(collection(db, "photos"), where("visibility", "==", "public")));
    publicSnap.forEach((d) => posts.set(d.id, { id: d.id, ...d.data() }));
  } catch (err) {
    console.error("[gallery] public posts query failed:", err.code || err);
  }

  if (user) {
    (await fetchOwnPosts(user.uid)).forEach((p) => posts.set(p.id, p));
  }

  const list = [...posts.values()];
  list.sort((a, b) => (b.uploadedAt?.toMillis?.() || 0) - (a.uploadedAt?.toMillis?.() || 0));

  // Trashed Memories (deletedAt set) are excluded from every normal surface, including this
  // feed — the single shared js/memory-filters.js predicate every other consumer in the app
  // also calls, so this is never re-implemented per-page. A formerly-public trashed Memory is
  // additionally excluded here for a second, independent reason: moving to Trash also flips
  // `visibility` to "private" (see submitMoveToTrash), so it no longer matches the public query
  // above even for a signed-in Viewer who isn't its owner — see the Trash section below for why.
  cachedPosts = excludeDeleted(list);
  await Promise.all(cachedPosts.map((post) => attachSocialCounts(post)));

  renderFeed();
  recordViews(cachedPosts);
  checkLikeNotifications(cachedPosts);
}

// Owner-only Trash listing: reuses the same ownership-merge helper the normal feed's "mine"
// half uses (no composite index needed — deletedAt is filtered client-side, matching this
// app's established index-avoidance convention), then keeps only the trashed ones.
async function fetchTrashedPosts() {
  const user = auth.currentUser;
  if (!user) return [];
  const list = (await fetchOwnPosts(user.uid)).filter(isDeleted);
  list.sort((a, b) => (b.deletedAt?.toMillis?.() || 0) - (a.deletedAt?.toMillis?.() || 0));
  return list;
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
  newPostBtn.classList.add("hidden");
  feedEmptyCta.classList.add("hidden");
  trashViewBtn.classList.add("hidden");
  if (trashMode) exitTrashView();
  if (activeFilter === "private" || activeFilter === "connections") setActiveTab("all");
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
  newPostBtn.classList.toggle("hidden", !mayParticipate);
  feedEmptyCta.classList.toggle("hidden", !mayParticipate);
  selectModeBtn.classList.toggle("hidden", !mayParticipate);
  trashViewBtn.classList.toggle("hidden", !mayParticipate);
  if (!mayParticipate && trashMode) exitTrashView();
  privateTab.classList.toggle("hidden", !mayParticipate);
  connectionsTab.classList.toggle("hidden", !mayParticipate);
  accessNote.classList.toggle("hidden", mayParticipate);
  if (!mayParticipate && (activeFilter === "private" || activeFilter === "connections")) setActiveTab("all");
  maybeAutoOpenFromQuickAdd(mayParticipate);
}

// Mobile Quick Add (js/mobile-nav.js) links here with ?new=1 to jump straight into the
// upload form instead of just landing on the feed.
let autoOpenedFromQuickAdd = false;
function maybeAutoOpenFromQuickAdd(mayParticipate) {
  if (autoOpenedFromQuickAdd || !mayParticipate) return;
  if (new URLSearchParams(location.search).get("new") === "1") {
    autoOpenedFromQuickAdd = true;
    openModal();
  }
}

// Deep-link support (task G): gallery.html?memory=<id> — from the Atlas Assistant's source
// chips (assistant.js), mirroring atlas.js's pre-existing ?memory= deep link for the map. The
// query param is never trusted as authorization by itself: it's only ever resolved against
// `cachedPosts`, which fetchVisiblePosts() already built from Firestore-scoped queries (the
// signed-in user's own docs + public docs — the exact same access boundary every other feature
// on this page already relies on). An id that's missing, belongs to someone else's private
// content, or doesn't resolve at all simply isn't found — no error, no way to tell from the
// outside whether it exists (fail safely). The param is always stripped via history.replaceState
// (no new history entry) whether or not it resolved, so a refresh/Back never re-triggers it.
function maybeFocusPostFromQuery() {
  const params = new URLSearchParams(location.search);
  const targetId = params.get("memory");
  if (!targetId) return;
  params.delete("memory");
  const qs = params.toString();
  history.replaceState(null, "", location.pathname + (qs ? `?${qs}` : "") + location.hash);

  const post = cachedPosts.find((p) => p.id === targetId);
  if (!post) return;

  // The matching card might not be in the DOM yet if a different filter tab is currently active
  // (renderFeed() only renders the active tab's subset) — switch to "All" so it's guaranteed to
  // render before we try to find/focus it.
  const stillVisible =
    activeFilter === "all" ||
    (activeFilter === "featured" && post.featured) ||
    activeFilter === post.visibility ||
    activeFilter === albumOf(post);
  if (!stillVisible) setActiveTab("all");

  requestAnimationFrame(() => {
    const card = feedContainer.querySelector(`[data-post-id="${CSS.escape(targetId)}"]`);
    if (!card) return;
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.setAttribute("aria-label", `${post.caption || i18nT("common.untitled")} — ${i18nT("assistant.opened_from_assistant") !== "assistant.opened_from_assistant" ? i18nT("assistant.opened_from_assistant") : "opened from Atlas Assistant"}`);
    card.classList.add("eden-deep-link-highlight");
    card.focus({ preventScroll: true });
    setTimeout(() => card.classList.remove("eden-deep-link-highlight"), 2500);
  });
}

onAuthStateChanged(auth, async (user) => {
  if (user) {
    renderSignedIn(user);
  } else {
    renderSignedOut();
  }
  await fetchVisiblePosts();
  maybeFocusPostFromQuery();
});

function openModal() {
  postModal.classList.remove("hidden");
}
function closeModal() {
  postModal.classList.add("hidden");
  postForm.reset();
  postStatus.textContent = "";
  postForm.querySelector('button[type="submit"]').disabled = false;
}

newPostBtn.addEventListener("click", openModal);
feedEmptyCta.addEventListener("click", openModal);
postModalClose.addEventListener("click", closeModal);
postModalBackdrop.addEventListener("click", closeModal);

function parseTags(raw) {
  return raw.split(",").map((t) => t.trim()).filter(Boolean);
}

const syncPostLocation = wireExactLocationControls("post", i18nT);
const syncPostEditLocation = wireExactLocationControls("post-edit", i18nT);
wirePlaceSearch("post", syncPostLocation);
const postEditPlaceSearch = wirePlaceSearch("post-edit", syncPostEditLocation);
wireRemoveLocation("post", i18nT, syncPostLocation);
wireRemoveLocation("post-edit", i18nT, syncPostEditLocation);

newPostBtn.addEventListener("click", () => populateCollectionSelect(document.getElementById("post-collection")));

postForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const user = auth.currentUser;
  if (!user || !canParticipate()) return;

  const file = document.getElementById("post-file").files[0];
  const caption = document.getElementById("post-caption").value.trim();
  const category = document.getElementById("post-category").value;
  const visibility = postForm.querySelector('input[name="post-visibility"]:checked').value;
  const collectionId = document.getElementById("post-collection").value || null;
  const tags = parseTags(document.getElementById("post-tags").value);
  if (!file) return;

  postForm.querySelector('button[type="submit"]').disabled = true;
  postStatus.textContent = i18nT("common.uploading");
  try {
    const storagePath = `gallery/${user.uid}/${visibility}/${category}/${Date.now()}-${file.name}`;
    const fileRef = ref(storage, storagePath);
    await uploadBytes(fileRef, file);
    const url = await getDownloadURL(fileRef);

    const locationFields = readLocationFields("post");
    const docRef = await addDoc(collection(db, "photos"), {
      url,
      storagePath,
      category,
      visibility,
      featured: false,
      caption: caption || file.name,
      uploadedAt: serverTimestamp(),
      uid: user.uid,
      collectionId,
      tags,
      ...locationFields,
    });

    await fetchVisiblePosts();
    // Phase 6 UX: when the save actually carries valid coordinates, show a stable "View on
    // Atlas" action and leave the modal open — no auto-close timer to race against. The user
    // dismisses it themselves (the link itself, or the modal's existing x/backdrop close,
    // already wired below) whenever they're done. The submit button stays disabled meanwhile
    // so an accidental second click can't re-upload the same file as a duplicate post.
    if (locationFields.latitude != null && locationFields.longitude != null) {
      postStatus.replaceChildren(document.createTextNode(`${i18nT("common.saved")} · `));
      const link = document.createElement("a");
      link.href = `atlas.html?memory=${encodeURIComponent(docRef.id)}`;
      link.className = "text-neonPurple hover:underline";
      link.textContent = i18nT("common.view_on_atlas");
      postStatus.appendChild(link);
    } else {
      postStatus.textContent = i18nT("common.saved");
      closeModal();
    }
  } catch (err) {
    console.error("Upload failed", err);
    postStatus.textContent = i18nT("common.upload_failed");
    postForm.querySelector('button[type="submit"]').disabled = false;
  }
});

// ---- Edit metadata ----

async function openEditModal(post) {
  document.getElementById("post-edit-id").value = post.id;
  document.getElementById("post-edit-caption").value = post.caption || "";
  document.getElementById("post-edit-category").value = albumOf(post);
  document.querySelector(`#post-edit-form input[name="post-edit-visibility"][value="${post.visibility || "public"}"]`).checked = true;
  document.getElementById("post-edit-tags").value = (post.tags || []).join(", ");
  // Initialize the shared location state from the stored document via normalizeLocation() —
  // never opened this modal's location fields "raw." Text/precision come from the normalized
  // result; the hidden lat/lng inputs still carry the RAW stored values (not the normalized
  // ones) so classifyLocation() (inside wireExactLocationControls' sync(), called right below)
  // can detect and surface a corrupted/out-of-range legacy value as "Invalid location" — the
  // save path (readLocationFields -> normalizeLocation) already guarantees such a value can
  // never be re-persisted, regardless of what's briefly visible here.
  const normalized = normalizeLocation({
    locationName: post.locationName,
    locationAddress: post.locationAddress,
    latitude: post.latitude,
    longitude: post.longitude,
    precisionHint: post.locationPrecision,
  });
  document.getElementById("post-edit-location-name").value = normalized.locationName || post.locationName || "";
  document.getElementById("post-edit-location-address").value = normalized.locationAddress || post.locationAddress || "";
  document.getElementById("post-edit-latitude").value = post.latitude ?? "";
  document.getElementById("post-edit-longitude").value = post.longitude ?? "";
  const isPlaceResolved = normalized.latitude != null && normalized.longitude != null && normalized.locationPrecision === "place_resolved";
  document.getElementById("post-edit-location-precision-hint").value = isPlaceResolved ? "place_resolved" : "";
  // Tell the edit form's search instance the prefilled name IS the confirmed place, so a
  // no-op "input" event (autocorrect, re-typing identical text) during this edit session
  // doesn't get mistaken for a manual rename and silently drop these valid coordinates.
  postEditPlaceSearch.confirmPlace(isPlaceResolved ? normalized.locationName : null);
  syncPostEditLocation();
  await populateCollectionSelect(document.getElementById("post-edit-collection"), post.collectionId);
  postEditStatus.textContent = "";
  postEditModal.classList.remove("hidden");
}
function closeEditModal() {
  // Cancel Edit: hides + resets the form only. No Firestore write happens unless Save was
  // clicked, so the cached post and its Atlas marker are left exactly as they were.
  postEditModal.classList.add("hidden");
  postEditForm.reset();
  postEditStatus.textContent = "";
}
postEditModalClose.addEventListener("click", closeEditModal);
postEditModalBackdrop.addEventListener("click", closeEditModal);
postEditTrashBtn.addEventListener("click", () => {
  const id = document.getElementById("post-edit-id").value;
  const post = cachedPosts.find((p) => p.id === id);
  if (!post) return;
  closeEditModal();
  openTrashConfirm(post);
});

postEditForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const user = auth.currentUser;
  if (!user) return;
  const id = document.getElementById("post-edit-id").value;
  const post = cachedPosts.find((p) => p.id === id);
  if (!post || !isMyPost(post, user)) return;

  const payload = {
    caption: document.getElementById("post-edit-caption").value.trim(),
    category: document.getElementById("post-edit-category").value,
    visibility: document.querySelector('#post-edit-form input[name="post-edit-visibility"]:checked').value,
    collectionId: document.getElementById("post-edit-collection").value || null,
    tags: parseTags(document.getElementById("post-edit-tags").value),
    ...readLocationFields("post-edit"),
    updatedAt: serverTimestamp(),
  };
  try {
    await updateDoc(doc(db, "photos", id), payload);
    // Same opt-in switch as atlas.js — verifies exactly what the edit wrote to Firestore.
    if (localStorage.getItem("eden_atlas_debug") === "1") console.log("[gallery:debug] edit saved", id, payload);
    postEditStatus.textContent = i18nT("common.saved");
    await fetchVisiblePosts();
    closeEditModal();
  } catch (err) {
    console.error("[gallery] edit save failed:", err.code || err);
    postEditStatus.textContent = i18nT("common.couldnt_save");
  }
});

// ---- Accessible confirm-modal helper (focus trap + Escape + focus restoration) ----
// No shared modal component exists yet in this codebase (every prior confirm() in the app —
// career.js, collections.js, time-capsule.js, etc. — used a bare window.confirm()); this is
// the first accessible modal, built from the same visual shell (.neon-border-purple card over
// a blurred backdrop) every other modal in the app already uses.
function trapFocus(modalEl, onEscape) {
  function handleKeydown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      onEscape();
      return;
    }
    if (e.key !== "Tab") return;
    const items = [...modalEl.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
      .filter((el) => !el.disabled && el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  modalEl.addEventListener("keydown", handleKeydown);
  return () => modalEl.removeEventListener("keydown", handleKeydown);
}

function makeConfirmModal({ modalEl, backdropEl, cancelBtn, submitBtn, onCancel, onSubmit }) {
  let untrap = null;
  let returnFocusEl = null;
  function close() {
    modalEl.classList.add("hidden");
    if (untrap) { untrap(); untrap = null; }
    if (returnFocusEl && document.body.contains(returnFocusEl)) returnFocusEl.focus();
    returnFocusEl = null;
  }
  function open() {
    returnFocusEl = document.activeElement;
    modalEl.classList.remove("hidden");
    untrap = trapFocus(modalEl, () => { onCancel(); close(); });
    cancelBtn.focus();
  }
  cancelBtn.addEventListener("click", () => { onCancel(); close(); });
  backdropEl.addEventListener("click", () => { onCancel(); close(); });
  submitBtn.addEventListener("click", onSubmit);
  return { open, close };
}

// ---- Toast (success + optional Undo action) ----
let toastTimer = null;
function showToast(message, { actionLabel, onAction } = {}) {
  clearTimeout(toastTimer);
  memoryToastText.textContent = message;
  if (actionLabel && onAction) {
    memoryToastAction.textContent = actionLabel;
    memoryToastAction.classList.remove("hidden");
    memoryToastAction.onclick = () => { hideToast(); onAction(); };
  } else {
    memoryToastAction.classList.add("hidden");
    memoryToastAction.onclick = null;
  }
  memoryToast.classList.remove("hidden");
  // Persistent enough to actually read and act on (e.g. Undo), but not forever — matches this
  // page's other transient status copy in spirit, just longer-lived since it can carry an action.
  toastTimer = setTimeout(hideToast, 8000);
}
function hideToast() {
  memoryToast.classList.add("hidden");
  clearTimeout(toastTimer);
}
memoryToastClose.addEventListener("click", hideToast);

// ---- Trash view ----

function trashCard(post) {
  const el = document.createElement("div");
  el.className = "bg-cardBg/90 rounded-xl neon-border-purple overflow-hidden";
  const deletedDate = post.deletedAt?.toDate
    ? post.deletedAt.toDate().toLocaleDateString(undefined, { dateStyle: "medium" })
    : "";
  // While trashed, `visibility` is always "private" (see submitMoveToTrash) — show the
  // *original* value from visibilityBeforeTrash so it's clear what Restore brings it back to.
  const vis = visibilityBadge(post.visibilityBeforeTrash || "private");
  el.innerHTML = `
    <img src="${esc(post.url)}" alt="" class="w-full h-28 object-cover opacity-70">
    <div class="p-2 space-y-1.5">
      <p class="text-[11px] text-white truncate">${esc(post.caption) || i18nT("common.untitled")}</p>
      <span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border ${vis.cls} text-[9px] font-code" title="${i18nT("memories.restores_to", { visibility: vis.label })}">
        <i class="fa-solid ${vis.icon}"></i>${vis.label}
      </span>
      ${deletedDate ? `<p class="text-[10px] font-code text-textGray">${i18nT("memories.deleted_on", { date: deletedDate })}</p>` : ""}
      <div class="flex items-center gap-1.5 pt-1">
        <button class="trash-restore-btn flex-1 px-2 py-1.5 bg-neonPurple/15 text-neonPurple rounded-lg text-[10px] font-cyber font-bold tracking-wider hover:bg-neonPurple/25 transition-colors">${i18nT("memories.restore")}</button>
        <button class="trash-delete-btn flex-1 px-2 py-1.5 bg-rose-500/15 text-rose-400 rounded-lg text-[10px] font-cyber font-bold tracking-wider hover:bg-rose-500/25 transition-colors">${i18nT("memories.permanently_delete_short")}</button>
      </div>
    </div>`;
  el.querySelector(".trash-restore-btn").addEventListener("click", () => restorePost(post));
  el.querySelector(".trash-delete-btn").addEventListener("click", () => openDeleteConfirm(post));
  return el;
}

function renderTrash() {
  trashGrid.replaceChildren(...cachedTrashedPosts.map(trashCard));
  trashEmpty.classList.toggle("hidden", cachedTrashedPosts.length > 0);
  trashViewCount.textContent = String(cachedTrashedPosts.length);
  trashViewCount.classList.toggle("hidden", cachedTrashedPosts.length === 0);
}

async function loadTrash() {
  trashLoading.classList.remove("hidden");
  trashError.classList.add("hidden");
  trashEmpty.classList.add("hidden");
  trashGrid.replaceChildren();
  try {
    cachedTrashedPosts = await fetchTrashedPosts();
    trashLoading.classList.add("hidden");
    renderTrash();
  } catch (err) {
    console.error("[gallery] trash fetch failed:", err.code || err);
    trashLoading.classList.add("hidden");
    trashError.classList.remove("hidden");
  }
}

function enterTrashView() {
  trashMode = true;
  feedToolbar.classList.add("hidden");
  feedContainer.classList.add("hidden");
  feedEmpty.classList.add("hidden");
  trashView.classList.remove("hidden");
  loadTrash();
}
function exitTrashView() {
  trashMode = false;
  trashView.classList.add("hidden");
  feedToolbar.classList.remove("hidden");
  feedContainer.classList.remove("hidden");
  renderFeed();
}
trashViewBtn.addEventListener("click", enterTrashView);
trashBackBtn.addEventListener("click", exitTrashView);
trashRetryBtn.addEventListener("click", loadTrash);

// ---- Move to Trash ----

const trashConfirmModalCtl = makeConfirmModal({
  modalEl: trashConfirmModal,
  backdropEl: trashConfirmBackdrop,
  cancelBtn: trashConfirmCancel,
  submitBtn: trashConfirmSubmit,
  onCancel: () => { pendingTrashPost = null; },
  onSubmit: () => submitMoveToTrash(),
});

function openTrashConfirm(post) {
  pendingTrashPost = post;
  trashConfirmError.classList.add("hidden");
  trashConfirmError.textContent = "";
  trashConfirmThumb.src = post.url;
  trashConfirmCaption.textContent = post.caption || i18nT("common.untitled");
  trashConfirmSubmit.disabled = false;
  trashConfirmSubmit.textContent = i18nT("memories.move_to_trash");
  trashConfirmModalCtl.open();
}

async function submitMoveToTrash() {
  const post = pendingTrashPost;
  const user = auth.currentUser;
  if (!post || !user || !isMyPost(post, user)) return;
  if (inFlightMemoryOps.has(post.id)) return; // prevent double submission
  inFlightMemoryOps.add(post.id);
  trashConfirmSubmit.disabled = true;
  trashConfirmCancel.disabled = true;
  trashConfirmSubmit.textContent = i18nT("memories.trash_loading");
  trashConfirmError.classList.add("hidden");
  try {
    // Security fix: excludeDeleted() is a UI filter, not access control — a trashed post that
    // kept visibility:"public" would still be directly readable (get-by-id) and still match the
    // public collection query (where("visibility","==","public")) for any signed-in Viewer,
    // Firestore rules and query filters both being entirely independent of deletedAt. Preserving
    // the exact prior value in visibilityBeforeTrash and flipping visibility to "private" makes
    // the *existing, unchanged* firestore.rules read rule (isPhotoMineOrPublic — private is only
    // ever readable by uid/uploadedBy) do the real enforcement, and the public/connections
    // collection queries stop matching it server-side too — no rules change needed.
    const visibilityBeforeTrash = post.visibility || "private";
    await updateDoc(doc(db, "photos", post.id), {
      visibilityBeforeTrash,
      visibility: "private",
      deletedAt: serverTimestamp(),
      deletedBy: user.uid,
      updatedAt: serverTimestamp(),
    });
    // Keep the in-memory copy consistent so a same-session Undo (below) restores the exact
    // prior visibility without needing a re-fetch first.
    post.visibilityBeforeTrash = visibilityBeforeTrash;
    post.visibility = "private";
    post.deletedBy = user.uid;
    // Remove immediately from the visible feed (and the Atlas cache is naturally stale-free
    // too — atlas.js always re-queries Firestore from scratch on load/visibility, it never
    // keeps a photos cache this page could have to invalidate).
    cachedPosts = cachedPosts.filter((p) => p.id !== post.id);
    renderFeed();
    pendingTrashPost = null;
    trashConfirmModalCtl.close();
    showToast(i18nT("memories.trash_success"), { actionLabel: i18nT("common.undo"), onAction: () => restorePost(post) });
  } catch (err) {
    // Do not claim success — leave the modal open with an inline error so the user can retry.
    console.error("[gallery] move to trash failed:", err.code || err);
    trashConfirmError.textContent = i18nT("memories.trash_error");
    trashConfirmError.classList.remove("hidden");
    trashConfirmSubmit.textContent = i18nT("memories.move_to_trash");
    trashConfirmSubmit.disabled = false;
    trashConfirmCancel.disabled = false;
  } finally {
    inFlightMemoryOps.delete(post.id);
  }
}

// ---- Restore ----

async function restorePost(post) {
  const user = auth.currentUser;
  if (!user || !isMyPost(post, user)) return;
  if (inFlightMemoryOps.has(post.id)) return;
  inFlightMemoryOps.add(post.id);
  try {
    // Restore the exact prior visibility (never assume "public" — an untrashed private/
    // connections item must come back exactly as it was, not more visible than before).
    const restoredVisibility = post.visibilityBeforeTrash || "private";
    await updateDoc(doc(db, "photos", post.id), {
      visibility: restoredVisibility,
      visibilityBeforeTrash: null,
      deletedAt: null,
      deletedBy: null,
      updatedAt: serverTimestamp(),
    });
    post.visibility = restoredVisibility;
    post.visibilityBeforeTrash = null;
    if (trashMode) {
      cachedTrashedPosts = cachedTrashedPosts.filter((p) => p.id !== post.id);
      renderTrash();
    }
    await fetchVisiblePosts(); // restores it into the normal feed, sorted/counted correctly
    showToast(i18nT("memories.restore_success"));
  } catch (err) {
    console.error("[gallery] restore failed:", err.code || err);
    showToast(i18nT("memories.restore_error"));
  } finally {
    inFlightMemoryOps.delete(post.id);
  }
}

// ---- Permanently delete ----
// Firestore and Storage deletion are two separate client calls, not one atomic transaction.
// Chosen failure strategy (documented in the fix report): delete the Storage object FIRST; a
// "storage/object-not-found" result is treated as already-clean (makes a retry after a prior
// partial failure idempotent, not an error); any OTHER storage failure stops here and leaves
// the Firestore document (and its storagePath) untouched so the user can retry — deleting the
// Firestore doc first and letting Storage cleanup fail afterward would orphan the file forever,
// since the doc that remembered its path would be gone. The Firestore doc is only deleted once
// Storage is confirmed clear (or was never eligible: missing/foreign/shared path).

const deleteConfirmModalCtl = makeConfirmModal({
  modalEl: deleteConfirmModal,
  backdropEl: deleteConfirmBackdrop,
  cancelBtn: deleteConfirmCancel,
  submitBtn: deleteConfirmSubmit,
  onCancel: () => { pendingDeletePost = null; },
  onSubmit: () => submitPermanentDelete(),
});

function openDeleteConfirm(post) {
  pendingDeletePost = post;
  deleteConfirmError.classList.add("hidden");
  deleteConfirmError.textContent = "";
  deleteConfirmThumb.src = post.url;
  deleteConfirmCaption.textContent = post.caption || i18nT("common.untitled");
  deleteConfirmSubmit.disabled = false;
  deleteConfirmSubmit.textContent = i18nT("memories.permanently_delete");
  deleteConfirmModalCtl.open();
}

async function submitPermanentDelete() {
  const post = pendingDeletePost;
  const user = auth.currentUser;
  if (!post || !user || !isMyPost(post, user)) return;
  if (inFlightMemoryOps.has(post.id)) return; // prevent double submission / uncontrolled retries
  inFlightMemoryOps.add(post.id);
  deleteConfirmSubmit.disabled = true;
  deleteConfirmCancel.disabled = true;
  deleteConfirmSubmit.textContent = i18nT("memories.permanent_delete_loading");
  deleteConfirmError.classList.add("hidden");
  try {
    const ownerUid = post.uid || post.uploadedBy || user.uid;
    // Only ever a path this same user owns by construction (gallery/{uid}/...) — never an
    // external URL, never derived from the download URL, never another user's file.
    if (post.storagePath && post.storagePath.startsWith(`gallery/${ownerUid}/`)) {
      try {
        // Defense-in-depth: confirm no OTHER photos doc references this exact storage path
        // before deleting the underlying file. storagePath already bakes in the uploader's uid
        // and an upload timestamp+filename, so a genuine collision is effectively impossible —
        // this never assumes uniqueness, it verifies it. Scoped to `uid == caller` (in addition
        // to storagePath) so the query stays within firestore.rules' provable "my own docs"
        // shape (two equality filters need no composite index, same pattern used everywhere
        // else in this app) rather than an unscoped, rules-unprovable lookup.
        const dupSnap = await getDocs(query(
          collection(db, "photos"),
          where("uid", "==", user.uid),
          where("storagePath", "==", post.storagePath)
        ));
        const sharedByOthers = dupSnap.docs.some((d) => d.id !== post.id);
        if (!sharedByOthers) {
          try {
            await deleteObject(ref(storage, post.storagePath));
          } catch (storageErr) {
            if (storageErr.code !== "storage/object-not-found") throw storageErr;
            // Already gone — a retry after an earlier partial failure. Treat as cleaned.
          }
        }
      } catch (storageErr) {
        console.error("[gallery] storage cleanup failed:", storageErr.code || storageErr);
        deleteConfirmError.textContent = i18nT("memories.permanent_delete_storage_error");
        deleteConfirmError.classList.remove("hidden");
        deleteConfirmSubmit.textContent = i18nT("memories.permanently_delete");
        return; // stop here — never delete the Firestore doc while its file might still exist
      }
    }
    await deleteDoc(doc(db, "photos", post.id));
    cachedTrashedPosts = cachedTrashedPosts.filter((p) => p.id !== post.id);
    renderTrash();
    pendingDeletePost = null;
    deleteConfirmModalCtl.close();
    showToast(i18nT("memories.permanent_delete_success"));
  } catch (err) {
    console.error("[gallery] permanent delete failed:", err.code || err);
    deleteConfirmError.textContent = i18nT("memories.permanent_delete_error");
    deleteConfirmError.classList.remove("hidden");
    deleteConfirmSubmit.textContent = i18nT("memories.permanently_delete");
  } finally {
    deleteConfirmSubmit.disabled = false;
    deleteConfirmCancel.disabled = false;
    inFlightMemoryOps.delete(post.id);
  }
}

// ---- Bulk move (Memories multi-select) ----

function updateBulkMoveBar() {
  bulkMoveCount.textContent = `${selectedIds.size} selected`;
  bulkMoveBar.classList.toggle("hidden", selectedIds.size === 0);
}

selectModeBtn.addEventListener("click", async () => {
  selectMode = !selectMode;
  selectModeBtn.classList.toggle("bg-neonPurple/15", selectMode);
  selectModeBtn.classList.toggle("text-neonPurple", selectMode);
  if (selectMode) {
    await populateCollectionSelect(bulkMoveCollection);
  } else {
    selectedIds.clear();
    updateBulkMoveBar();
  }
  renderFeed();
});

bulkMoveCancel.addEventListener("click", () => {
  selectedIds.clear();
  updateBulkMoveBar();
  renderFeed();
});

bulkMoveBtn.addEventListener("click", async () => {
  if (!selectedIds.size) return;
  const collectionId = bulkMoveCollection.value || null;
  bulkMoveBtn.disabled = true;
  try {
    await Promise.all([...selectedIds].map((id) =>
      updateDoc(doc(db, "photos", id), { collectionId, updatedAt: serverTimestamp() })
    ));
    selectedIds.clear();
    updateBulkMoveBar();
    await fetchVisiblePosts();
  } catch (err) {
    console.error("[gallery] bulk move failed:", err.code || err);
  } finally {
    bulkMoveBtn.disabled = false;
  }
});

// ---- Likes ----

async function toggleLike(post) {
  const user = auth.currentUser;
  if (!user) return;
  const likeRef = doc(db, "photos", post.id, "likes", user.uid);
  try {
    if (post.likedByMe) {
      await deleteDoc(likeRef);
      post.likedByMe = false;
      post.likeCount = Math.max(0, (post.likeCount || 1) - 1);
    } else {
      await setDoc(likeRef, { uid: user.uid, likedAt: serverTimestamp() });
      post.likedByMe = true;
      post.likeCount = (post.likeCount || 0) + 1;
    }
    renderFeed();
  } catch (err) {
    console.error("[gallery] like toggle failed:", err.code || err);
  }
}

// ---- Favorites ----

async function toggleFeatured(post) {
  const user = auth.currentUser;
  if (!user || !isMyPost(post, user)) return;
  const next = !post.featured;
  try {
    await updateDoc(doc(db, "photos", post.id), { featured: next });
    post.featured = next;
    renderFeed();
  } catch (err) {
    console.error("[gallery] featured toggle failed:", err.code || err);
  }
}

// ---- Comments ----

function toggleComments(post) {
  if (expandedComments.has(post.id)) {
    expandedComments.delete(post.id);
  } else {
    expandedComments.add(post.id);
  }
  renderFeed();
}

async function renderCommentsPanel(post, card) {
  const panel = card.querySelector(".comments-panel");
  panel.innerHTML = `<p class="text-xs font-code text-textGray">${i18nT("common.loading_comments")}</p>`;

  let comments = commentsCache.get(post.id);
  if (!comments) {
    try {
      const snap = await getDocs(query(collection(db, "photos", post.id, "comments"), orderBy("createdAt", "asc")));
      comments = snap.docs.map((d) => d.data());
      commentsCache.set(post.id, comments);
    } catch (err) {
      console.error("[gallery] comments fetch failed:", err.code || err);
      comments = [];
    }
  }

  const list = comments.length
    ? comments.map((c) => `
        <div class="text-xs">
          <span class="font-semibold text-white">${esc(c.email)}</span>
          <span class="text-textGray ml-1.5">${esc(c.text)}</span>
        </div>`).join("")
    : `<p class="text-xs font-code text-textGray">${i18nT("common.no_comments_yet")}</p>`;

  const user = auth.currentUser;
  panel.innerHTML = `
    <div class="space-y-1.5">${list}</div>
    ${user ? `
      <form class="comment-form flex items-center gap-2 mt-2.5">
        <input type="text" placeholder="Add a comment..." class="comment-input flex-1 bg-darkBg/60 border border-borderNeon rounded-lg px-3 py-1.5 text-xs text-white placeholder:text-textGray/60">
        <button type="submit" class="px-3 py-1.5 bg-neonPurple/15 text-neonPurple rounded-lg text-xs font-code hover:bg-neonPurple/25 transition-colors">${i18nT("common.post")}</button>
      </form>` : ""}`;

  const form = panel.querySelector(".comment-form");
  if (form) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const input = form.querySelector(".comment-input");
      const text = input.value.trim();
      if (!text) return;
      try {
        await addDoc(collection(db, "photos", post.id, "comments"), {
          uid: user.uid,
          email: user.email,
          text,
          createdAt: serverTimestamp(),
        });
        commentsCache.delete(post.id);
        post.commentCount = (post.commentCount || 0) + 1;
        renderFeed();
      } catch (err) {
        console.error("[gallery] comment post failed:", err.code || err);
      }
    });
  }
}

// ---- Per-post view analytics (visible only to that post's own creator) ----

function toggleAnalytics(post) {
  if (expandedAnalytics.has(post.id)) {
    expandedAnalytics.delete(post.id);
  } else {
    expandedAnalytics.add(post.id);
  }
  renderFeed();
}

async function renderAnalyticsPanel(post, card) {
  const panel = card.querySelector(".analytics-panel");
  panel.innerHTML = `<p class="text-xs font-code text-textGray">${i18nT("common.loading")}</p>`;
  try {
    const snap = await getDocs(collection(db, "photos", post.id, "views"));
    const views = snap.docs.map((d) => d.data());
    const uniqueVisitors = new Set(views.map((v) => v.viewerUid)).size;
    const recent = [...views]
      .sort((a, b) => (b.viewedAt?.toMillis?.() || 0) - (a.viewedAt?.toMillis?.() || 0))
      .slice(0, 5);
    panel.innerHTML = `
      <div class="bg-darkBg/40 border border-borderNeon/60 rounded-xl p-3 text-xs font-code space-y-1.5">
        <div class="flex items-center justify-between"><span class="text-textGray">${i18nT("common.total_views")}</span><span class="text-white font-semibold">${views.length}</span></div>
        <div class="flex items-center justify-between"><span class="text-textGray">${i18nT("common.unique_visitors")}</span><span class="text-white font-semibold">${uniqueVisitors}</span></div>
        ${recent.length ? `
          <div class="pt-1.5 border-t border-borderNeon/40">
            <p class="text-textGray mb-1">Recent Visitors</p>
            ${recent.map((v) => `<p class="text-white">${esc(v.viewerEmail)}</p>`).join("")}
          </div>` : ""}
      </div>`;
  } catch (err) {
    console.error("[gallery] analytics fetch failed:", err.code || err);
    panel.innerHTML = `<p class="text-xs font-code text-textGray">Couldn't load analytics.</p>`;
  }
}

// Re-render from the already-fetched cachedPosts whenever the language switcher fires — album
// labels, Public/Private badges, and the "Edit metadata" title all read through i18nT().
document.addEventListener("eden:langchange", () => {
  renderFeed();
  if (trashMode) renderTrash();
  // Re-run so an open Post/Edit modal's location status chip and any visible "Remove
  // location"/"Use exact location" copy re-translate immediately too, not just on next open.
  syncPostLocation();
  syncPostEditLocation();
});
