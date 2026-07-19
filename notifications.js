import { auth, db } from "./firebase-init.js";
import { t } from "./js/i18n.js";
import { publicDisplayName, formatHandle } from "./js/identity.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import {
  collection,
  query,
  where,
  getDocs,
  doc,
  getDoc,
  updateDoc,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

// Security audit fix: n.title/n.message can embed other users' free text (e.g. gallery.js's
// "like" notification embeds the liked post's caption verbatim into its message), and
// publicDisplayName(actor) is a Firestore-stored displayName/username — every interpolation
// into innerHTML below must be escaped. Same implementation as calendar.js's pre-existing esc().
function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export const TYPE_META = {
  login: { icon: "fa-right-to-bracket", color: "text-neonBlue", bg: "bg-neonBlue/10" },
  expense_alert: { icon: "fa-wallet", color: "text-rose-400", bg: "bg-rose-400/10" },
  journal_reminder: { icon: "fa-book", color: "text-amber-400", bg: "bg-amber-400/10" },
  habit_streak: { icon: "fa-fire", color: "text-amber-400", bg: "bg-amber-400/10" },
  gallery: { icon: "fa-heart", color: "text-neonPurple", bg: "bg-neonPurple/10" },
  capsule_ready: { icon: "fa-box-archive", color: "text-neonPurple", bg: "bg-neonPurple/10" },
  friend_request: { icon: "fa-user-plus", color: "text-neonPurple", bg: "bg-neonPurple/10" },
  friend_accepted: { icon: "fa-user-check", color: "text-emerald-400", bg: "bg-emerald-400/10" },
};

// friend_request/friend_accepted are the only two notification types with somewhere useful to
// jump to — everything else is informational only.
const LINKED_TYPES = new Set(["friend_request", "friend_accepted"]);

const listEl = document.getElementById("notif-list");
const emptyEl = document.getElementById("notif-empty");
const markAllBtn = document.getElementById("mark-all-read-btn");

let cachedNotifs = [];

// fromUid -> users/{uid} doc data (or null if missing/failed), for LINKED_TYPES notifications
// only — lets the actor's avatar/name/@username link straight to profile.html, same
// u=username-preferred / uid-fallback resolution dashboard.js's personCard() uses.
const actorCache = new Map();

async function fetchActor(uid) {
  if (actorCache.has(uid)) return actorCache.get(uid);
  let data = null;
  try {
    const snap = await getDoc(doc(db, "users", uid));
    if (snap.exists()) data = snap.data();
  } catch (err) {
    console.error("[notifications] actor fetch failed:", err.code || err);
  }
  actorCache.set(uid, data);
  return data;
}

function actorProfileUrl(actor) {
  if (!actor?.uid) return null;
  return actor.username
    ? `profile.html?u=${encodeURIComponent(actor.username)}`
    : `profile.html?uid=${encodeURIComponent(actor.uid)}`;
}

function formatTimestamp(ts) {
  if (!ts?.toDate) return "";
  return ts.toDate().toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function notifCard(n) {
  const meta = TYPE_META[n.type] || TYPE_META.login;
  const actor = LINKED_TYPES.has(n.type) && n.fromUid ? actorCache.get(n.fromUid) : null;
  const profileUrl = actorProfileUrl(actor);
  const handle = actor ? formatHandle(actor.username) : "";

  const el = document.createElement("div");
  el.className = `is-visible flex items-start gap-3 p-4 rounded-xl border ${n.read ? "border-borderNeon/40 bg-darkBg/30" : "border-neonPurple/40 bg-neonPurple/5"}`;

  // Actor avatar (clickable) when we could resolve one, otherwise the plain type icon.
  const avatarHtml = profileUrl
    ? `<a href="${esc(profileUrl)}" class="w-9 h-9 rounded-full bg-neonPurple/10 flex items-center justify-center text-neonPurple overflow-hidden flex-shrink-0 hover:opacity-80 transition-opacity" title="${t("people.open_profile")}">
        ${actor.photoURL ? `<img src="${esc(actor.photoURL)}" class="w-full h-full object-cover">` : `<i class="fa-solid fa-user text-xs"></i>`}
      </a>`
    : `<div class="w-9 h-9 rounded-lg ${meta.bg} ${meta.color} flex items-center justify-center flex-shrink-0"><i class="fa-solid ${meta.icon}"></i></div>`;

  const actorNameHtml = profileUrl
    ? `<a href="${esc(profileUrl)}" class="inline-flex items-center gap-1.5 min-w-0 hover:underline">
        <span class="text-sm font-semibold text-white truncate">${esc(publicDisplayName(actor))}</span>
        ${handle ? `<span class="text-[11px] text-textGray font-code truncate">${esc(handle)}</span>` : ""}
      </a>`
    : "";

  el.innerHTML = `
    ${avatarHtml}
    <div class="flex-1 min-w-0">
      ${actorNameHtml}
      <div class="flex items-center gap-2 ${actorNameHtml ? "mt-0.5" : ""}">
        ${!n.read ? '<span class="w-1.5 h-1.5 rounded-full bg-neonPurple flex-shrink-0"></span>' : ""}
        <p class="text-sm ${actorNameHtml ? "text-textGray" : "font-semibold"}">${esc(n.title)}</p>
      </div>
      <p class="text-xs text-textGray mt-1">${esc(n.message)}</p>
      <p class="text-[10px] font-code text-textGray/70 mt-1.5">${formatTimestamp(n.createdAt)}</p>
      <div class="flex items-center gap-3 mt-1.5">
        ${LINKED_TYPES.has(n.type) ? `<a href="dashboard.html" class="text-[10px] font-code text-neonPurple hover:underline">${t("inbox.view")}</a>` : ""}
        ${profileUrl ? `<a href="${esc(profileUrl)}" class="text-[10px] font-code text-neonPurple hover:underline">${t("people.open_profile")}</a>` : ""}
      </div>
    </div>
    ${!n.read ? `<button class="mark-read-btn flex-shrink-0 px-2.5 py-1 rounded-lg text-[10px] font-code text-textGray hover:text-neonPurple border border-borderNeon hover:border-neonPurple/50 transition-colors">${t("common.mark_read")}</button>` : ""}`;

  const btn = el.querySelector(".mark-read-btn");
  if (btn) btn.addEventListener("click", () => markRead(n));
  return el;
}

function renderNotifs() {
  listEl.replaceChildren(...cachedNotifs.map(notifCard));
  emptyEl.classList.toggle("hidden", cachedNotifs.length > 0);
  markAllBtn.classList.toggle("hidden", !cachedNotifs.some((n) => !n.read));
}

async function markRead(n) {
  try {
    await updateDoc(doc(db, "notifications", n.id), { read: true });
    n.read = true;
    renderNotifs();
  } catch (err) {
    console.error("[notifications] mark read failed:", err.code || err);
  }
}

markAllBtn.addEventListener("click", async () => {
  const unread = cachedNotifs.filter((n) => !n.read);
  await Promise.all(unread.map((n) => updateDoc(doc(db, "notifications", n.id), { read: true }).catch((err) => console.error("[notifications] bulk mark read failed:", err.code || err))));
  unread.forEach((n) => (n.read = true));
  renderNotifs();
});

async function fetchNotifications(user) {
  try {
    const snap = await getDocs(query(collection(db, "notifications"), where("uid", "==", user.uid)));
    cachedNotifs = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
  } catch (err) {
    console.error("[notifications] fetch failed:", err.code || err);
    cachedNotifs = [];
  }

  const actorUids = [...new Set(cachedNotifs.filter((n) => LINKED_TYPES.has(n.type) && n.fromUid).map((n) => n.fromUid))];
  await Promise.all(actorUids.map(fetchActor));

  renderNotifs();
}

onAuthStateChanged(auth, (user) => {
  if (!user) return;
  fetchNotifications(user);
});

// Re-render from the already-fetched cachedNotifs — no refetch — since notifCard() embeds a
// translated "Mark read" button per unread item.
document.addEventListener("eden:langchange", () => {
  renderNotifs();
});
