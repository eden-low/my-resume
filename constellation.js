// Memory Constellation (v3.1 prototype) — a calm, static radial map of how a person's life
// chapters connect. Deliberately not a force-directed graph engine (the brief allows a static
// radial layout or a card-based fallback if a real graph gets too complex) — positions are
// computed once from plain trigonometry and never re-simulated, so there's no physics engine,
// no drag-to-rearrange, nothing that could jitter or feel busy.
//
// Owner-only for now (see CLAUDE.md): this reads across every personal collection at once
// (Collections/Memories/Journal/Journey/Career), which is a wider personal-data surface than
// any single existing page touches, so it's scoped to the account owner rather than opened to
// Friends until the product decides that's wanted. Every query below is uid == myUid — no
// public/friend data is ever read, mirroring Calendar/Reports/Me-Overview's "personal-only"
// query shape (see CLAUDE.md's core query pattern bullet).
import { auth, googleProvider, db, isOwner } from "./firebase-init.js";
import {
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import { collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import { t } from "./js/i18n.js";
import { resolveDisplayName } from "./js/identity.js";

const authControl = document.getElementById("auth-control");
const ownerNote = document.getElementById("constellation-owner-note");
const bodyEl = document.getElementById("constellation-body");
const emptyEl = document.getElementById("constellation-empty");
const emptyActionsEl = document.getElementById("constellation-empty-actions");
const canvas = document.getElementById("constellation-canvas");
const linesSvg = document.getElementById("constellation-lines");
const nodesEl = document.getElementById("constellation-nodes");

const panelEmpty = document.getElementById("constellation-panel-empty");
const panel = document.getElementById("constellation-panel");
const panelIcon = document.getElementById("panel-icon");
const panelTitle = document.getElementById("panel-title");
const panelType = document.getElementById("panel-type");
const panelCount = document.getElementById("panel-count");
const panelRelated = document.getElementById("panel-related");
const panelOpenBtn = document.getElementById("panel-open-btn");

const TYPE_META = {
  memory: { icon: "fa-image", key: "constellation.node_memory" },
  journal: { icon: "fa-book", key: "constellation.node_journal" },
  journey: { icon: "fa-timeline", key: "constellation.node_journey" },
  career: { icon: "fa-briefcase", key: "constellation.node_career" },
};

async function fetchMine(name) {
  const user = auth.currentUser;
  if (!user) return [];
  try {
    const snap = await getDocs(query(collection(db, name), where("uid", "==", user.uid)));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.error(`[constellation] ${name} fetch failed:`, err.code || err);
    return [];
  }
}

function itemTitle(kind, item) {
  if (kind === "memory") return item.caption || t("common.untitled");
  if (kind === "journal") return item.title || t("common.untitled");
  if (kind === "journey") return item.title || t("common.untitled");
  if (kind === "career") return item.title_en || item.title_zh || t("common.untitled");
  return t("common.untitled");
}

function itemDateMillis(kind, item) {
  const ts = kind === "memory" ? item.uploadedAt : kind === "career" ? item.createdAt : item.createdAt || item.date;
  return ts?.toMillis?.() || 0;
}

// ---- Build the node/edge graph from already-fetched data ----

function buildGraph({ collections, photos, journals, events, projects }) {
  const byCollection = new Map(); // collectionId|null -> { memory:[], journal:[], journey:[], career:[] }
  function bucket(collectionId) {
    const key = collectionId || null;
    if (!byCollection.has(key)) byCollection.set(key, { memory: [], journal: [], journey: [], career: [] });
    return byCollection.get(key);
  }
  photos.forEach((p) => bucket(p.collectionId).memory.push(p));
  journals.forEach((j) => bucket(j.collectionId).journal.push(j));
  events.forEach((e) => bucket(e.collectionId).journey.push(e));
  projects.forEach((p) => bucket(p.collectionId).career.push(p));

  const nodes = [];
  const edges = [];

  // Center hub — purely visual anchor, not clickable.
  nodes.push({ id: "hub", ring: 0, kind: "hub", label: "" });

  const ring1 = [];
  collections.forEach((c) => {
    const items = byCollection.get(c.id) || { memory: [], journal: [], journey: [], career: [] };
    ring1.push({
      id: `col:${c.id}`,
      ring: 1,
      kind: "collection",
      label: c.title_en || c.title_zh || t("common.untitled"),
      icon: c.icon ? `fa-${c.icon}` : "fa-layer-group",
      color: c.color || "#a78bfa",
      count: items.memory.length + items.journal.length + items.journey.length + items.career.length,
      items,
      openHref: `collection-detail.html?id=${encodeURIComponent(c.id)}`,
    });
  });

  const uncategorized = byCollection.get(null);
  const uncategorizedTotal = uncategorized ? uncategorized.memory.length + uncategorized.journal.length + uncategorized.journey.length + uncategorized.career.length : 0;
  if (uncategorizedTotal > 0) {
    ring1.push({
      id: "col:uncategorized",
      ring: 1,
      kind: "uncategorized",
      label: t("common.uncategorized"),
      icon: "fa-shapes",
      color: "#9793ab",
      count: uncategorizedTotal,
      items: uncategorized,
      openHref: "collection-detail.html?id=uncategorized",
    });
  }

  const angleStep1 = (Math.PI * 2) / Math.max(1, ring1.length);
  ring1.forEach((node, i) => {
    node.angle = -Math.PI / 2 + i * angleStep1;
    node.radius = 28;
    nodes.push(node);
    edges.push({ from: "hub", to: node.id });

    const types = Object.keys(TYPE_META).filter((k) => node.items[k].length > 0);
    const spread = Math.min(0.5, 0.14 * (types.length - 1));
    types.forEach((typeKey, j) => {
      const offset = types.length > 1 ? -spread + (j * (2 * spread)) / (types.length - 1) : 0;
      const satId = `${node.id}:${typeKey}`;
      const satNode = {
        id: satId,
        ring: 2,
        kind: "type",
        typeKey,
        parentId: node.id,
        label: t(TYPE_META[typeKey].key),
        icon: TYPE_META[typeKey].icon,
        color: node.color,
        count: node.items[typeKey].length,
        angle: node.angle + offset,
        radius: 42,
        openHref: node.openHref,
        relatedItems: [...node.items[typeKey]]
          .sort((a, b) => itemDateMillis(typeKey, b) - itemDateMillis(typeKey, a))
          .slice(0, 5)
          .map((it) => itemTitle(typeKey, it)),
      };
      nodes.push(satNode);
      edges.push({ from: node.id, to: satId });
    });
  });

  // Locations (v3.1: "small secondary nodes if locationName exists") — capped at 8 for a calm,
  // readable outer ring rather than one dot per place someone has ever logged.
  const locCounts = new Map();
  [...photos, ...journals, ...events].forEach((item) => {
    if (!item.locationName) return;
    if (!locCounts.has(item.locationName)) locCounts.set(item.locationName, { count: 0, titles: [] });
    const entry = locCounts.get(item.locationName);
    entry.count++;
    if (entry.titles.length < 5) {
      entry.titles.push(item.caption || item.title || t("common.untitled"));
    }
  });
  const locations = [...locCounts.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 8);

  const angleStep3 = (Math.PI * 2) / Math.max(1, locations.length);
  locations.forEach(([name, info], i) => {
    const locId = `loc:${name}`;
    const locNode = {
      id: locId,
      ring: 3,
      kind: "location",
      label: name,
      icon: "fa-location-dot",
      color: "#6ea8fe",
      count: info.count,
      angle: -Math.PI / 2 + angleStep3 * i + angleStep3 / 2,
      radius: 46,
      openHref: "atlas.html",
      relatedItems: info.titles,
    };
    nodes.push(locNode);
    edges.push({ from: "hub", to: locId, faint: true });
  });

  return { nodes, edges, totalItems: photos.length + journals.length + events.length + projects.length + collections.length };
}

// ---- Render ----

function nodeSizeClass(node) {
  if (node.ring === 1) return "w-14 h-14 text-base";
  if (node.ring === 2) return "w-9 h-9 text-xs";
  return "w-8 h-8 text-[11px]";
}

function posFor(node) {
  if (node.ring === 0) return { x: 50, y: 50 };
  const x = 50 + node.radius * Math.cos(node.angle);
  const y = 50 + node.radius * Math.sin(node.angle);
  return { x, y };
}

let currentGraph = null;
let selectedId = null;
let cachedRaw = null; // { collections, photos, journals, events, projects } — refetched only on load, not on language change
const nodeEls = new Map();
const lineEls = new Map();

function render(graph) {
  currentGraph = graph;
  const positions = new Map();
  graph.nodes.forEach((n) => positions.set(n.id, posFor(n)));

  linesSvg.innerHTML = "";
  nodeEls.clear();
  lineEls.clear();

  graph.edges.forEach((edge) => {
    const a = positions.get(edge.from);
    const b = positions.get(edge.to);
    if (!a || !b) return;
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", a.x);
    line.setAttribute("y1", a.y);
    line.setAttribute("x2", b.x);
    line.setAttribute("y2", b.y);
    line.setAttribute("stroke", edge.faint ? "rgba(151,147,171,0.18)" : "rgba(167,139,250,0.35)");
    line.setAttribute("stroke-width", edge.faint ? "0.25" : "0.35");
    line.setAttribute("vector-effect", "non-scaling-stroke");
    linesSvg.appendChild(line);
    lineEls.set(`${edge.from}|${edge.to}`, line);
  });

  nodesEl.classList.remove("skeleton");
  nodesEl.replaceChildren(
    ...graph.nodes.map((node) => {
      const pos = positions.get(node.id);
      if (node.kind === "hub") {
        const hub = document.createElement("div");
        hub.className = "absolute w-6 h-6 rounded-full bg-gradient-to-tr from-neonViolet to-neonPurple shadow-lg shadow-neonPurple/30";
        hub.style.left = `${pos.x}%`;
        hub.style.top = `${pos.y}%`;
        hub.style.transform = "translate(-50%,-50%)";
        return hub;
      }
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `constellation-node absolute flex flex-col items-center justify-center rounded-full border transition-all ${nodeSizeClass(node)}`;
      btn.style.left = `${pos.x}%`;
      btn.style.top = `${pos.y}%`;
      btn.style.transform = "translate(-50%,-50%)";
      btn.style.borderColor = node.color || "#2a2833";
      btn.style.background = "rgba(23,21,31,0.9)";
      btn.style.color = node.color || "#9793ab";
      btn.title = node.label;
      btn.innerHTML = `<i class="fa-solid ${node.icon}"></i>`;
      btn.addEventListener("click", () => selectNode(node.id));
      nodeEls.set(node.id, btn);
      return btn;
    })
  );

  applySelectionStyles();
}

function connectedIds(id) {
  if (!currentGraph) return new Set([id]);
  const set = new Set([id]);
  currentGraph.edges.forEach((e) => {
    if (e.from === id) set.add(e.to);
    if (e.to === id) set.add(e.from);
  });
  return set;
}

function applySelectionStyles() {
  const related = selectedId ? connectedIds(selectedId) : null;
  nodeEls.forEach((el, id) => {
    const isSelected = id === selectedId;
    const dim = related && !related.has(id);
    el.style.opacity = dim ? "0.3" : "1";
    el.classList.toggle("ring-2", isSelected);
    el.classList.toggle("ring-white/70", isSelected);
    el.classList.toggle("scale-110", isSelected);
  });
  lineEls.forEach((line, key) => {
    const [from, to] = key.split("|");
    const dim = related && !(related.has(from) && related.has(to));
    line.style.opacity = dim ? "0.15" : "1";
  });
}

function findNode(id) {
  return currentGraph?.nodes.find((n) => n.id === id) || null;
}

function selectNode(id) {
  selectedId = id;
  applySelectionStyles();
  renderPanel(findNode(id));
}

function renderPanel(node) {
  if (!node) {
    panel.classList.add("hidden");
    panelEmpty.classList.remove("hidden");
    return;
  }
  panelEmpty.classList.add("hidden");
  panel.classList.remove("hidden");

  panelIcon.innerHTML = `<i class="fa-solid ${node.icon}"></i>`;
  panelIcon.style.color = node.color || "#a78bfa";
  panelTitle.textContent = node.label;
  const typeLabel = node.kind === "collection" ? t("constellation.node_collection")
    : node.kind === "uncategorized" ? t("common.uncategorized")
    : node.kind === "location" ? t("constellation.node_location")
    : t(TYPE_META[node.typeKey]?.key || "constellation.node_memory");
  panelType.textContent = typeLabel;
  panelCount.textContent = node.count ?? 0;

  panelRelated.replaceChildren();
  if (node.kind === "collection" || node.kind === "uncategorized") {
    Object.keys(TYPE_META).forEach((typeKey) => {
      const row = document.createElement("div");
      row.className = "flex items-center justify-between";
      row.innerHTML = `<span class="flex items-center gap-1.5 text-textGray"><i class="fa-solid ${TYPE_META[typeKey].icon} w-3.5 text-center"></i>${t(TYPE_META[typeKey].key)}</span><span class="font-code">${node.items[typeKey].length}</span>`;
      panelRelated.appendChild(row);
    });
  } else if (node.relatedItems?.length) {
    node.relatedItems.forEach((title) => {
      const row = document.createElement("div");
      row.className = "truncate";
      row.textContent = `• ${title}`;
      panelRelated.appendChild(row);
    });
  } else {
    const row = document.createElement("div");
    row.className = "text-textGray";
    row.textContent = t("common.none_yet");
    panelRelated.appendChild(row);
  }

  panelOpenBtn.href = node.openHref || "#";
}

// ---- Auth / access gate ----

function renderSignedOut() {
  authControl.innerHTML = `
    <button id="auth-signin-btn" class="px-4 py-2 bg-gradient-to-r from-neonViolet to-neonPurple rounded-xl text-xs font-cyber font-bold tracking-wider text-white hover:scale-105 transition-all">
      <i class="fa-brands fa-google mr-2"></i> ${t("common.sign_in")}
    </button>`;
  document.getElementById("auth-signin-btn").addEventListener("click", () => {
    signInWithPopup(auth, googleProvider).catch((err) => console.error("Sign-in failed", err));
  });
}

async function renderSignedIn(user) {
  const name = await resolveDisplayName(user);
  authControl.innerHTML = `
    <span class="text-xs text-textGray font-code">${t("common.signed_in_as")} <span class="text-white">${name}</span></span>
    <button id="auth-signout-btn" class="px-4 py-2 bg-cardBg/70 border border-borderNeon rounded-xl text-xs font-cyber font-bold tracking-wider text-white hover:border-neonPurple transition-all">
      ${t("common.sign_out")}
    </button>`;
  document.getElementById("auth-signout-btn").addEventListener("click", () => signOut(auth));
}

function renderFromCache() {
  if (!cachedRaw) return;
  const graph = buildGraph(cachedRaw);
  if (graph.totalItems === 0) {
    bodyEl.classList.add("hidden");
    emptyEl.classList.remove("hidden");
    emptyActionsEl.classList.remove("hidden");
    return;
  }
  bodyEl.classList.remove("hidden");
  emptyEl.classList.add("hidden");
  emptyActionsEl.classList.add("hidden");
  selectedId = null;
  renderPanel(null);
  render(graph);
}

async function loadAndRender() {
  const [collections, photos, journals, events, projects] = await Promise.all([
    fetchMine("collections"),
    fetchMine("photos"),
    fetchMine("journals"),
    fetchMine("life_events"),
    fetchMine("career_projects"),
  ]);
  cachedRaw = { collections, photos, journals, events, projects };
  renderFromCache();
}

onAuthStateChanged(auth, (user) => {
  if (user) {
    renderSignedIn(user);
    if (!isOwner(user)) {
      ownerNote.classList.remove("hidden");
      bodyEl.classList.add("hidden");
      emptyEl.classList.add("hidden");
      emptyActionsEl.classList.add("hidden");
      return;
    }
    ownerNote.classList.add("hidden");
    loadAndRender();
  } else {
    renderSignedOut();
  }
});

document.addEventListener("eden:langchange", () => {
  const user = auth.currentUser;
  if (user) renderSignedIn(user);
  // Re-render from the cached fetch — labels are the only thing translated, no refetch needed.
  renderFromCache();
});
