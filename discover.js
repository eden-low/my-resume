import { auth, db, isOwner } from "./firebase-init.js";
import { t as i18nT } from "./js/i18n.js";
import { resolveDisplayName } from "./js/identity.js";
import {
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import {
  collection,
  query,
  where,
  getDocs,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

const ENDPOINT = "/.netlify/functions/anilist";

// AniList-sourced text (title/description/genres) is untrusted free text from a third-party API
// -- every interpolation into innerHTML below must be escaped. Same implementation as
// habits.js's/calendar.js's pre-existing esc().
function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Phase 1 exposes exactly one external link (AniList's own siteUrl, already host-restricted
// server-side by lib/anilist-operations.js's isAniListSiteUrl()) -- this is a second, independent
// client-side check: http(s)-only (same shape as career.js's safeHref()) AND anilist.co-only, so
// a hypothetical future bug in the server sanitizer still can't produce a javascript:/data:/
// off-site href here.
function safeAniListHref(url) {
  if (typeof url !== "string") return "";
  try {
    const u = new URL(url, location.href);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    if (u.hostname !== "anilist.co" && !u.hostname.endsWith(".anilist.co")) return "";
    return esc(u.href);
  } catch {
    return "";
  }
}

function isSafeImageUrl(url) {
  if (typeof url !== "string") return false;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

// Prefer DOM property assignment for `src` (never string-interpolated into innerHTML). An
// invalid or failed image falls back to a local, fixed placeholder (a Font Awesome icon already
// in the page) -- never a second remote URL.
function setImageWithFallback(imgEl, placeholderEl, url) {
  if (!imgEl || !placeholderEl) return;
  if (!isSafeImageUrl(url)) {
    imgEl.classList.add("hidden");
    placeholderEl.classList.remove("hidden");
    return;
  }
  imgEl.addEventListener(
    "error",
    () => {
      imgEl.classList.add("hidden");
      placeholderEl.classList.remove("hidden");
    },
    { once: true }
  );
  imgEl.src = url;
  imgEl.classList.remove("hidden");
  placeholderEl.classList.add("hidden");
}

// A 401 almost always means a stale cached ID token, not a genuinely invalid session -- exactly
// one retry with a forced refresh. Duplicated from assistant.js's withOneRetryOn401() per this
// repo's established per-file convention (see that function's own header comment).
async function withOneRetryOn401(attempt) {
  let res = await attempt(false);
  if (res.status === 401) {
    res = await attempt(true);
  }
  return res;
}

async function callAniList(operation, args) {
  const user = auth.currentUser;
  if (!user) {
    const err = new Error("not_signed_in");
    err.code = "not_signed_in";
    throw err;
  }
  const res = await withOneRetryOn401(async (forceRefresh) =>
    fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${await user.getIdToken(forceRefresh)}` },
      body: JSON.stringify({ operation, args }),
    })
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    const err = new Error(data.error || "anilist_request_failed");
    err.code = data.error || "anilist_request_failed";
    err.status = res.status;
    throw err;
  }
  return data;
}

function friendlyAniListError(err) {
  const map = {
    rate_limited: "discover.error_rate_limited",
    anilist_upstream_timeout: "discover.error_upstream",
    anilist_upstream_error: "discover.error_upstream",
  };
  return i18nT(map[err && err.code] || "discover.error_generic");
}

// ---- Display helpers (pure) ----

const AIRING_STATUS_META = {
  RELEASING: { label: "discover.airing_releasing", cls: "bg-emerald-500 text-white" },
  FINISHED: { label: "discover.airing_finished", cls: "bg-neonPurple/15 text-neonPurple" },
  NOT_YET_RELEASED: { label: "discover.airing_not_yet_released", cls: "bg-amber-500 text-white" },
  CANCELLED: { label: "discover.airing_cancelled", cls: "bg-rose-500 text-white" },
  HIATUS: { label: "discover.airing_hiatus", cls: "bg-amber-500 text-white" },
};

const STATUS_ORDER = ["planning", "watching", "completed", "paused", "dropped"];
const STATUS_META = {
  planning: { icon: "fa-bookmark", i18n: "discover.status_planning" },
  watching: { icon: "fa-play", i18n: "discover.status_watching" },
  completed: { icon: "fa-check", i18n: "discover.status_completed" },
  paused: { icon: "fa-pause", i18n: "discover.status_paused" },
  dropped: { icon: "fa-xmark", i18n: "discover.status_dropped" },
};

function preferredTitle(media) {
  const t = media && media.title;
  return (t && (t.english || t.romaji || t.native)) || i18nT("discover.untitled");
}

function formatScore(score) {
  return Number.isFinite(score) ? `${score}%` : "—";
}

function availableEpisodeCount(media) {
  if (media.status === "RELEASING" && media.nextAiringEpisode && Number.isFinite(media.nextAiringEpisode.episode)) {
    return Math.max(0, media.nextAiringEpisode.episode - 1);
  }
  return Number.isFinite(media.episodes) ? media.episodes : null;
}

function formatTimeUntilAiring(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatNextAiring(next) {
  if (!next || !Number.isFinite(next.episode)) return null;
  const time = formatTimeUntilAiring(next.timeUntilAiring);
  return time ? i18nT("discover.next_airing", { episode: next.episode, time }) : null;
}

// A followed_anime doc alone (no live AniList data yet, e.g. batch refresh failed) still renders
// a usable card from its own denormalized fields.
function mediaFromFollowedDoc(followedDoc) {
  return {
    id: followedDoc.anilistId,
    title: { romaji: followedDoc.title, english: null, native: null },
    coverImage: { large: followedDoc.coverImage, medium: followedDoc.coverImage },
    averageScore: null,
    format: followedDoc.format,
    status: null,
    episodes: null,
    season: null,
    seasonYear: null,
    nextAiringEpisode: null,
    siteUrl: null,
  };
}

// ---- DOM references ----

const authControl = document.getElementById("auth-control");
const discoverCountEl = document.getElementById("discover-count");

const discoverViewEl = document.getElementById("discover-view");
const mylistViewEl = document.getElementById("mylist-view");
const discoverSearchBar = document.getElementById("discover-search-bar");
const discoverSearchForm = document.getElementById("discover-search-form");
const discoverSearchInput = document.getElementById("discover-search-input");
const discoverGrid = document.getElementById("discover-grid");
const discoverEmpty = document.getElementById("discover-empty");
const discoverError = document.getElementById("discover-error");
const discoverErrorMessage = document.getElementById("discover-error-message");
const discoverRetryBtn = document.getElementById("discover-retry-btn");

const mylistGrid = document.getElementById("mylist-grid");
const mylistEmpty = document.getElementById("mylist-empty");
const mylistError = document.getElementById("mylist-error");
const mylistErrorMessage = document.getElementById("mylist-error-message");
const mylistRetryBtn = document.getElementById("mylist-retry-btn");

const animeModal = document.getElementById("anime-modal");
const animeModalBackdrop = document.getElementById("anime-modal-backdrop");
const animeModalPanel = document.getElementById("anime-modal-panel");
const animeModalTitle = document.getElementById("anime-modal-title");
const animeModalClose = document.getElementById("anime-modal-close");
const animeModalBody = document.getElementById("anime-modal-body");

const discoverToast = document.getElementById("discover-toast");
const discoverToastText = document.getElementById("discover-toast-text");
const discoverToastAction = document.getElementById("discover-toast-action");
const discoverToastClose = document.getElementById("discover-toast-close");

// ---- State ----

let currentView = "discover";
let currentDiscoverSubtab = "this_season";
let currentMyListFilter = "all";
let lastSearchQuery = "";
let discoverResults = []; // last successfully loaded Discover-view results
let discoverCache = new Map(); // subtab/search key -> results[]
let cachedFollowed = new Map(); // anilistId -> followed_anime doc {id, ...data}
let myListLive = new Map(); // anilistId -> live sanitized AniList media (best-effort)
let pageInitialized = false;

function discoverCacheKey() {
  return currentDiscoverSubtab === "search" ? `search:${lastSearchQuery}` : currentDiscoverSubtab;
}

// ---- Toast (Remove-from-list Undo) ----

let toastTimer = null;
function showToast(message, { actionLabel, onAction } = {}) {
  clearTimeout(toastTimer);
  discoverToastText.textContent = message;
  if (actionLabel && onAction) {
    discoverToastAction.textContent = actionLabel;
    discoverToastAction.classList.remove("hidden");
    discoverToastAction.onclick = () => { hideToast(); onAction(); };
  } else {
    discoverToastAction.classList.add("hidden");
    discoverToastAction.onclick = null;
  }
  discoverToast.classList.remove("hidden");
  toastTimer = setTimeout(hideToast, 8000);
}
function hideToast() {
  discoverToast.classList.add("hidden");
  clearTimeout(toastTimer);
}
discoverToastClose.addEventListener("click", hideToast);

// ---- Firestore: followed_anime (Owner-only — every call below is also a no-op guard in case
// this script ever runs for a non-owner despite auth-guard.js's data-owner-only redirect, which
// should always win the race first; the real security boundary is firestore.rules, not this
// check, but there is no reason for this client to ever attempt the read/write regardless). ----

function followDocId(user, anilistId) {
  return `${user.uid}_${anilistId}`;
}

async function fetchFollowed() {
  const user = auth.currentUser;
  if (!user || !isOwner(user)) {
    cachedFollowed = new Map();
    return;
  }
  const snap = await getDocs(query(collection(db, "followed_anime"), where("uid", "==", user.uid)));
  const map = new Map();
  snap.forEach((d) => map.set(d.data().anilistId, { id: d.id, ...d.data() }));
  cachedFollowed = map;
}

async function addFollow(media, status) {
  const user = auth.currentUser;
  if (!user || !isOwner(user)) return;
  if (cachedFollowed.has(media.id)) return; // already followed — the UI shouldn't offer Add here
  const ref = doc(db, "followed_anime", followDocId(user, media.id));
  const payload = {
    uid: user.uid,
    anilistId: media.id,
    mediaType: "ANIME",
    title: preferredTitle(media),
    coverImage: (media.coverImage && (media.coverImage.large || media.coverImage.medium)) || null,
    format: media.format || null,
    status,
    isAdult: false,
    followedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  try {
    await setDoc(ref, payload);
    await fetchFollowed();
    renderCurrentView();
    refreshOpenModalActions(media.id);
  } catch (err) {
    console.error("[discover] follow failed:", err.code || err);
    showToast(i18nT("discover.error_follow_failed"));
  }
}

async function updateFollowStatus(followedDoc, newStatus) {
  const user = auth.currentUser;
  if (!user || !isOwner(user)) return;
  const ref = doc(db, "followed_anime", followedDoc.id);
  try {
    await updateDoc(ref, { status: newStatus, updatedAt: serverTimestamp() });
    followedDoc.status = newStatus;
    cachedFollowed.set(followedDoc.anilistId, followedDoc);
    renderCurrentView();
    refreshOpenModalActions(followedDoc.anilistId);
  } catch (err) {
    console.error("[discover] status update failed:", err.code || err);
    showToast(i18nT("discover.error_status_failed"));
  }
}

async function removeFollow(followedDoc) {
  const user = auth.currentUser;
  if (!user || !isOwner(user)) return;
  const ref = doc(db, "followed_anime", followedDoc.id);
  const snapshot = { ...followedDoc };
  try {
    await deleteDoc(ref);
    cachedFollowed.delete(followedDoc.anilistId);
    renderCurrentView();
    refreshOpenModalActions(followedDoc.anilistId);
    showToast(i18nT("discover.removed_from_list"), {
      actionLabel: i18nT("common.undo"),
      onAction: () => undoRemove(snapshot),
    });
  } catch (err) {
    console.error("[discover] remove failed:", err.code || err);
    showToast(i18nT("discover.error_remove_failed"));
  }
}

// Undo re-follows as a fresh doc (the original was genuinely deleted, so this is always a
// create, never a stale-followedAt update) — an honest "follow it again," not a true undelete.
async function undoRemove(snapshot) {
  const user = auth.currentUser;
  if (!user || !isOwner(user)) return;
  const ref = doc(db, "followed_anime", followDocId(user, snapshot.anilistId));
  const payload = {
    uid: user.uid,
    anilistId: snapshot.anilistId,
    mediaType: "ANIME",
    title: snapshot.title,
    coverImage: snapshot.coverImage || null,
    format: snapshot.format || null,
    status: snapshot.status,
    isAdult: false,
    followedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  try {
    await setDoc(ref, payload);
    await fetchFollowed();
    renderCurrentView();
  } catch (err) {
    console.error("[discover] undo failed:", err.code || err);
  }
}

// ---- Card + detail-modal actions (shared renderer) ----

function renderCardActions(container, media, followedDoc) {
  container.replaceChildren();
  if (followedDoc) {
    const select = document.createElement("select");
    select.className = "status-select flex-1 bg-darkBg/60 border border-borderNeon rounded-lg px-2 py-1.5 text-[11px] font-code text-white";
    select.setAttribute("aria-label", i18nT("discover.change_status"));
    STATUS_ORDER.forEach((s) => {
      const opt = document.createElement("option");
      opt.value = s;
      opt.textContent = i18nT(STATUS_META[s].i18n);
      if (s === followedDoc.status) opt.selected = true;
      select.appendChild(opt);
    });
    select.addEventListener("click", (e) => e.stopPropagation());
    select.addEventListener("change", (e) => {
      e.stopPropagation();
      updateFollowStatus(followedDoc, select.value);
    });

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "flex-shrink-0 w-8 h-8 rounded-lg bg-rose-500/10 text-rose-400 hover:bg-rose-500/20 transition-colors flex items-center justify-center";
    removeBtn.setAttribute("aria-label", i18nT("discover.remove_from_list"));
    removeBtn.innerHTML = `<i class="fa-solid fa-trash text-xs"></i>`;
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      removeFollow(followedDoc);
    });

    container.append(select, removeBtn);
  } else {
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "flex-1 px-2 py-1.5 bg-neonPurple/15 text-neonPurple rounded-lg text-[10px] font-cyber font-bold tracking-wider hover:bg-neonPurple/25 transition-colors";
    addBtn.innerHTML = `<i class="fa-solid fa-plus mr-1"></i>${esc(i18nT("discover.add_to_plan"))}`;
    addBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      addFollow(media, "planning");
    });
    container.appendChild(addBtn);
  }
}

// ---- Cards ----

function mediaCard(media, followedDoc) {
  const card = document.createElement("div");
  card.className = "card-lift is-visible bg-cardBg/90 neon-border-purple rounded-xl overflow-hidden flex flex-col cursor-pointer";
  const title = preferredTitle(media);
  const cover = (media.coverImage && (media.coverImage.large || media.coverImage.medium)) || "";
  const airing = AIRING_STATUS_META[media.status] || null;
  const nextAiring = formatNextAiring(media.nextAiringEpisode);
  const eps = availableEpisodeCount(media);

  card.innerHTML = `
    <div class="relative w-full h-40 bg-darkBg/60">
      <img data-cover-img alt="" class="w-full h-full object-cover hidden">
      <div data-cover-placeholder class="w-full h-full flex items-center justify-center text-textGray/50"><i class="fa-solid fa-clapperboard text-2xl"></i></div>
      ${followedDoc ? `<span class="absolute top-2 left-2 px-2 py-0.5 rounded-full bg-darkBg/80 backdrop-blur-sm text-[10px] font-code text-white flex items-center gap-1"><i class="fa-solid ${STATUS_META[followedDoc.status] ? STATUS_META[followedDoc.status].icon : "fa-bookmark"}"></i>${esc(STATUS_META[followedDoc.status] ? i18nT(STATUS_META[followedDoc.status].i18n) : followedDoc.status)}</span>` : ""}
      ${airing ? `<span class="absolute top-2 right-2 px-2 py-0.5 rounded-full text-[10px] font-code ${airing.cls}">${esc(i18nT(airing.label))}</span>` : ""}
    </div>
    <div class="p-3 flex-1 flex flex-col gap-2">
      <p class="text-sm font-semibold text-white leading-snug line-clamp-2">${esc(title)}</p>
      <div class="flex items-center flex-wrap gap-x-2 gap-y-1 text-[10px] font-code text-textGray">
        ${media.format ? `<span>${esc(media.format)}</span>` : ""}
        <span class="flex items-center gap-1"><i class="fa-solid fa-star text-amber-400"></i>${esc(formatScore(media.averageScore))}</span>
        ${eps != null ? `<span>${eps} ep${eps === 1 ? "" : "s"}</span>` : ""}
      </div>
      ${nextAiring ? `<p class="text-[10px] font-code text-neonPurple">${esc(nextAiring)}</p>` : ""}
      <div class="mt-auto pt-2 flex items-center gap-1.5" data-card-actions></div>
    </div>`;

  if (cover) {
    setImageWithFallback(card.querySelector("[data-cover-img]"), card.querySelector("[data-cover-placeholder]"), cover);
  }
  renderCardActions(card.querySelector("[data-card-actions]"), media, followedDoc);
  card.addEventListener("click", () => openDetailModal(media.id));
  return card;
}

function skeletonBlocks(n) {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < n; i++) {
    const div = document.createElement("div");
    div.className = "skeleton h-64 rounded-xl";
    frag.appendChild(div);
  }
  return frag;
}

// ---- Discover view ----

function renderDiscoverGrid() {
  discoverError.classList.add("hidden");
  if (!discoverResults.length) {
    discoverGrid.replaceChildren();
    discoverEmpty.classList.remove("hidden");
  } else {
    discoverEmpty.classList.add("hidden");
    discoverGrid.replaceChildren(...discoverResults.map((m) => mediaCard(m, cachedFollowed.get(m.id))));
  }
  updateCount();
}

function showDiscoverLoading() {
  discoverGrid.replaceChildren(skeletonBlocks(8));
  discoverEmpty.classList.add("hidden");
  discoverError.classList.add("hidden");
}

function showDiscoverError(err) {
  discoverGrid.replaceChildren();
  discoverEmpty.classList.add("hidden");
  discoverErrorMessage.textContent = friendlyAniListError(err);
  discoverError.classList.remove("hidden");
}

async function loadDiscoverGrid({ force = false } = {}) {
  const key = discoverCacheKey();
  if (!force && discoverCache.has(key)) {
    discoverResults = discoverCache.get(key);
    renderDiscoverGrid();
    return;
  }
  if (currentDiscoverSubtab === "search" && !lastSearchQuery) {
    discoverResults = [];
    renderDiscoverGrid();
    return;
  }
  showDiscoverLoading();
  try {
    let data;
    if (currentDiscoverSubtab === "this_season") {
      data = await callAniList("browse", { mode: "this_season", perPage: 20 });
    } else if (currentDiscoverSubtab === "trending") {
      data = await callAniList("browse", { mode: "trending", perPage: 20 });
    } else {
      data = await callAniList("search", { query: lastSearchQuery, perPage: 20 });
    }
    discoverResults = data.results || [];
    discoverCache.set(key, discoverResults);
    renderDiscoverGrid();
  } catch (err) {
    console.error("[discover] load failed:", err.code || err);
    showDiscoverError(err);
  }
}

function switchDiscoverSubtab(subtab) {
  currentDiscoverSubtab = subtab;
  document.querySelectorAll(".discover-subtab").forEach((btn) => {
    const active = btn.dataset.subtab === subtab;
    btn.classList.toggle("text-white", active);
    btn.classList.toggle("bg-neonPurple/15", active);
  });
  discoverSearchBar.classList.toggle("hidden", subtab !== "search");
  loadDiscoverGrid();
}

document.querySelectorAll(".discover-subtab").forEach((btn) => {
  btn.addEventListener("click", () => {
    switchDiscoverSubtab(btn.dataset.subtab);
    if (btn.dataset.subtab === "search") discoverSearchInput.focus();
  });
});

discoverSearchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const q = discoverSearchInput.value.trim();
  if (!q) return;
  lastSearchQuery = q;
  loadDiscoverGrid({ force: true });
});

discoverRetryBtn.addEventListener("click", () => loadDiscoverGrid({ force: true }));

// ---- My List view ----

function renderMyListGrid() {
  mylistError.classList.add("hidden");
  const filtered = [...cachedFollowed.values()].filter((f) => currentMyListFilter === "all" || f.status === currentMyListFilter);
  filtered.sort((a, b) => (b.updatedAt?.toMillis?.() || 0) - (a.updatedAt?.toMillis?.() || 0));
  if (!filtered.length) {
    mylistGrid.replaceChildren();
    mylistEmpty.classList.remove("hidden");
  } else {
    mylistEmpty.classList.add("hidden");
    mylistGrid.replaceChildren(...filtered.map((f) => mediaCard(myListLive.get(f.anilistId) || mediaFromFollowedDoc(f), f)));
  }
  updateCount();
}

function showMyListLoading() {
  mylistGrid.replaceChildren(skeletonBlocks(4));
  mylistEmpty.classList.add("hidden");
  mylistError.classList.add("hidden");
}

function showMyListError(err) {
  mylistGrid.replaceChildren();
  mylistEmpty.classList.add("hidden");
  mylistErrorMessage.textContent = friendlyAniListError(err);
  mylistError.classList.remove("hidden");
}

async function loadMyList() {
  showMyListLoading();
  try {
    await fetchFollowed();
  } catch (err) {
    console.error("[discover] fetchFollowed failed:", err.code || err);
    showMyListError(err);
    return;
  }
  const ids = [...cachedFollowed.keys()];
  myListLive = new Map();
  if (ids.length) {
    try {
      // Batched via id_in — one Function call for the whole list, never N+1.
      const data = await callAniList("batch", { ids });
      (data.results || []).forEach((m) => myListLive.set(m.id, m));
    } catch (err) {
      // Best-effort: the Owner's own saved title/cover/format/status are already fully
      // renderable from Firestore alone, so a live-refresh failure degrades gracefully rather
      // than blocking the whole view.
      console.error("[discover] batch live refresh failed (showing cached fields only):", err.code || err);
    }
  }
  renderMyListGrid();
}

mylistRetryBtn.addEventListener("click", () => loadMyList());

function setMyListFilter(filter) {
  currentMyListFilter = filter;
  document.querySelectorAll(".mylist-filter-tab").forEach((btn) => {
    const active = btn.dataset.filter === filter;
    btn.classList.toggle("text-white", active);
    btn.classList.toggle("bg-neonPurple/15", active);
  });
  renderMyListGrid();
}

document.querySelectorAll(".mylist-filter-tab").forEach((btn) => btn.addEventListener("click", () => setMyListFilter(btn.dataset.filter)));

// ---- View switching ----

function updateCount() {
  if (currentView === "discover") {
    discoverCountEl.textContent = discoverResults.length ? i18nT("discover.count_results", { n: discoverResults.length }) : "";
  } else {
    discoverCountEl.textContent = cachedFollowed.size ? i18nT("discover.count_mylist", { n: cachedFollowed.size }) : "";
  }
}

function renderCurrentView() {
  if (currentView === "discover") renderDiscoverGrid();
  else renderMyListGrid();
}

function switchView(view) {
  currentView = view;
  document.querySelectorAll(".view-tab").forEach((btn) => {
    const active = btn.dataset.view === view;
    btn.classList.toggle("bg-neonPurple/20", active);
    btn.classList.toggle("text-white", active);
  });
  discoverViewEl.classList.toggle("hidden", view !== "discover");
  mylistViewEl.classList.toggle("hidden", view !== "mylist");
  if (view === "mylist") loadMyList();
  else renderDiscoverGrid();
  updateCount();
}

document.querySelectorAll(".view-tab").forEach((btn) => btn.addEventListener("click", () => switchView(btn.dataset.view)));

// ---- Accessible detail modal (focus trap + Escape + focus restoration) ----
// Duplicated from gallery.js's trapFocus()/makeConfirmModal() precedent per this repo's
// established per-file convention — no shared modal component exists in this codebase.

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

let modalUntrap = null;
let modalReturnFocusEl = null;
let modalRequestToken = 0;
let currentModalAnilistId = null;

function closeDetailModal() {
  animeModal.classList.add("hidden");
  currentModalAnilistId = null;
  if (modalUntrap) { modalUntrap(); modalUntrap = null; }
  if (modalReturnFocusEl && document.body.contains(modalReturnFocusEl)) modalReturnFocusEl.focus();
  modalReturnFocusEl = null;
}

animeModalClose.addEventListener("click", closeDetailModal);
animeModalBackdrop.addEventListener("click", closeDetailModal);

function renderDetailError(err) {
  animeModalTitle.textContent = i18nT("discover.detail_error_title");
  animeModalBody.innerHTML = `
    <p class="text-sm font-code text-rose-400">${esc(friendlyAniListError(err))}</p>
    <button id="anime-modal-retry-btn" type="button" class="mt-3 px-4 py-2 bg-cardBg/70 border border-borderNeon rounded-xl text-xs font-cyber font-bold tracking-wider text-white hover:border-neonPurple transition-all">${esc(i18nT("common.retry"))}</button>`;
  document.getElementById("anime-modal-retry-btn").addEventListener("click", () => openDetailModal(currentModalAnilistId));
}

function renderDetailModal(media) {
  if (!media) {
    animeModalTitle.textContent = i18nT("discover.detail_not_found_title");
    animeModalBody.innerHTML = `<p class="text-sm text-textGray">${esc(i18nT("discover.detail_not_found"))}</p>`;
    return;
  }
  const title = preferredTitle(media);
  animeModalTitle.textContent = title;
  const airing = AIRING_STATUS_META[media.status] || null;
  const nextAiring = formatNextAiring(media.nextAiringEpisode);
  const eps = availableEpisodeCount(media);
  const followedDoc = cachedFollowed.get(media.id);
  const href = safeAniListHref(media.siteUrl);
  const genres = Array.isArray(media.genres) ? media.genres : [];

  animeModalBody.innerHTML = `
    <div class="flex gap-4">
      <div class="relative w-24 h-32 flex-shrink-0 rounded-lg overflow-hidden bg-darkBg/60">
        <img data-cover-img alt="" class="w-full h-full object-cover hidden">
        <div data-cover-placeholder class="w-full h-full flex items-center justify-center text-textGray/50"><i class="fa-solid fa-clapperboard text-xl"></i></div>
      </div>
      <div class="flex-1 min-w-0 space-y-1.5 text-xs font-code text-textGray">
        ${media.format ? `<p>${esc(media.format)}</p>` : ""}
        <p class="flex items-center gap-1"><i class="fa-solid fa-star text-amber-400"></i>${esc(formatScore(media.averageScore))}</p>
        ${eps != null ? `<p>${eps} ${eps === 1 ? esc(i18nT("discover.episode_singular")) : esc(i18nT("discover.episode_plural"))}</p>` : ""}
        ${airing ? `<p><span class="inline-block px-2 py-0.5 rounded-full text-[10px] ${airing.cls}">${esc(i18nT(airing.label))}</span></p>` : ""}
        ${nextAiring ? `<p class="text-neonPurple">${esc(nextAiring)}</p>` : ""}
      </div>
    </div>
    ${genres.length ? `<div class="flex flex-wrap gap-1.5 mt-4">${genres.map((g) => `<span class="px-2 py-0.5 rounded-full border border-borderNeon text-[10px] font-code text-textGray">${esc(g)}</span>`).join("")}</div>` : ""}
    ${media.description ? `<p class="mt-4 text-sm text-white leading-relaxed whitespace-pre-wrap">${esc(media.description)}</p>` : ""}
    <div class="mt-4 flex items-center gap-2" data-modal-actions></div>
    ${href ? `<a href="${href}" target="_blank" rel="noopener noreferrer" class="mt-4 inline-flex items-center gap-1.5 text-xs font-code text-neonPurple hover:text-white transition-colors">${esc(i18nT("discover.view_on_anilist"))} <i class="fa-solid fa-arrow-up-right-from-square text-[10px]"></i></a>` : ""}
  `;

  const cover = media.coverImage && (media.coverImage.large || media.coverImage.medium);
  if (cover) {
    setImageWithFallback(animeModalBody.querySelector("[data-cover-img]"), animeModalBody.querySelector("[data-cover-placeholder]"), cover);
  }
  renderCardActions(animeModalBody.querySelector("[data-modal-actions]"), media, followedDoc);
}

function refreshOpenModalActions(anilistId) {
  if (animeModal.classList.contains("hidden") || currentModalAnilistId !== anilistId) return;
  const container = animeModalBody.querySelector("[data-modal-actions]");
  if (!container) return;
  const followedDoc = cachedFollowed.get(anilistId);
  const media = myListLive.get(anilistId) || discoverResults.find((m) => m.id === anilistId) || (followedDoc ? mediaFromFollowedDoc(followedDoc) : null);
  if (media) renderCardActions(container, media, followedDoc);
}

async function openDetailModal(anilistId) {
  modalReturnFocusEl = document.activeElement;
  currentModalAnilistId = anilistId;
  const myToken = ++modalRequestToken;

  animeModalTitle.textContent = i18nT("common.loading");
  animeModalBody.innerHTML = `<div class="space-y-3"><div class="skeleton h-32 rounded-xl"></div><div class="skeleton h-4 rounded w-3/4"></div><div class="skeleton h-4 rounded w-1/2"></div></div>`;
  animeModal.classList.remove("hidden");
  modalUntrap = trapFocus(animeModalPanel, closeDetailModal);
  animeModalClose.focus();

  try {
    const data = await callAniList("details", { id: anilistId });
    if (myToken !== modalRequestToken) return; // superseded by a newer open
    renderDetailModal(data.result);
  } catch (err) {
    if (myToken !== modalRequestToken) return;
    console.error("[discover] detail load failed:", err.code || err);
    renderDetailError(err);
  }
}

// ---- Auth / page init ----

async function renderSignedIn(user) {
  const name = await resolveDisplayName(user);
  authControl.innerHTML = `
    <span class="text-xs text-textGray font-code">${esc(i18nT("common.signed_in_as"))} <span class="text-white">${esc(name)}</span></span>
    <button id="auth-signout-btn" class="px-4 py-2 bg-cardBg/70 border border-borderNeon rounded-xl text-xs font-cyber font-bold tracking-wider text-white hover:border-neonPurple transition-all">
      ${esc(i18nT("common.sign_out"))}
    </button>`;
  document.getElementById("auth-signout-btn").addEventListener("click", () => signOut(auth));
}

function initDiscoverPage() {
  if (pageInitialized) return;
  pageInitialized = true;
  document.querySelectorAll(".view-tab").forEach((btn) => {
    const active = btn.dataset.view === currentView;
    btn.classList.toggle("bg-neonPurple/20", active);
    btn.classList.toggle("text-white", active);
  });
  switchDiscoverSubtab(currentDiscoverSubtab);
}

onAuthStateChanged(auth, (user) => {
  // Strictly Owner-only: auth-guard.js's data-owner-only backstop already redirects any
  // signed-out or non-owner visitor away before the page ever becomes visible — this check is
  // defense-in-depth so this script itself never calls the AniList Function or reads/writes
  // followed_anime for anyone else, even in a theoretical race with that redirect.
  if (user && isOwner(user)) {
    renderSignedIn(user);
    initDiscoverPage();
  }
});

// Re-render from already-cached data on a language switch — never a refetch.
document.addEventListener("eden:langchange", () => {
  renderCurrentView();
  if (!animeModal.classList.contains("hidden") && currentModalAnilistId != null) {
    // Re-open from cached data (no network call) so the modal's own strings retranslate too.
    const followedDoc = cachedFollowed.get(currentModalAnilistId);
    const media = myListLive.get(currentModalAnilistId) || discoverResults.find((m) => m.id === currentModalAnilistId) || (followedDoc ? mediaFromFollowedDoc(followedDoc) : null);
    if (media) renderDetailModal(media);
  }
});
