import { auth, db, getUserMode } from "./firebase-init.js";
import { t as i18nT } from "./js/i18n.js";
import { publicDisplayName, formatHandle } from "./js/identity.js";
import { excludeDeleted } from "./js/memory-filters.js";
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
// per-page duplication convention, no shared module for this small a helper). A function, not a
// static object, so labels stay correct across a language switch (reuses the same memories.*
// keys gallery.js's locale entries define for the same taxonomy).
function categoryMeta() {
  return {
    travel: { label: i18nT("memories.album_travel"), icon: "fa-plane" },
    projects: { label: i18nT("memories.album_projects"), icon: "fa-code" },
    events: { label: i18nT("memories.album_events"), icon: "fa-champagne-glasses" },
    dailylife: { label: i18nT("memories.album_dailylife"), icon: "fa-sun" },
  };
}
const LEGACY_CATEGORY_ALIAS = { personal: "dailylife", event: "events", work: "projects", project: "projects" };
function albumOf(post) {
  return LEGACY_CATEGORY_ALIAS[post.category] || post.category;
}

// Journal moods, mirroring journal.js's MOOD_META (same per-page duplication convention as
// the album taxonomy above) — used by the read-only journal detail modal.
const MOOD_META = {
  happy: { emoji: "😊", i18nKey: "journal.mood_happy" },
  calm: { emoji: "😌", i18nKey: "journal.mood_calm" },
  excited: { emoji: "🎉", i18nKey: "journal.mood_excited" },
  sad: { emoji: "😔", i18nKey: "journal.mood_sad" },
  frustrated: { emoji: "😤", i18nKey: "journal.mood_frustrated" },
  tired: { emoji: "😴", i18nKey: "journal.mood_tired" },
};

// Full-body user content goes through the detail modal via innerHTML, so escape it — unlike
// the truncated snippets elsewhere on this page, a whole journal entry is long enough to
// plausibly contain markup-looking text.
function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmtDate(ts) {
  return ts?.toDate?.() ? ts.toDate().toLocaleDateString(undefined, { dateStyle: "medium" }) : "";
}

// v3.1: profile.html?u=username (preferred, resolved to a uid via usernames/{usernameLower}
// below) alongside the original ?uid=... form, kept for backward compatibility with every
// existing link (Search People results before this pass, bookmarks, etc.).
const urlParams = new URLSearchParams(location.search);
const targetUsername = (urlParams.get("u") || "").trim().toLowerCase();
const targetUidParam = urlParams.get("uid");

const headerEl = document.getElementById("profile-header");
const resumeCta = document.getElementById("resume-cta");
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
const careerSection = document.getElementById("career-section");
const careerListEl = document.getElementById("career-list");
const atlasSection = document.getElementById("atlas-section");
const atlasPlacesListEl = document.getElementById("atlas-places-list");

let allPublicPhotos = [];
let activeAlbum = null; // null = all, "featured" = favorites, or an album key

const photoModal = document.getElementById("photo-modal");
const photoModalBackdrop = document.getElementById("photo-modal-backdrop");
const photoModalClose = document.getElementById("photo-modal-close");
const photoModalImg = document.getElementById("photo-modal-img");
const photoModalCaption = document.getElementById("photo-modal-caption");
const photoModalTopline = document.getElementById("photo-modal-topline");
const photoModalMeta = document.getElementById("photo-modal-meta");
const photoModalLikeBtn = document.getElementById("photo-modal-like-btn");
const photoModalLikeCount = document.getElementById("photo-modal-like-count");
const photoModalComments = document.getElementById("photo-modal-comments");

const itemModal = document.getElementById("item-modal");
const itemModalBackdrop = document.getElementById("item-modal-backdrop");
const itemModalClose = document.getElementById("item-modal-close");
const itemModalBody = document.getElementById("item-modal-body");

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
        <h1 class="font-cyber font-black text-2xl text-white truncate">${publicDisplayName(person)}</h1>
        ${formatHandle(person.username) ? `<p class="text-textGray font-code text-sm mt-0.5">${formatHandle(person.username)}</p>` : ""}
      </div>
    </div>
    ${person.bio ? `<p class="mt-4 text-sm text-white">${person.bio}</p>` : ""}
    <div class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-textGray font-code">
      ${person.location ? `<span><i class="fa-solid fa-location-dot mr-1"></i>${person.location}</span>` : ""}
      ${joined ? `<span><i class="fa-solid fa-calendar mr-1"></i>${i18nT("profile.joined").replace("{date}", joined)}</span>` : ""}
    </div>`;
}

async function fetchByVisibility(collectionName, uid, visibility) {
  try {
    const snap = await getDocs(query(collection(db, collectionName), where("uid", "==", uid), where("visibility", "==", visibility)));
    // Trashed Memories never appear on anyone's profile (own or someone else's) — a no-op for
    // journals/life_events, which never carry deletedAt.
    return excludeDeleted(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  } catch (err) {
    console.error(`[profile] ${visibility} ${collectionName} for ${uid} failed:`, err.code || err);
    return [];
  }
}

// v3.2: public content is visible to anyone who can view the profile at all; connections-tier
// content only merges in when the viewer is one of this target's accepted friends (see
// isAcceptedFriendOfTarget below) — each query is scoped to `uid==target`, matching
// firestore.rules' isMineOrPublic()/isAcceptedFriend() provability requirement.
async function fetchVisibleFor(collectionName, uid, includeConnections) {
  const [pub, connections] = await Promise.all([
    fetchByVisibility(collectionName, uid, "public"),
    includeConnections ? fetchByVisibility(collectionName, uid, "connections") : Promise.resolve([]),
  ]);
  const merged = new Map();
  pub.forEach((d) => merged.set(d.id, d));
  connections.forEach((d) => merged.set(d.id, d));
  return [...merged.values()];
}

// v3.4: on your own profile, fetch everything you own in one uid-scoped query (any visibility,
// including legacy docs with no visibility field) — the same "mine" half of the mine+public
// pattern gallery.js/journal.js/timeline.js use. Rules-wise this is the provably-scoped
// `uid == request.auth.uid` read that isMineOrPublic() always allowed; it just was never
// used here before, so an owner couldn't preview/open their own private items from Profile.
async function fetchMineAll(collectionName, uid) {
  try {
    const snap = await getDocs(query(collection(db, collectionName), where("uid", "==", uid)));
    // Even previewing your own profile never shows your own trashed Memories — Trash is a
    // dedicated Memories-page view, not something Profile should surface a second copy of.
    return excludeDeleted(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  } catch (err) {
    console.error(`[profile] own ${collectionName} fetch failed:`, err.code || err);
    return [];
  }
}

// One getDoc against the target's own friendships subcollection — readable by either side per
// firestore.rules (`friendships/{uid}/friends/{friendUid}`: read if auth.uid==uid||friendUid).
async function isAcceptedFriendOfTarget(targetUid) {
  const me = auth.currentUser;
  if (!me || me.uid === targetUid) return false;
  try {
    const snap = await getDoc(doc(db, "friendships", targetUid, "friends", me.uid));
    return snap.exists();
  } catch (err) {
    console.error("[profile] friendship check failed:", err.code || err);
    return false;
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
    <div><p class="text-textGray text-xs">${i18nT("profile.photos")}</p><p class="font-code font-semibold text-lg mt-1">${photos.length}</p></div>
    <div><p class="text-textGray text-xs">${i18nT("profile.journal_entries")}</p><p class="font-code font-semibold text-lg mt-1">${journals.length}</p></div>
    <div><p class="text-textGray text-xs">${i18nT("profile.journey_events")}</p><p class="font-code font-semibold text-lg mt-1">${events.length}</p></div>
    <div><p class="text-textGray text-xs">${i18nT("profile.habit_completion")}</p><p class="font-code font-semibold text-lg mt-1">${habitCompletionPct(habits)}%</p></div>`;
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
    ...Object.entries(categoryMeta()).map(([key, meta]) => ({ key, ...meta, count: counts[key] })),
    { key: "featured", label: i18nT("memories.album_favorites"), icon: "fa-star", count: counts.featured },
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
      el.type = "button";
      el.title = i18nT("profile.open_memory");
      el.className = "aspect-square overflow-hidden bg-darkBg/40 relative";
      el.innerHTML = `
        <img src="${post.url}" alt="${post.caption || i18nT("profile.photo_alt")}" class="w-full h-full object-cover hover:opacity-80 transition-opacity">
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
      const el = document.createElement("button");
      el.type = "button";
      el.title = i18nT("profile.open_journey");
      el.className = "w-full text-left flex items-center justify-between gap-3 py-1.5 px-2 -mx-2 rounded-lg border-b border-borderNeon/30 last:border-0 hover:bg-neonPurple/10 transition-colors";
      el.innerHTML = `<span class="text-sm text-white truncate">${e.title || "Untitled"}</span>
        <span class="flex items-center gap-2 flex-shrink-0"><span class="text-[11px] font-code text-textGray">${fmtDate(e.date)}</span><i class="fa-solid fa-chevron-right text-[9px] text-textGray/50"></i></span>`;
      el.addEventListener("click", () => openItemModal("journey", e));
      return el;
    })
  );
}

function renderJournalList(journals) {
  journalSection.classList.toggle("hidden", journals.length === 0);
  const sorted = [...journals].sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
  journalListEl.replaceChildren(
    ...sorted.map((j) => {
      const el = document.createElement("button");
      el.type = "button";
      el.title = i18nT("profile.open_journal");
      el.className = "w-full text-left flex items-center justify-between gap-3 py-1.5 px-2 -mx-2 rounded-lg border-b border-borderNeon/30 last:border-0 hover:bg-neonPurple/10 transition-colors";
      const snippet = (j.content || "").replace(/[#*_`>-]/g, "").slice(0, 90);
      el.innerHTML = `<span class="min-w-0"><span class="block text-sm text-white truncate">${j.title || "Untitled"}</span><span class="block text-xs text-textGray mt-0.5 truncate">${snippet}</span></span>
        <i class="fa-solid fa-chevron-right text-[9px] text-textGray/50 flex-shrink-0"></i>`;
      el.addEventListener("click", () => openItemModal("journal", j));
      return el;
    })
  );
}

// ---- View Resume / View Career Profile CTA (v3.2.2) — links out to resume.html's own public/
// friend viewer mode rather than duplicating any Career UI here. Career is Owner-only-to-write
// (no multi-user Career CMS yet), so the CTA only ever appears on the app Owner's profile
// (targetRole === "owner") — any other target has no resume to show and the link would just land
// on a locked notice; that includes the Owner *viewing* a friend's profile, which used to leak
// the CTA via a bare isOwner(viewer) check. Within an owner-target profile, the same per-viewer
// gate as career.js's computeAccess(): self, public, or connections-tier for an accepted friend.
// Missing careerVisibility defaults to private (hidden), matching career.js's own default. ----
function renderResumeCta({ careerVisibility, isSelf, isFriend, targetUid, username, targetRole }) {
  const targetHasResume = targetRole === "owner";
  const canView = targetHasResume
    && (isSelf || careerVisibility === "public" || (careerVisibility === "connections" && isFriend));
  resumeCta.classList.toggle("hidden", !canView);
  if (!canView) return;
  resumeCta.href = username ? `resume.html?u=${encodeURIComponent(username)}` : `resume.html?uid=${encodeURIComponent(targetUid)}`;
}

// ---- Career (public subset — Career is Owner-only to write, so this is usually only
// non-empty on the Owner's own profile; hidden entirely for anyone else). ----

function careerTitle(item) {
  return item.title_en || item.title_zh || "Untitled";
}

function renderCareer(experiences, projects) {
  const items = [
    ...experiences.map((e) => ({
      icon: "fa-briefcase",
      title: e.role_en || e.role_zh || careerTitle(e),
      subtitle: [e.company, `${e.startDate || ""}${e.startDate || e.endDate ? " – " : ""}${e.endDate || (e.startDate ? "Present" : "")}`].filter(Boolean).join(" · "),
      at: e.startDate ? new Date(e.startDate).getTime() : 0,
    })),
    ...projects.map((p) => ({
      icon: "fa-diagram-project",
      title: careerTitle(p),
      subtitle: p.category || "",
      at: p.createdAt?.toMillis?.() || 0,
    })),
  ].sort((a, b) => b.at - a.at);

  careerSection.classList.toggle("hidden", items.length === 0);
  if (!items.length) return;

  careerListEl.replaceChildren(
    ...items.map((item) => {
      const el = document.createElement("div");
      el.className = "flex items-start gap-3";
      el.innerHTML = `
        <span class="w-8 h-8 rounded-lg bg-neonPurple/10 text-neonPurple flex items-center justify-center text-xs flex-shrink-0 mt-0.5"><i class="fa-solid ${item.icon}"></i></span>
        <div class="min-w-0">
          <p class="text-sm text-white truncate">${item.title}</p>
          ${item.subtitle ? `<p class="text-xs text-textGray font-code mt-0.5 truncate">${item.subtitle}</p>` : ""}
        </div>`;
      return el;
    })
  );
}

// ---- Public Atlas — a compact summary of named places across public Memories/Journal/Journey,
// linking out to atlas.html rather than re-embedding Leaflet on every profile (Atlas itself
// owns the map). ----

function renderAtlasPlaces(photos, journals, events) {
  const counts = new Map();
  [...photos, ...journals, ...events].forEach((item) => {
    const place = item.locationName || item.locationAddress;
    if (!place) return;
    counts.set(place, (counts.get(place) || 0) + 1);
  });

  const places = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  atlasSection.classList.toggle("hidden", places.length === 0);
  if (!places.length) return;

  atlasPlacesListEl.replaceChildren(
    ...places.map(([name, count]) => {
      // Links to the Atlas module (the one page that owns the map) rather than a per-place
      // detail — only the place *name* is ever shown here, never coordinates.
      const el = document.createElement("a");
      el.href = "atlas.html";
      el.title = i18nT("profile.view_on_atlas");
      el.className = "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-borderNeon bg-darkBg/40 text-xs text-white hover:border-neonPurple/60 hover:bg-neonPurple/10 transition-colors";
      el.innerHTML = `<i class="fa-solid fa-location-dot text-neonPurple text-[10px]"></i> ${name} <span class="text-textGray font-code">&times;${count}</span>`;
      return el;
    })
  );
}

// ---- Achievements (public subset only) ----
//
// Mirrors dashboard.js's tiered badges, but only for metrics derivable from PUBLIC data —
// the expenses-based badge is deliberately never computed here, since expenses are always
// private and unreadable for any uid other than the signed-in user's own.
// A function, not a static array, so labels stay correct across a language switch.
function publicAchievements() {
  return [
    { key: "photos", label: i18nT("profile.photos"), icon: "fa-image", tiers: [10, 50, 100, 500] },
    { key: "journals", label: i18nT("profile.journal_entries"), icon: "fa-book", tiers: [10, 50, 100, 365] },
    { key: "streak", label: i18nT("profile.longest_streak"), icon: "fa-fire", tiers: [7, 30, 100, 365] },
  ];
}

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
  const defs = publicAchievements();
  const anyUnlocked = defs.some((def) => counts[def.key] >= def.tiers[0]);
  section.classList.toggle("hidden", !anyUnlocked);
  if (!anyUnlocked) return;
  document.getElementById("achievements-list").replaceChildren(...defs.map((def) => achievementTile(def, counts[def.key])));
}

// ---- Recent Activity ----

function renderRecentActivity({ photos, journals, events }) {
  const items = [
    ...photos.map((p) => ({ icon: "fa-image", text: `${i18nT("profile.activity_uploaded")} ${p.caption || i18nT("profile.a_photo")}`, at: p.uploadedAt, title: i18nT("profile.open_memory"), open: () => openPhotoModal(p) })),
    ...journals.map((j) => ({ icon: "fa-book", text: `${i18nT("profile.activity_wrote")} "${j.title || "Untitled"}"`, at: j.createdAt, title: i18nT("profile.open_journal"), open: () => openItemModal("journal", j) })),
    ...events.map((e) => ({ icon: "fa-timeline", text: `${i18nT("profile.activity_logged")} "${e.title || "Untitled"}"`, at: e.date, title: i18nT("profile.open_journey"), open: () => openItemModal("journey", e) })),
  ]
    .filter((i) => i.at?.toMillis)
    .sort((a, b) => b.at.toMillis() - a.at.toMillis())
    .slice(0, 8);

  recentActivitySection.classList.toggle("hidden", items.length === 0);
  recentActivityList.replaceChildren(
    ...items.map((i) => {
      const el = document.createElement("button");
      el.type = "button";
      el.title = i.title;
      el.className = "w-full text-left flex items-center gap-3 px-2 py-1 -mx-2 rounded-lg hover:bg-neonPurple/10 transition-colors";
      el.innerHTML = `
        <span class="w-7 h-7 rounded-lg bg-neonPurple/10 text-neonPurple flex items-center justify-center text-xs flex-shrink-0"><i class="fa-solid ${i.icon}"></i></span>
        <span class="text-sm text-white truncate flex-1">${i.text}</span>
        <i class="fa-solid fa-chevron-right text-[9px] text-textGray/50 flex-shrink-0"></i>`;
      el.addEventListener("click", i.open);
      return el;
    })
  );
}

// ---- Visibility badge + read-only detail modal (v3.4 Shared Profile Detail Navigation) ----
//
// Every item reachable here was already fetched through a visibility-safe query (public,
// connections-tier for accepted friends, or the owner's own uid-scoped fetch), so the modal
// only ever labels what's on screen — it never widens access. Missing visibility reads as
// private, which is only reachable on your own profile.

function visibilityBadgeHtml(item) {
  const v = item.visibility;
  let label, icon;
  if (v === "public") {
    label = i18nT("profile.public_item");
    icon = "fa-globe";
  } else if (v === "connections") {
    // On your own profile "Shared with you" would read backwards — use the picker's own label.
    label = cachedProfileData?.isSelf ? i18nT("common.connections") : i18nT("profile.shared_with_you");
    icon = "fa-user-group";
  } else {
    label = i18nT("profile.private_item");
    icon = "fa-lock";
  }
  return `<span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-borderNeon bg-darkBg/40 text-[10px] font-code text-textGray flex-shrink-0"><i class="fa-solid ${icon} text-[9px]"></i>${label}</span>`;
}

// v3.4.1: place text only — never raw coordinates. If an item carries only lat/lng (docs
// from before address-based locations), the owner sees a "Coordinates saved" note on their
// own profile; friends/public viewers see nothing location-related for that item at all.
function locationLabelHtml(item) {
  const text = item.locationName
    ? item.locationName + (item.locationAddress ? ` · ${item.locationAddress}` : "")
    : item.locationAddress;
  if (text) return `<span><i class="fa-solid fa-location-dot mr-1"></i>${esc(text)}</span>`;
  if (item.latitude != null && item.longitude != null && cachedProfileData?.isSelf)
    return `<span><i class="fa-solid fa-location-dot mr-1"></i>${esc(i18nT("common.coordinates_saved"))}</span>`;
  return "";
}

function ownerLineHtml() {
  const person = cachedProfilePerson;
  if (!person) return "";
  const handle = formatHandle(person.username);
  return `<span class="truncate"><i class="fa-solid fa-user mr-1"></i>${esc(publicDisplayName(person))}${handle ? ` <span class="text-textGray/60">${esc(handle)}</span>` : ""}</span>`;
}

function closeItemModal() {
  itemModal.classList.add("hidden");
}
itemModalClose.addEventListener("click", closeItemModal);
itemModalBackdrop.addEventListener("click", closeItemModal);

// kind: "journal" (journals doc) or "journey" (life_events doc). Deliberately no edit/delete/
// like/comment controls — this is a calm, read-only window into a shared item, not a feed.
// locationName only; lat/lng are never rendered for anyone here.
function openItemModal(kind, item) {
  const mood = kind === "journal" ? MOOD_META[item.mood] || null : null;
  const date = fmtDate(kind === "journey" ? item.date : item.createdAt);
  const body = kind === "journal" ? item.content : item.description;
  const tags = item.tags || [];
  itemModalBody.innerHTML = `
    <div class="flex items-center justify-between gap-3 text-[11px] font-code text-textGray">
      ${ownerLineHtml()}
      ${visibilityBadgeHtml(item)}
    </div>
    <h2 class="text-lg font-cyber font-bold text-white leading-snug">${mood ? `${mood.emoji} ` : ""}${esc(item.title || "Untitled")}</h2>
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-code text-textGray">
      ${date ? `<span><i class="fa-solid fa-calendar mr-1"></i>${date}</span>` : ""}
      ${mood ? `<span>${i18nT(mood.i18nKey)}</span>` : ""}
      ${locationLabelHtml(item)}
    </div>
    ${kind === "journal" && item.imageUrl ? `<img src="${esc(item.imageUrl)}" alt="" class="w-full rounded-xl max-h-64 object-cover">` : ""}
    ${body ? `<p class="text-sm text-white leading-relaxed whitespace-pre-wrap">${esc(body)}</p>` : ""}
    ${tags.length ? `<div class="flex flex-wrap gap-1.5 pt-1">${tags.map((tag) => `<span class="text-[10px] font-code px-2 py-0.5 rounded-full border border-borderNeon text-textGray">#${esc(tag)}</span>`).join("")}</div>` : ""}`;
  itemModal.classList.remove("hidden");
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
  photoModalTopline.innerHTML = `${ownerLineHtml()}${visibilityBadgeHtml(post)}`;
  const albumMeta = categoryMeta()[albumOf(post)];
  photoModalMeta.innerHTML = [
    fmtDate(post.uploadedAt),
    albumMeta ? esc(albumMeta.label) : "",
    locationLabelHtml(post),
  ].filter(Boolean).join('<span class="mx-1.5 text-textGray/40">&middot;</span>');
  photoModalLikeBtn.innerHTML = `<i class="fa-regular fa-heart"></i> <span id="photo-modal-like-count">&hellip;</span>`;
  photoModalComments.innerHTML = `<p class="text-xs font-code text-textGray">${i18nT("common.loading_comments")}</p>`;

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
    : `<p class="text-xs font-code text-textGray">${i18nT("common.no_comments_yet")}</p>`;

  const user = auth.currentUser;
  photoModalComments.innerHTML = `
    <div class="space-y-1.5">${list}</div>
    ${user ? `
      <form class="comment-form flex items-center gap-2 mt-2.5">
        <input type="text" placeholder="${i18nT("common.add_comment_placeholder")}" class="comment-input flex-1 bg-darkBg/60 border border-borderNeon rounded-lg px-3 py-1.5 text-xs text-white placeholder:text-textGray/60">
        <button type="submit" class="px-3 py-1.5 bg-neonPurple/15 text-neonPurple rounded-lg text-xs font-code hover:bg-neonPurple/25 transition-colors">${i18nT("common.post")}</button>
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

// Cached last-fetched data, so an eden:langchange re-render (stat labels, album/career/joined
// text, etc. are all JS-set, not data-i18n) never needs to refetch.
let cachedProfileData = null;
let cachedProfilePerson = null;

function rerenderAll() {
  if (!cachedProfileData) return;
  const { photos, journals, events, habits, careerExperiences, careerProjects, careerVisibility, isSelf, isFriend, targetUid, username, targetRole } = cachedProfileData;
  renderStats({ photos, journals, events, habits });
  renderResumeCta({ careerVisibility, isSelf, isFriend, targetUid, username, targetRole });
  renderCareer(careerExperiences, careerProjects);
  renderAlbumTiles(photos);
  renderPhotoGrid();
  renderAtlasPlaces(photos, journals, events);
  renderTimelineList(events);
  renderAchievements({ photos, journals, habits });
  renderRecentActivity({ photos, journals, events });
  renderJournalList(journals);
}

async function loadProfile() {
  let targetUid = targetUidParam;

  // ?u=username is preferred (v3.1): resolve it via the usernames/{usernameLower} reservation
  // doc, the same collection Me's username-uniqueness flow writes to — no new schema.
  if (targetUsername) {
    try {
      const handleSnap = await getDoc(doc(db, "usernames", targetUsername));
      if (!handleSnap.exists()) {
        headerEl.innerHTML = `<p class="text-sm text-textGray">${i18nT("profile.username_not_found")}</p>`;
        return;
      }
      targetUid = handleSnap.data().uid;
    } catch (err) {
      console.error("[profile] username lookup failed:", err.code || err);
      headerEl.innerHTML = `<p class="text-sm text-textGray">${i18nT("profile.could_not_load")}</p>`;
      return;
    }
  }

  if (!targetUid) {
    headerEl.innerHTML = `<p class="text-sm text-textGray">${i18nT("profile.no_profile_specified")}</p>`;
    return;
  }

  let person;
  try {
    const snap = await getDoc(doc(db, "users", targetUid));
    if (!snap.exists()) {
      headerEl.innerHTML = `<p class="text-sm text-textGray">${i18nT("profile.user_not_found")}</p>`;
      return;
    }
    person = snap.data();
  } catch (err) {
    console.error("[profile] user fetch failed:", err.code || err);
    headerEl.innerHTML = `<p class="text-sm text-textGray">${i18nT("profile.could_not_load")}</p>`;
    return;
  }

  cachedProfilePerson = person;
  renderHeader(person);

  const isSelf = auth.currentUser?.uid === targetUid;
  if (!isSelf && !canViewProfile(person.role || "viewer")) {
    privateNotice.classList.remove("hidden");
    return;
  }

  // Friend-Profile View (v3.2): connections-tier Memories/Journal/Journey merge in only for an
  // accepted friend of this specific profile — Career/Achievements/Recent Activity stay derived
  // from whatever photos/journals/events end up in scope, no separate gating needed for them.
  const isFriend = await isAcceptedFriendOfTarget(targetUid);
  // v3.4: on your own profile every own item (private/connections/public, plus legacy docs
  // with no visibility field) is previewable and openable, badged with its visibility so
  // you can tell what others see. Everyone else keeps the visibility-safe merge above.
  const fetchContent = (name) => (isSelf ? fetchMineAll(name, targetUid) : fetchVisibleFor(name, targetUid, isFriend));
  const [photos, journals, events, habits, careerExperiences, careerProjects] = await Promise.all([
    fetchContent("photos"),
    fetchContent("journals"),
    fetchContent("life_events"),
    fetchVisibleFor("habits", targetUid, false),
    fetchByVisibility("career_experiences", targetUid, "public"),
    fetchByVisibility("career_projects", targetUid, "public"),
  ]);
  photos.sort((a, b) => (b.uploadedAt?.toMillis?.() || 0) - (a.uploadedAt?.toMillis?.() || 0));
  allPublicPhotos = photos;
  activeAlbum = null;
  cachedProfileData = {
    photos, journals, events, habits, careerExperiences, careerProjects,
    careerVisibility: person.careerVisibility, isSelf, isFriend, targetUid, username: person.username,
    targetRole: person.role || "viewer",
  };

  contentSection.classList.remove("hidden");
  rerenderAll();
}

onAuthStateChanged(auth, (user) => {
  if (user) loadProfile();
});

// Re-render bilingual/translated content from the cached fetch — stat labels, album labels,
// career items, "Joined {date}", comment-modal chrome — none of it is plain data-i18n markup.
document.addEventListener("eden:langchange", () => {
  if (cachedProfilePerson) renderHeader(cachedProfilePerson);
  rerenderAll();
});
