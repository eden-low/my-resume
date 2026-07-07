import { auth, db, getUserMode } from "./firebase-init.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import {
  collection,
  query,
  where,
  orderBy,
  getDocs,
  doc,
  getDoc,
  setDoc,
  deleteDoc,
  addDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

// Albums, mirroring gallery.js's taxonomy (kept in sync manually — see CLAUDE.md's
// per-page duplication convention, no shared module for this small a helper).
const CATEGORY_META = {
  travel: { label: "Travel", icon: "fa-plane" },
  projects: { label: "Projects", icon: "fa-code" },
  events: { label: "Events", icon: "fa-champagne-glasses" },
  dailylife: { label: "Daily Life", icon: "fa-sun" },
};
const LEGACY_CATEGORY_ALIAS = { personal: "dailylife", event: "events", work: "projects", project: "projects" };
function albumOf(post) {
  return LEGACY_CATEGORY_ALIAS[post.category] || post.category;
}

const targetUid = new URLSearchParams(location.search).get("uid");

const headerEl = document.getElementById("profile-header");
const privateNotice = document.getElementById("private-notice");
const contentSection = document.getElementById("profile-content");
const statsEl = document.getElementById("profile-stats");
const recentActivitySection = document.getElementById("recent-activity-section");
const recentActivityList = document.getElementById("recent-activity-list");
const albumTilesEl = document.getElementById("album-tiles");
const albumResetBtn = document.getElementById("album-reset-btn");
const gridEl = document.getElementById("photo-grid");
const gridEmpty = document.getElementById("photo-grid-empty");
const timelineSection = document.getElementById("timeline-list-section");
const timelineListEl = document.getElementById("timeline-list");
const journalSection = document.getElementById("journal-list-section");
const journalListEl = document.getElementById("journal-list");

let allPublicPhotos = [];
let activeAlbum = null; // null = all, "featured" = favorites, or an album key

const photoModal = document.getElementById("photo-modal");
const photoModalBackdrop = document.getElementById("photo-modal-backdrop");
const photoModalClose = document.getElementById("photo-modal-close");
const photoModalImg = document.getElementById("photo-modal-img");
const photoModalCaption = document.getElementById("photo-modal-caption");
const photoModalLikeBtn = document.getElementById("photo-modal-like-btn");
const photoModalLikeCount = document.getElementById("photo-modal-like-count");
const photoModalComments = document.getElementById("photo-modal-comments");

function formatJoined(ts) {
  if (!ts?.toDate) return null;
  return ts.toDate().toLocaleDateString(undefined, { year: "numeric", month: "long" });
}

function renderHeader(person) {
  const joined = formatJoined(person.createdAt);
  headerEl.innerHTML = `
    <div class="flex items-center gap-4">
      <div class="w-16 h-16 rounded-full bg-neonPurple/10 flex items-center justify-center text-neonPurple overflow-hidden flex-shrink-0">
        ${person.photoURL ? `<img src="${person.photoURL}" class="w-full h-full object-cover">` : `<i class="fa-solid fa-user text-2xl"></i>`}
      </div>
      <div class="min-w-0">
        <h1 class="font-cyber font-black text-2xl text-white truncate">${person.displayName || person.email}</h1>
        <p class="text-textGray font-code text-sm mt-0.5">${person.username ? "@" + person.username : person.email}</p>
      </div>
    </div>
    ${person.bio ? `<p class="mt-4 text-sm text-white">${person.bio}</p>` : ""}
    <div class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-textGray font-code">
      ${person.location ? `<span><i class="fa-solid fa-location-dot mr-1"></i>${person.location}</span>` : ""}
      ${joined ? `<span><i class="fa-solid fa-calendar mr-1"></i>Joined ${joined}</span>` : ""}
    </div>`;
}

async function fetchPublicFor(collectionName, uid) {
  try {
    const snap = await getDocs(query(collection(db, collectionName), where("uid", "==", uid), where("visibility", "==", "public")));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.error(`[profile] public ${collectionName} for ${uid} failed:`, err.code || err);
    return [];
  }
}

// Average, across the person's public habits, of check-ins so far / days since each habit
// was created — clamped 0-100. 0 (not "—") when they have no public habits, so it reads as
// a real stat rather than missing data.
function habitCompletionPct(habits) {
  if (!habits.length) return 0;
  const rates = habits.map((h) => {
    const created = h.createdAt?.toDate?.();
    const daysSince = created ? Math.max(1, Math.ceil((Date.now() - created.getTime()) / 86400000)) : 1;
    return Math.min(1, (h.completedDates || []).length / daysSince);
  });
  return Math.round((rates.reduce((sum, r) => sum + r, 0) / rates.length) * 100);
}

function renderStats({ photos, journals, events, habits }) {
  statsEl.innerHTML = `
    <div><p class="text-textGray text-xs">Photos</p><p class="font-code font-semibold text-lg mt-1">${photos.length}</p></div>
    <div><p class="text-textGray text-xs">Journal entries</p><p class="font-code font-semibold text-lg mt-1">${journals.length}</p></div>
    <div><p class="text-textGray text-xs">Journey events</p><p class="font-code font-semibold text-lg mt-1">${events.length}</p></div>
    <div><p class="text-textGray text-xs">Habit completion</p><p class="font-code font-semibold text-lg mt-1">${habitCompletionPct(habits)}%</p></div>`;
}

// ---- Albums ----

function albumCounts(photos) {
  const counts = { travel: 0, projects: 0, events: 0, dailylife: 0, featured: 0 };
  photos.forEach((p) => {
    const album = albumOf(p);
    if (counts[album] !== undefined) counts[album]++;
    if (p.featured) counts.featured++;
  });
  return counts;
}

function renderAlbumTiles(photos) {
  const counts = albumCounts(photos);
  const tiles = [
    ...Object.entries(CATEGORY_META).map(([key, meta]) => ({ key, ...meta, count: counts[key] })),
    { key: "featured", label: "Favorites", icon: "fa-star", count: counts.featured },
  ];
  albumTilesEl.replaceChildren(
    ...tiles.map((t) => {
      const el = document.createElement("button");
      el.type = "button";
      const active = activeAlbum === t.key;
      el.className = `flex flex-col items-center justify-center gap-1.5 rounded-xl p-3 border transition-colors ${active ? "border-neonPurple bg-neonPurple/10 text-neonPurple" : "border-borderNeon bg-darkBg/40 text-textGray hover:text-white"}`;
      el.innerHTML = `<i class="fa-solid ${t.icon}"></i><span class="text-[10px] font-code text-center leading-tight">${t.label}</span><span class="text-[10px] font-code">${t.count}</span>`;
      el.addEventListener("click", () => {
        activeAlbum = active ? null : t.key;
        renderAlbumTiles(allPublicPhotos);
        renderPhotoGrid();
      });
      return el;
    })
  );
  albumResetBtn.classList.toggle("hidden", !activeAlbum);
}

albumResetBtn.addEventListener("click", () => {
  activeAlbum = null;
  renderAlbumTiles(allPublicPhotos);
  renderPhotoGrid();
});

function renderPhotoGrid() {
  const visible = !activeAlbum
    ? allPublicPhotos
    : activeAlbum === "featured"
      ? allPublicPhotos.filter((p) => p.featured)
      : allPublicPhotos.filter((p) => albumOf(p) === activeAlbum);

  gridEmpty.classList.toggle("hidden", visible.length > 0);
  gridEl.replaceChildren(
    ...visible.map((post) => {
      const el = document.createElement("button");
      el.className = "aspect-square overflow-hidden bg-darkBg/40 relative";
      el.innerHTML = `
        <img src="${post.url}" alt="${post.caption || "Photo"}" class="w-full h-full object-cover hover:opacity-80 transition-opacity">
        ${post.featured ? '<i class="fa-solid fa-star absolute top-1.5 right-1.5 text-amber-400 text-xs drop-shadow"></i>' : ""}`;
      el.addEventListener("click", () => openPhotoModal(post));
      return el;
    })
  );
}

// ---- Public Timeline / Journal lists ----

function renderTimelineList(events) {
  timelineSection.classList.toggle("hidden", events.length === 0);
  const sorted = [...events].sort((a, b) => (b.date?.toMillis?.() || 0) - (a.date?.toMillis?.() || 0));
  timelineListEl.replaceChildren(
    ...sorted.map((e) => {
      const el = document.createElement("div");
      el.className = "flex items-center justify-between gap-3 py-1.5 border-b border-borderNeon/30 last:border-0";
      const date = e.date?.toDate?.() ? e.date.toDate().toLocaleDateString(undefined, { dateStyle: "medium" }) : "";
      el.innerHTML = `<span class="text-sm text-white truncate">${e.title || "Untitled"}</span><span class="text-[11px] font-code text-textGray flex-shrink-0">${date}</span>`;
      return el;
    })
  );
}

function renderJournalList(journals) {
  journalSection.classList.toggle("hidden", journals.length === 0);
  const sorted = [...journals].sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
  journalListEl.replaceChildren(
    ...sorted.map((j) => {
      const el = document.createElement("div");
      el.className = "py-1.5 border-b border-borderNeon/30 last:border-0";
      const snippet = (j.content || "").replace(/[#*_`>-]/g, "").slice(0, 90);
      el.innerHTML = `<p class="text-sm text-white">${j.title || "Untitled"}</p><p class="text-xs text-textGray mt-0.5 truncate">${snippet}</p>`;
      return el;
    })
  );
}

// ---- Achievements (public subset only) ----
//
// Mirrors dashboard.js's tiered badges, but only for metrics derivable from PUBLIC data —
// the expenses-based badge is deliberately never computed here, since expenses are always
// private and unreadable for any uid other than the signed-in user's own.
const PUBLIC_ACHIEVEMENTS = [
  { key: "photos", label: "Photos", icon: "fa-image", tiers: [10, 50, 100, 500] },
  { key: "journals", label: "Journal Entries", icon: "fa-book", tiers: [10, 50, 100, 365] },
  { key: "streak", label: "Longest Streak", icon: "fa-fire", tiers: [7, 30, 100, 365] },
];

function computeStreak(completedDates) {
  const set = new Set(completedDates || []);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const cursor = new Date(today);
  const toKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  if (!set.has(toKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (set.has(toKey(cursor))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

function achievementTile(def, count) {
  const unlockedTier = [...def.tiers].reverse().find((t) => count >= t) || null;
  const nextTier = def.tiers.find((t) => count < t);
  const pct = nextTier ? Math.round((count / nextTier) * 100) : 100;
  const el = document.createElement("div");
  el.className = `rounded-xl p-3 border text-center ${unlockedTier ? "border-neonPurple/40 bg-neonPurple/5" : "border-borderNeon bg-darkBg/40"}`;
  el.innerHTML = `
    <div class="w-8 h-8 mx-auto rounded-lg ${unlockedTier ? "bg-neonPurple/15 text-neonPurple" : "bg-darkBg/60 text-textGray"} flex items-center justify-center mb-2"><i class="fa-solid ${def.icon}"></i></div>
    <p class="text-xs font-semibold text-white">${def.label}</p>
    <p class="text-[10px] font-code text-textGray mt-0.5">${unlockedTier ? `${unlockedTier}+` : `${count}/${nextTier ?? def.tiers[0]}`}</p>`;
  return el;
}

function renderAchievements({ photos, journals, habits }) {
  const section = document.getElementById("achievements-section");
  const bestStreak = habits.length ? Math.max(...habits.map((h) => computeStreak(h.completedDates))) : 0;
  const counts = { photos: photos.length, journals: journals.length, streak: bestStreak };
  const anyUnlocked = PUBLIC_ACHIEVEMENTS.some((def) => counts[def.key] >= def.tiers[0]);
  section.classList.toggle("hidden", !anyUnlocked);
  if (!anyUnlocked) return;
  document.getElementById("achievements-list").replaceChildren(...PUBLIC_ACHIEVEMENTS.map((def) => achievementTile(def, counts[def.key])));
}

// ---- Recent Activity ----

function renderRecentActivity({ photos, journals, events }) {
  const items = [
    ...photos.map((p) => ({ icon: "fa-image", text: `Uploaded ${p.caption || "a photo"}`, at: p.uploadedAt })),
    ...journals.map((j) => ({ icon: "fa-book", text: `Wrote "${j.title || "Untitled"}"`, at: j.createdAt })),
    ...events.map((e) => ({ icon: "fa-timeline", text: `Logged "${e.title || "Untitled"}"`, at: e.date })),
  ]
    .filter((i) => i.at?.toMillis)
    .sort((a, b) => b.at.toMillis() - a.at.toMillis())
    .slice(0, 8);

  recentActivitySection.classList.toggle("hidden", items.length === 0);
  recentActivityList.replaceChildren(
    ...items.map((i) => {
      const el = document.createElement("div");
      el.className = "flex items-center gap-3";
      el.innerHTML = `
        <span class="w-7 h-7 rounded-lg bg-neonPurple/10 text-neonPurple flex items-center justify-center text-xs flex-shrink-0"><i class="fa-solid ${i.icon}"></i></span>
        <span class="text-sm text-white truncate">${i.text}</span>`;
      return el;
    })
  );
}

// ---- Photo modal: like/comment, read-only otherwise (mirrors gallery.js's per-post panel) ----

let activePost = null;

function closePhotoModal() {
  photoModal.classList.add("hidden");
  activePost = null;
}
photoModalClose.addEventListener("click", closePhotoModal);
photoModalBackdrop.addEventListener("click", closePhotoModal);

async function openPhotoModal(post) {
  activePost = post;
  photoModal.classList.remove("hidden");
  photoModalImg.src = post.url;
  photoModalCaption.textContent = post.caption || "";
  photoModalLikeBtn.innerHTML = `<i class="fa-regular fa-heart"></i> <span id="photo-modal-like-count">&hellip;</span>`;
  photoModalComments.innerHTML = `<p class="text-xs font-code text-textGray">Loading comments&hellip;</p>`;

  const user = auth.currentUser;
  let likedByMe = false;
  let likeCount = 0;
  try {
    const likesSnap = await getDocs(collection(db, "photos", post.id, "likes"));
    likeCount = likesSnap.size;
    likedByMe = !!user && likesSnap.docs.some((d) => d.id === user.uid);
  } catch (err) {
    console.error("[profile] likes fetch failed:", err.code || err);
  }
  renderLikeButton(post, likedByMe, likeCount);

  let comments = [];
  try {
    const commentsSnap = await getDocs(query(collection(db, "photos", post.id, "comments"), orderBy("createdAt", "asc")));
    comments = commentsSnap.docs.map((d) => d.data());
  } catch (err) {
    console.error("[profile] comments fetch failed:", err.code || err);
  }
  renderComments(post, comments);
}

function renderLikeButton(post, likedByMe, likeCount) {
  photoModalLikeBtn.className = `flex items-center gap-1.5 text-xs font-code ${likedByMe ? "text-rose-400" : "text-textGray"} hover:text-rose-400 transition-colors`;
  photoModalLikeBtn.innerHTML = `<i class="fa-${likedByMe ? "solid" : "regular"} fa-heart"></i> <span>${likeCount}</span>`;
  photoModalLikeBtn.onclick = async () => {
    const user = auth.currentUser;
    if (!user || !activePost || activePost.id !== post.id) return;
    const likeRef = doc(db, "photos", post.id, "likes", user.uid);
    try {
      if (likedByMe) {
        await deleteDoc(likeRef);
        renderLikeButton(post, false, Math.max(0, likeCount - 1));
      } else {
        await setDoc(likeRef, { uid: user.uid, likedAt: serverTimestamp() });
        renderLikeButton(post, true, likeCount + 1);
      }
    } catch (err) {
      console.error("[profile] like toggle failed:", err.code || err);
    }
  };
}

function renderComments(post, comments) {
  const list = comments.length
    ? comments.map((c) => `
        <div class="text-xs">
          <span class="font-semibold text-white">${c.email}</span>
          <span class="text-textGray ml-1.5">${c.text}</span>
        </div>`).join("")
    : `<p class="text-xs font-code text-textGray">No comments yet.</p>`;

  const user = auth.currentUser;
  photoModalComments.innerHTML = `
    <div class="space-y-1.5">${list}</div>
    ${user ? `
      <form class="comment-form flex items-center gap-2 mt-2.5">
        <input type="text" placeholder="Add a comment..." class="comment-input flex-1 bg-darkBg/60 border border-borderNeon rounded-lg px-3 py-1.5 text-xs text-white placeholder:text-textGray/60">
        <button type="submit" class="px-3 py-1.5 bg-neonPurple/15 text-neonPurple rounded-lg text-xs font-code hover:bg-neonPurple/25 transition-colors">Post</button>
      </form>` : ""}`;

  const form = photoModalComments.querySelector(".comment-form");
  if (form) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const input = form.querySelector(".comment-input");
      const text = input.value.trim();
      if (!text || !activePost || activePost.id !== post.id) return;
      try {
        await addDoc(collection(db, "photos", post.id, "comments"), {
          uid: user.uid,
          email: user.email,
          text,
          createdAt: serverTimestamp(),
        });
        const commentsSnap = await getDocs(query(collection(db, "photos", post.id, "comments"), orderBy("createdAt", "asc")));
        renderComments(post, commentsSnap.docs.map((d) => d.data()));
      } catch (err) {
        console.error("[profile] comment post failed:", err.code || err);
      }
    });
  }
}

// ---- Role gate + load ----
//
// Viewer -> only the Owner's profile is visible. Friend/Owner -> the Owner's and any Friend's
// profile is visible. This is a UI-level gate against the public `role` field on users/{uid}
// (see login.html), not a firestore.rules change — the underlying public-content read rules
// intentionally stay open to any signed-in user (that's what powers the main Gallery/Journal/
// Timeline/Habits feeds showing everyone's public posts), so this only affects what Search
// People surfaces and what this page chooses to render.
function canViewProfile(targetRole) {
  const myRole = getUserMode(); // OWNER / FRIEND / VIEWER
  if (myRole === "OWNER") return true;
  if (myRole === "FRIEND") return targetRole === "owner" || targetRole === "friend";
  return targetRole === "owner";
}

async function loadProfile() {
  if (!targetUid) {
    headerEl.innerHTML = `<p class="text-sm text-textGray">No profile specified.</p>`;
    return;
  }

  let person;
  try {
    const snap = await getDoc(doc(db, "users", targetUid));
    if (!snap.exists()) {
      headerEl.innerHTML = `<p class="text-sm text-textGray">User not found.</p>`;
      return;
    }
    person = snap.data();
  } catch (err) {
    console.error("[profile] user fetch failed:", err.code || err);
    headerEl.innerHTML = `<p class="text-sm text-textGray">Couldn't load this profile.</p>`;
    return;
  }

  renderHeader(person);

  if (!canViewProfile(person.role || "viewer")) {
    privateNotice.classList.remove("hidden");
    return;
  }

  const [photos, journals, events, habits] = await Promise.all([
    fetchPublicFor("photos", targetUid),
    fetchPublicFor("journals", targetUid),
    fetchPublicFor("life_events", targetUid),
    fetchPublicFor("habits", targetUid),
  ]);
  photos.sort((a, b) => (b.uploadedAt?.toMillis?.() || 0) - (a.uploadedAt?.toMillis?.() || 0));
  allPublicPhotos = photos;
  activeAlbum = null;

  contentSection.classList.remove("hidden");
  renderStats({ photos, journals, events, habits });
  renderAchievements({ photos, journals, habits });
  renderRecentActivity({ photos, journals, events });
  renderAlbumTiles(photos);
  renderPhotoGrid();
  renderTimelineList(events);
  renderJournalList(journals);
}

onAuthStateChanged(auth, (user) => {
  if (user) loadProfile();
});
