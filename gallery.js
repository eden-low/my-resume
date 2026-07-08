import { auth, googleProvider, db, storage, canParticipate } from "./firebase-init.js";
import { t as i18nT, getLang } from "./js/i18n.js";
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
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-storage.js";

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

// Wraps the callback-based Geolocation API in a promise that never rejects — a denial/timeout
// just resolves null, same pattern index.html's weather widget already uses.
function getBrowserLocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      () => resolve(null),
      { timeout: 8000, maximumAge: 0 }
    );
  });
}

function wireUseLocationBtn(btn, nameInput, latInput, lonInput) {
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = i18nT("common.locating");
    const loc = await getBrowserLocation();
    btn.disabled = false;
    btn.textContent = original;
    if (!loc) return;
    latInput.value = loc.lat;
    lonInput.value = loc.lon;
    if (!nameInput.value.trim()) nameInput.value = `${loc.lat.toFixed(3)}, ${loc.lon.toFixed(3)}`;
  });
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
const filterTabs = document.querySelectorAll(".filter-tab");
const privateTab = document.querySelector('.filter-tab[data-filter="private"]');
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

let cachedPosts = [];
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

function postCard(post) {
  const meta = CATEGORY_META[albumOf(post)] || CATEGORY_META.dailylife;
  const isPrivate = post.visibility === "private";
  const user = auth.currentUser;
  const isMine = isMyPost(post, user);
  const commentsOpen = expandedComments.has(post.id);
  const analyticsOpen = expandedAnalytics.has(post.id);

  const card = document.createElement("article");
  card.className = "is-visible relative bg-cardBg/90 backdrop-blur-sm rounded-2xl neon-border-purple overflow-hidden";
  card.innerHTML = `
    ${isMine && selectMode ? `
      <label class="absolute top-3 left-3 z-10 w-6 h-6 rounded-md bg-darkBg/80 border border-borderNeon flex items-center justify-center cursor-pointer">
        <input type="checkbox" class="select-checkbox w-4 h-4" ${selectedIds.has(post.id) ? "checked" : ""}>
      </label>` : ""}
    <img src="${post.url}" alt="${post.caption || "Gallery post"}" class="w-full max-h-[520px] object-cover">
    <div class="p-4 space-y-3">
      ${post.caption ? `<p class="text-sm text-white">${post.caption}</p>` : ""}
      <div class="flex flex-wrap items-center gap-2 text-[10px] font-code">
        <span class="px-2 py-0.5 rounded-full border ${meta.border} ${meta.bg} ${meta.text}">${i18nT(meta.i18nKey)}</span>
        <span class="px-2 py-0.5 rounded-full border ${isPrivate ? "border-rose-400/30 bg-rose-400/10 text-rose-400" : "border-emerald-400/30 bg-emerald-400/10 text-emerald-400"}">
          <i class="fa-solid ${isPrivate ? "fa-lock" : "fa-globe"} mr-1"></i>${isPrivate ? i18nT("common.private") : i18nT("common.public")}
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
    : activeFilter === "public" || activeFilter === "private"
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
    try {
      const mineSnap = await getDocs(query(collection(db, "photos"), where("uid", "==", user.uid)));
      mineSnap.forEach((d) => posts.set(d.id, { id: d.id, ...d.data() }));
    } catch (err) {
      console.error("[gallery] own posts query failed:", err.code || err);
    }
    // Legacy posts from before the uploadedBy -> uid rename (no data migration was run —
    // firestore.rules accepts either field, so this keeps them visible client-side too).
    try {
      const legacySnap = await getDocs(query(collection(db, "photos"), where("uploadedBy", "==", user.uid)));
      legacySnap.forEach((d) => posts.set(d.id, { id: d.id, ...d.data() }));
    } catch (err) {
      console.error("[gallery] legacy own posts query failed:", err.code || err);
    }
  }

  const list = [...posts.values()];
  list.sort((a, b) => (b.uploadedAt?.toMillis?.() || 0) - (a.uploadedAt?.toMillis?.() || 0));

  await Promise.all(list.map((post) => attachSocialCounts(post)));

  cachedPosts = list;
  renderFeed();
  recordViews(list);
  checkLikeNotifications(list);
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
  newPostBtn.classList.add("hidden");
  if (activeFilter === "private") setActiveTab("all");
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
  selectModeBtn.classList.toggle("hidden", !mayParticipate);
  privateTab.classList.toggle("hidden", !mayParticipate);
  accessNote.classList.toggle("hidden", mayParticipate);
  if (!mayParticipate && activeFilter === "private") setActiveTab("all");
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

onAuthStateChanged(auth, (user) => {
  if (user) {
    renderSignedIn(user);
  } else {
    renderSignedOut();
  }
  fetchVisiblePosts();
});

function openModal() {
  postModal.classList.remove("hidden");
}
function closeModal() {
  postModal.classList.add("hidden");
  postForm.reset();
  postStatus.textContent = "";
}

newPostBtn.addEventListener("click", openModal);
postModalClose.addEventListener("click", closeModal);
postModalBackdrop.addEventListener("click", closeModal);

function parseTags(raw) {
  return raw.split(",").map((t) => t.trim()).filter(Boolean);
}

wireUseLocationBtn(
  document.getElementById("post-use-location-btn"),
  document.getElementById("post-location-name"),
  document.getElementById("post-latitude"),
  document.getElementById("post-longitude")
);
wireUseLocationBtn(
  document.getElementById("post-edit-use-location-btn"),
  document.getElementById("post-edit-location-name"),
  document.getElementById("post-edit-latitude"),
  document.getElementById("post-edit-longitude")
);

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
  const locationName = document.getElementById("post-location-name").value.trim() || null;
  const latRaw = document.getElementById("post-latitude").value;
  const lonRaw = document.getElementById("post-longitude").value;
  if (!file) return;

  postStatus.textContent = i18nT("common.uploading");
  try {
    const storagePath = `gallery/${user.uid}/${visibility}/${category}/${Date.now()}-${file.name}`;
    const fileRef = ref(storage, storagePath);
    await uploadBytes(fileRef, file);
    const url = await getDownloadURL(fileRef);

    await addDoc(collection(db, "photos"), {
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
      locationName,
      latitude: latRaw ? Number(latRaw) : null,
      longitude: lonRaw ? Number(lonRaw) : null,
    });

    postStatus.textContent = i18nT("common.saved");
    await fetchVisiblePosts();
    closeModal();
  } catch (err) {
    console.error("Upload failed", err);
    postStatus.textContent = i18nT("common.upload_failed");
  }
});

// ---- Edit metadata ----

async function openEditModal(post) {
  document.getElementById("post-edit-id").value = post.id;
  document.getElementById("post-edit-caption").value = post.caption || "";
  document.getElementById("post-edit-category").value = albumOf(post);
  document.querySelector(`#post-edit-form input[name="post-edit-visibility"][value="${post.visibility || "public"}"]`).checked = true;
  document.getElementById("post-edit-tags").value = (post.tags || []).join(", ");
  document.getElementById("post-edit-location-name").value = post.locationName || "";
  document.getElementById("post-edit-latitude").value = post.latitude ?? "";
  document.getElementById("post-edit-longitude").value = post.longitude ?? "";
  await populateCollectionSelect(document.getElementById("post-edit-collection"), post.collectionId);
  postEditStatus.textContent = "";
  postEditModal.classList.remove("hidden");
}
function closeEditModal() {
  postEditModal.classList.add("hidden");
  postEditForm.reset();
  postEditStatus.textContent = "";
}
postEditModalClose.addEventListener("click", closeEditModal);
postEditModalBackdrop.addEventListener("click", closeEditModal);

postEditForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const user = auth.currentUser;
  if (!user) return;
  const id = document.getElementById("post-edit-id").value;
  const post = cachedPosts.find((p) => p.id === id);
  if (!post || !isMyPost(post, user)) return;

  const latRaw = document.getElementById("post-edit-latitude").value;
  const lonRaw = document.getElementById("post-edit-longitude").value;
  const payload = {
    caption: document.getElementById("post-edit-caption").value.trim(),
    category: document.getElementById("post-edit-category").value,
    visibility: document.querySelector('#post-edit-form input[name="post-edit-visibility"]:checked').value,
    collectionId: document.getElementById("post-edit-collection").value || null,
    tags: parseTags(document.getElementById("post-edit-tags").value),
    locationName: document.getElementById("post-edit-location-name").value.trim() || null,
    latitude: latRaw ? Number(latRaw) : null,
    longitude: lonRaw ? Number(lonRaw) : null,
    updatedAt: serverTimestamp(),
  };
  try {
    await updateDoc(doc(db, "photos", id), payload);
    postEditStatus.textContent = i18nT("common.saved");
    await fetchVisiblePosts();
    closeEditModal();
  } catch (err) {
    console.error("[gallery] edit save failed:", err.code || err);
    postEditStatus.textContent = i18nT("common.couldnt_save");
  }
});

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
          <span class="font-semibold text-white">${c.email}</span>
          <span class="text-textGray ml-1.5">${c.text}</span>
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
            ${recent.map((v) => `<p class="text-white">${v.viewerEmail}</p>`).join("")}
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
});
