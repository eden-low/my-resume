import { auth, db, getUserMode } from "./firebase-init.js";
import { getLang, t as i18nT } from "./js/i18n.js";
import { validateCoords } from "./js/location-fields.js";
import { isDeleted } from "./js/memory-filters.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import {
  collection,
  query,
  where,
  getDocs,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

// Security audit fix: locationName/locationAddress are Firestore-stored free text any
// participant can write (Memories/Journal/Journey), and the Connections tab aggregates other
// signed-in users' public location text -- every interpolation into innerHTML below must be
// escaped. Same implementation as calendar.js's pre-existing esc().
function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Opt-in debug tracing (v3.4.2 follow-up): run
//   localStorage.setItem("eden_atlas_debug", "1")
// in the console and reload to see per-collection fetch counts, cluster stats, and the
// reason every location-less/invalid item was skipped. Silent by default.
const ATLAS_DEBUG = (() => {
  try { return localStorage.getItem("eden_atlas_debug") === "1"; } catch { return false; }
})();
function dbg(...args) {
  if (ATLAS_DEBUG) console.log("[atlas:debug]", ...args);
}

const scopeTabs = document.querySelectorAll(".scope-tab");
const atlasCount = document.getElementById("atlas-count");
const atlasEmpty = document.getElementById("atlas-empty");
const detailPanel = document.getElementById("location-detail-panel");
const detailClose = document.getElementById("location-detail-close");

let map = null;
let markers = [];
let activeScope = "mine";
let mineClusters = null;
let connectionsClusters = null;
let cachedCollections = [];
let activeDetailCluster = null;

function bi(obj, field) {
  const suffix = getLang() === "zh-CN" ? "_zh" : "_en";
  return obj[field + suffix] || obj[field + "_en"] || obj[field + "_zh"] || "";
}

// updatedAt participates first (v3.4.2 fix): an old item that just had a location added via
// the edit modal counts as recent, so the Connections tab's 100-most-recent cap can't slice
// out freshly-located old docs.
function itemMillis(item) {
  const ts = item.updatedAt || item.uploadedAt || item.createdAt || item.date;
  return ts?.toMillis?.() || 0;
}

async function fetchMyOnly(name) {
  const user = auth.currentUser;
  if (!user) return [];
  try {
    const snap = await getDocs(query(collection(db, name), where("uid", "==", user.uid)));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.error(`[atlas] ${name} mine query failed:`, err.code || err);
    return [];
  }
}

async function fetchAllPublic(name) {
  try {
    const snap = await getDocs(query(collection(db, name), where("visibility", "==", "public")));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.error(`[atlas] ${name} public query failed:`, err.code || err);
    return [];
  }
}

// v3.2: connections-tier items from one specific accepted friend — scoped by `uid==friendUid`,
// matching firestore.rules' isAcceptedFriend() provability requirement (a bare
// `visibility=='connections'` query with no uid pin would be rejected).
async function fetchConnectionsFor(name, friendUid) {
  try {
    const snap = await getDocs(query(collection(db, name), where("uid", "==", friendUid), where("visibility", "==", "connections")));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.error(`[atlas] ${name} connections query failed for ${friendUid}:`, err.code || err);
    return [];
  }
}

async function loadMyFriendUids() {
  const user = auth.currentUser;
  if (!user) return [];
  try {
    const snap = await getDocs(collection(db, "friendships", user.uid, "friends"));
    return snap.docs.map((d) => d.id);
  } catch (err) {
    console.error("[atlas] friendships fetch failed:", err.code || err);
    return [];
  }
}

async function mergeMinePublic(name) {
  const user = auth.currentUser;
  const resultMap = new Map();
  (await fetchAllPublic(name)).forEach((d) => resultMap.set(d.id, d));
  if (user) (await fetchMyOnly(name)).forEach((d) => resultMap.set(d.id, d));
  return [...resultMap.values()];
}

// v3.4.1: two outputs — mapClusters (items with coordinates, pinned on the Leaflet map, same
// behavior as before) and placeClusters (items with only a locationName/locationAddress,
// grouped by name into the new Saved Places section — coordinates were never required for a
// place to belong in the Atlas). Old docs missing every location field are skipped as before.
// Coordinates may arrive as numbers or numeric strings; 0 is a valid coordinate, so this
// validates (via the same js/location-fields.js boundary validator every save path uses —
// finite AND in-range, never a bare truthy/parse check) instead of truthy-checking, and
// rejects NaN/blank/out-of-range. One unparseable or out-of-range doc used to be able to abort
// marker rendering mid-loop (L.marker on a bad LatLng can throw or place a pin off the visible
// world, taking every later cluster with it — "the map only shows one pin"), or crash the
// Connections tab's toFixed() rounding; now it degrades to Saved Places (if it has place text)
// or is skipped, and every other doc still renders.
function clusterItems(photos, journals, events, precision) {
  const clusters = new Map();
  const places = new Map();
  const stats = { withCoords: 0, placeOnly: 0, invalidCoords: 0, noLocation: 0 };
  function round(n) {
    return precision != null ? Number(n.toFixed(precision)) : n;
  }
  function bump(c, item, type) {
    if (type === "memories") { c.memories++; if (item.url) c.photos.push(item.url); if (item.id) c.memoryIds.add(item.id); }
    if (type === "journal") c.journal++;
    if (type === "journey") c.journey++;
    if (item.collectionId) c.collectionIds.add(item.collectionId);
    c.latest = Math.max(c.latest, itemMillis(item));
  }
  function addItem(item, type) {
    // Trashed Memories never enter clustering at all — no marker, no Saved Places card, not
    // even counted in stats.noLocation. Journals/life_events never carry deletedAt, so this
    // check is a no-op for those types (isDeleted() is false for anything without the field).
    if (isDeleted(item)) return;
    const placeText = item.locationName || item.locationAddress;
    const coords = validateCoords(item.latitude, item.longitude);
    const rawHadCoords = item.latitude != null && item.latitude !== "" && item.longitude != null && item.longitude !== "";
    if (coords) {
      stats.withCoords++;
      const lat = round(coords.latitude);
      const lon = round(coords.longitude);
      const key = (placeText || `${lat},${lon}`).trim().toLowerCase() || `${lat},${lon}`;
      if (!clusters.has(key)) {
        clusters.set(key, {
          name: placeText || `${lat}, ${lon}`,
          address: item.locationName ? item.locationAddress || null : null,
          lat, lon,
          memories: 0, journal: 0, journey: 0,
          collectionIds: new Set(),
          memoryIds: new Set(),
          photos: [],
          latest: 0,
        });
      }
      bump(clusters.get(key), item, type);
    } else if (placeText) {
      if (rawHadCoords) {
        stats.invalidCoords++;
        dbg(`${type} ${item.id || "?"}: invalid coordinates (${JSON.stringify(item.latitude)}, ${JSON.stringify(item.longitude)}) — falling back to Saved Places`);
      } else {
        stats.placeOnly++;
      }
      const key = placeText.trim().toLowerCase();
      if (!places.has(key)) {
        places.set(key, {
          name: placeText,
          address: item.locationName ? item.locationAddress || null : null,
          memories: 0, journal: 0, journey: 0,
          collectionIds: new Set(),
          memoryIds: new Set(),
          photos: [],
          latest: 0,
        });
      }
      const c = places.get(key);
      if (item.locationName && item.locationAddress && !c.address) c.address = item.locationAddress;
      bump(c, item, type);
    } else {
      if (rawHadCoords) {
        stats.invalidCoords++;
        dbg(`${type} ${item.id || "?"}: invalid coordinates and no place text — skipped`);
      } else {
        stats.noLocation++;
      }
    }
  }
  photos.forEach((p) => addItem(p, "memories"));
  journals.forEach((j) => addItem(j, "journal"));
  events.forEach((e) => addItem(e, "journey"));
  dbg("cluster stats:", stats, `→ ${clusters.size} map cluster(s), ${places.size} saved place(s)`);
  if (ATLAS_DEBUG) dbg("map cluster keys:", [...clusters.keys()]);
  return { mapClusters: [...clusters.values()], placeClusters: [...places.values()] };
}

async function loadMineClusters() {
  if (mineClusters) return mineClusters;
  const [photos, journals, events] = await Promise.all([
    fetchMyOnly("photos"),
    fetchMyOnly("journals"),
    fetchMyOnly("life_events"),
  ]);
  // No orderBy/limit anywhere in this scope: every own doc (any visibility, any age) is
  // fetched, so a years-old memory that just gained a location via the edit modal is
  // always in this input set — inclusion is decided purely by clusterItems above.
  dbg("mine fetched:", { photos: photos.length, journals: journals.length, events: events.length });
  mineClusters = clusterItems(photos, journals, events, null);
  return mineClusters;
}

// Public-only content from the owner + approved friends (same role gating as Search People),
// capped to the 100 most recent items and rounded to ~1km precision — never exact addresses,
// never expenses. Lazily fetched only the first time this tab is opened.
async function loadConnectionsClusters() {
  if (connectionsClusters) return connectionsClusters;
  const me = auth.currentUser;
  let allowedUids = new Set();
  try {
    const usersSnap = await getDocs(collection(db, "users"));
    const mode = getUserMode();
    usersSnap.forEach((d) => {
      const u = d.data();
      if (me && u.uid === me.uid) return;
      if (mode === "VIEWER") {
        if (u.role === "owner") allowedUids.add(u.uid);
      } else {
        if (u.role === "owner" || u.role === "friend") allowedUids.add(u.uid);
      }
    });
  } catch (err) {
    console.error("[atlas] users fetch failed:", err.code || err);
  }

  const [photos, journals, events] = await Promise.all([
    fetchAllPublic("photos"),
    fetchAllPublic("journals"),
    fetchAllPublic("life_events"),
  ]);
  const inScope = (item) => allowedUids.has(item.uid);
  const recent = (list) => list.filter(inScope).sort((a, b) => itemMillis(b) - itemMillis(a)).slice(0, 100);

  // v3.2: layer in connections-tier items from my real accepted friends (a separate, stricter
  // graph than the role-based `allowedUids` above — see CLAUDE.md's v3.2 section). One scoped
  // query per friend, bounded by friend count, same "many small equality queries" style as the
  // rest of this function.
  const friendUids = await loadMyFriendUids();
  const [connPhotos, connJournals, connEvents] = await Promise.all([
    Promise.all(friendUids.map((uid) => fetchConnectionsFor("photos", uid))),
    Promise.all(friendUids.map((uid) => fetchConnectionsFor("journals", uid))),
    Promise.all(friendUids.map((uid) => fetchConnectionsFor("life_events", uid))),
  ]);

  dbg("connections fetched:", {
    publicPhotos: photos.length, publicJournals: journals.length, publicEvents: events.length,
    friendUids: friendUids.length,
    connPhotos: connPhotos.flat().length, connJournals: connJournals.flat().length, connEvents: connEvents.flat().length,
  });
  connectionsClusters = clusterItems(
    recent(photos).concat(...connPhotos),
    recent(journals).concat(...connJournals),
    recent(events).concat(...connEvents),
    2
  );
  return connectionsClusters;
}

function makeIcon(color) {
  return L.divIcon({
    className: "",
    html: `<div style="width:14px;height:14px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 0 0 3px ${color}40"></div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
}

function collectionChips(collectionIds) {
  return [...collectionIds].map((id) => {
    const c = cachedCollections.find((x) => x.id === id);
    if (!c) return "";
    return `<a href="collection-detail.html?id=${encodeURIComponent(id)}" class="text-[10px] font-code px-2 py-0.5 rounded-full border border-borderNeon text-textGray hover:text-neonPurple hover:border-neonPurple transition-colors">${esc(bi(c, "title"))}</a>`;
  }).join("");
}

function openDetailPanel(cluster) {
  activeDetailCluster = cluster;
  document.getElementById("location-detail-name").textContent = cluster.name;
  document.getElementById("location-detail-counts").innerHTML = `
    <span><i class="fa-solid fa-images mr-1"></i>${cluster.memories} ${i18nT("atlas.legend_memories")}</span>
    <span><i class="fa-solid fa-book mr-1"></i>${cluster.journal} ${i18nT("atlas.legend_journal")}</span>
    <span><i class="fa-solid fa-timeline mr-1"></i>${cluster.journey} ${i18nT("atlas.legend_journey")}</span>`;
  document.getElementById("location-detail-collections").innerHTML = collectionChips(cluster.collectionIds);
  document.getElementById("location-detail-photos").innerHTML = cluster.photos.slice(0, 6)
    .map((url) => `<img src="${esc(url)}" alt="" class="w-full h-16 object-cover rounded-lg">`).join("");
  detailPanel.classList.remove("hidden");
  detailPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

detailClose.addEventListener("click", () => {
  activeDetailCluster = null;
  detailPanel.classList.add("hidden");
});

function renderClusters(clusters, color) {
  markers.forEach((m) => map.removeLayer(m));
  markers = [];
  activeDetailCluster = null;
  detailPanel.classList.add("hidden");

  clusters.forEach((cluster) => {
    const marker = L.marker([cluster.lat, cluster.lon], { icon: makeIcon(color) }).addTo(map);
    // Leaflet's bindTooltip() treats a string as HTML by default (setContent() -> innerHTML) --
    // cluster.name is Firestore-stored free text, so it must be escaped the same as every other
    // HTML-context interpolation in this file.
    marker.bindTooltip(esc(cluster.name), { direction: "top", offset: [0, -8] });
    marker.on("click", () => openDetailPanel(cluster));
    markers.push(marker);
  });

  if (clusters.length) {
    const bounds = L.latLngBounds(clusters.map((c) => [c.lat, c.lon]));
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 12 });
  }
}

// v3.4.1: Saved Places — name-only locations, rendered as cards beside the map. Clicking one
// opens the same detail panel the map pins use (it never needed coordinates).
const placesSection = document.getElementById("saved-places-section");
const placesGrid = document.getElementById("saved-places-grid");

function renderPlaces(places) {
  placesSection.classList.toggle("hidden", places.length === 0);
  placesGrid.replaceChildren(
    ...[...places].sort((a, b) => b.latest - a.latest).map((p) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "text-left rounded-xl border border-borderNeon bg-darkBg/40 p-4 hover:border-neonPurple/60 hover:bg-neonPurple/10 transition-colors";
      el.innerHTML = `
        <p class="text-sm text-white font-semibold flex items-center gap-2 min-w-0"><i class="fa-solid fa-location-dot text-neonPurple text-xs flex-shrink-0"></i><span class="truncate">${esc(p.name)}</span></p>
        ${p.address ? `<p class="text-[11px] font-code text-textGray mt-0.5 truncate">${esc(p.address)}</p>` : ""}
        <p class="text-[10px] font-code text-textGray mt-2 flex flex-wrap gap-x-3 gap-y-0.5">
          <span><i class="fa-solid fa-images mr-1"></i>${p.memories}</span>
          <span><i class="fa-solid fa-book mr-1"></i>${p.journal}</span>
          <span><i class="fa-solid fa-timeline mr-1"></i>${p.journey}</span>
        </p>`;
      el.addEventListener("click", () => openDetailPanel(p));
      return el;
    })
  );
}

async function setScope(scope) {
  activeScope = scope;
  scopeTabs.forEach((btn) => {
    const active = btn.dataset.scope === scope;
    btn.classList.toggle("bg-neonPurple/15", active);
    btn.classList.toggle("text-white", active);
  });

  atlasCount.textContent = i18nT("common.loading");
  const data = scope === "mine" ? await loadMineClusters() : await loadConnectionsClusters();
  renderClusters(data.mapClusters, scope === "mine" ? "#a78bfa" : "#6ea8fe");
  renderPlaces(data.placeClusters);
  const total = data.mapClusters.length + data.placeClusters.length;
  atlasEmpty.classList.toggle("hidden", total > 0);
  atlasCount.textContent = total ? `${total} location${total === 1 ? "" : "s"}` : "";
}

scopeTabs.forEach((btn) => btn.addEventListener("click", () => setScope(btn.dataset.scope)));

function initMap() {
  const isLight = document.documentElement.getAttribute("data-theme") === "light";
  map = L.map("atlas-map", { zoomControl: true }).setView([20, 0], 2);
  L.tileLayer(`https://{s}.basemaps.cartocdn.com/${isLight ? "light_all" : "dark_all"}/{z}/{x}/{y}{r}.png`, {
    attribution: `&copy; <a href="https://www.openstreetmap.org/copyright">${i18nT("atlas.provider_osm")}</a> contributors &copy; <a href="https://carto.com/attributions">${i18nT("atlas.provider_carto")}</a>`,
    maxZoom: 19,
    subdomains: "abcd",
  }).addTo(map);
}

function findClusterForMemory(clusters, memoryId) {
  return clusters.find((c) => c.memoryIds && c.memoryIds.has(memoryId));
}

// Phase 6 deep link: gallery.js's post-save success state links here as
// atlas.html?memory=<encoded-doc-id> to focus the marker for the Memory that was just
// saved/edited. The query param is never trusted as authorization by itself — it's only ever
// resolved against mineClusters, which loadMineClusters() built from fetchMyOnly("photos")'s
// `where("uid","==",myUid)` query, i.e. Firestore/firestore.rules already proved these are the
// signed-in user's own docs before this function ever runs. An id that's missing, belongs to
// someone else, or was trashed (excludeDeleted-equivalent filtering already happened inside
// clusterItems via isDeleted()) simply isn't found here and is silently ignored — no error, no
// data exposure. The query param itself is always stripped via history.replaceState (no new
// history entry) whether or not the id resolved, so a refresh/back never re-triggers it.
async function maybeFocusMemoryFromQuery() {
  const params = new URLSearchParams(location.search);
  const memoryId = params.get("memory");
  if (!memoryId) return;
  params.delete("memory");
  const qs = params.toString();
  history.replaceState(null, "", location.pathname + (qs ? `?${qs}` : "") + location.hash);
  if (activeScope !== "mine" || !mineClusters) return; // deep link only ever targets the owner's own Memories
  const cluster = findClusterForMemory(mineClusters.mapClusters, memoryId);
  if (!cluster) return;
  const idx = mineClusters.mapClusters.indexOf(cluster);
  openDetailPanel(cluster);
  map.flyTo([cluster.lat, cluster.lon], Math.max(map.getZoom(), 14));
  markers[idx]?.openTooltip();
}

onAuthStateChanged(auth, async (user) => {
  if (!map) initMap();
  cachedCollections = await mergeMinePublic("collections");
  await setScope("mine");
  await maybeFocusMemoryFromQuery();
});

// v3.4.2 fix: the cluster caches used to live as long as the page did, so an Atlas kept open
// in a PWA window/background tab never picked up a location added via another page's edit
// modal — even re-clicking the scope tabs returned the stale cache. Returning to a visible
// Atlas now drops both caches and refetches the active scope. A fresh navigation was always
// fresh (module state resets), and bfcache restores already force a reload via auth-guard.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !map || !auth.currentUser) return;
  mineClusters = null;
  connectionsClusters = null;
  setScope(activeScope);
});

// Re-render whatever's already on screen — the collection chips (bilingual title_en/title_zh)
// and the open detail panel's legend labels both depend on the current language, and neither
// re-renders on its own from a plain data-i18n walk since they're injected via innerHTML.
document.addEventListener("eden:langchange", () => {
  const data = activeScope === "mine" ? mineClusters : connectionsClusters;
  const reopen = activeDetailCluster;
  if (data) {
    renderClusters(data.mapClusters, activeScope === "mine" ? "#a78bfa" : "#6ea8fe");
    renderPlaces(data.placeClusters);
  }
  if (reopen) openDetailPanel(reopen);
});
