import { auth, googleProvider, db, storage, canParticipate } from "./firebase-init.js";
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
  deleteDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import {
  ref,
  uploadBytes,
  getDownloadURL,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-storage.js";

const CATEGORY_META = {
  personal: { label: "Personal", text: "text-neonPurple", bg: "bg-neonPurple/10", border: "border-neonPurple/30" },
  event: { label: "Event", text: "text-amber-400", bg: "bg-amber-400/10", border: "border-amber-400/30" },
  work: { label: "Work", text: "text-neonBlue", bg: "bg-neonBlue/10", border: "border-neonBlue/30" },
  project: { label: "Project", text: "text-emerald-400", bg: "bg-emerald-400/10", border: "border-emerald-400/30" },
};

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

let cachedPosts = [];
let activeFilter = "all";
const viewedThisSession = new Set();
const expandedComments = new Set();
const expandedAnalytics = new Set();
const commentsCache = new Map();

function formatTimestamp(ts) {
  if (!ts?.toDate) return "";
  return ts.toDate().toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

// Recognizes ownership on both current (`uid`) and legacy pre-v2.0 (`uploadedBy`) posts.
function isMyPost(post, user) {
  return !!user && (post.uid === user.uid || post.uploadedBy === user.uid);
}

function postCard(post) {
  const meta = CATEGORY_META[post.category] || CATEGORY_META.personal;
  const isPrivate = post.visibility === "private";
  const user = auth.currentUser;
  const isMine = isMyPost(post, user);
  const commentsOpen = expandedComments.has(post.id);
  const analyticsOpen = expandedAnalytics.has(post.id);

  const card = document.createElement("article");
  card.className = "is-visible bg-cardBg/90 backdrop-blur-sm rounded-2xl neon-border-purple overflow-hidden";
  card.innerHTML = `
    <img src="${post.url}" alt="${post.caption || "Gallery post"}" class="w-full max-h-[520px] object-cover">
    <div class="p-4 space-y-3">
      ${post.caption ? `<p class="text-sm text-white">${post.caption}</p>` : ""}
      <div class="flex flex-wrap items-center gap-2 text-[10px] font-code">
        <span class="px-2 py-0.5 rounded-full border ${meta.border} ${meta.bg} ${meta.text}">${meta.label}</span>
        <span class="px-2 py-0.5 rounded-full border ${isPrivate ? "border-rose-400/30 bg-rose-400/10 text-rose-400" : "border-emerald-400/30 bg-emerald-400/10 text-emerald-400"}">
          <i class="fa-solid ${isPrivate ? "fa-lock" : "fa-globe"} mr-1"></i>${isPrivate ? "Private" : "Public"}
        </span>
        ${isMine ? `<span class="px-2 py-0.5 rounded-full border border-borderNeon bg-darkBg/60 text-textGray">me</span>` : ""}
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
          <button class="analytics-toggle-btn ml-auto flex items-center gap-1.5 text-xs font-code text-textGray hover:text-neonBlue transition-colors">
            <i class="fa-solid fa-eye"></i> Analytics
          </button>` : ""}
      </div>
      <div class="comments-panel ${commentsOpen ? "" : "hidden"}"></div>
      <div class="analytics-panel ${analyticsOpen ? "" : "hidden"}"></div>
    </div>`;

  card.querySelector(".like-btn").addEventListener("click", () => toggleLike(post));
  card.querySelector(".comment-toggle-btn").addEventListener("click", () => toggleComments(post));
  const analyticsBtn = card.querySelector(".analytics-toggle-btn");
  if (analyticsBtn) analyticsBtn.addEventListener("click", () => toggleAnalytics(post));

  if (commentsOpen) renderCommentsPanel(post, card);
  if (analyticsOpen) renderAnalyticsPanel(post, card);

  return card;
}

function renderFeed() {
  const visible = activeFilter === "all"
    ? cachedPosts
    : activeFilter === "public" || activeFilter === "private"
      ? cachedPosts.filter((p) => p.visibility === activeFilter)
      : cachedPosts.filter((p) => p.category === activeFilter);

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

function renderSignedIn(user) {
  authControl.innerHTML = `
    <span class="text-xs text-textGray font-code">Signed in as <span class="text-white">${user.displayName || user.email}</span></span>
    <button id="auth-signout-btn" class="px-4 py-2 bg-cardBg/70 border border-borderNeon rounded-xl text-xs font-cyber font-bold tracking-wider text-white hover:border-neonPurple transition-all">
      SIGN OUT
    </button>`;
  document.getElementById("auth-signout-btn").addEventListener("click", () => signOut(auth));

  const mayParticipate = canParticipate();
  newPostBtn.classList.toggle("hidden", !mayParticipate);
  privateTab.classList.toggle("hidden", !mayParticipate);
  accessNote.classList.toggle("hidden", mayParticipate);
  if (!mayParticipate && activeFilter === "private") setActiveTab("all");
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

postForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const user = auth.currentUser;
  if (!user || !canParticipate()) return;

  const file = document.getElementById("post-file").files[0];
  const caption = document.getElementById("post-caption").value.trim();
  const category = document.getElementById("post-category").value;
  const visibility = postForm.querySelector('input[name="post-visibility"]:checked').value;
  if (!file) return;

  postStatus.textContent = "Uploading...";
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
      caption: caption || file.name,
      uploadedAt: serverTimestamp(),
      uid: user.uid,
    });

    postStatus.textContent = "Posted.";
    await fetchVisiblePosts();
    closeModal();
  } catch (err) {
    console.error("Upload failed", err);
    postStatus.textContent = "Upload failed — check console.";
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
  panel.innerHTML = `<p class="text-xs font-code text-textGray">Loading comments...</p>`;

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
    : `<p class="text-xs font-code text-textGray">No comments yet.</p>`;

  const user = auth.currentUser;
  panel.innerHTML = `
    <div class="space-y-1.5">${list}</div>
    ${user ? `
      <form class="comment-form flex items-center gap-2 mt-2.5">
        <input type="text" placeholder="Add a comment..." class="comment-input flex-1 bg-darkBg/60 border border-borderNeon rounded-lg px-3 py-1.5 text-xs text-white placeholder:text-textGray/60">
        <button type="submit" class="px-3 py-1.5 bg-neonPurple/15 text-neonPurple rounded-lg text-xs font-code hover:bg-neonPurple/25 transition-colors">Post</button>
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
  panel.innerHTML = `<p class="text-xs font-code text-textGray">Loading analytics...</p>`;
  try {
    const snap = await getDocs(collection(db, "photos", post.id, "views"));
    const views = snap.docs.map((d) => d.data());
    const uniqueVisitors = new Set(views.map((v) => v.viewerUid)).size;
    const recent = [...views]
      .sort((a, b) => (b.viewedAt?.toMillis?.() || 0) - (a.viewedAt?.toMillis?.() || 0))
      .slice(0, 5);
    panel.innerHTML = `
      <div class="bg-darkBg/40 border border-borderNeon/60 rounded-xl p-3 text-xs font-code space-y-1.5">
        <div class="flex items-center justify-between"><span class="text-textGray">Total Views</span><span class="text-white font-semibold">${views.length}</span></div>
        <div class="flex items-center justify-between"><span class="text-textGray">Unique Visitors</span><span class="text-white font-semibold">${uniqueVisitors}</span></div>
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
