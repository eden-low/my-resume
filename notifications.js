import { auth, db, isOwner } from "./firebase-init.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import {
  collection,
  query,
  where,
  getDocs,
  doc,
  updateDoc,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

export const TYPE_META = {
  login: { icon: "fa-right-to-bracket", color: "text-neonBlue", bg: "bg-neonBlue/10" },
  expense_alert: { icon: "fa-wallet", color: "text-rose-400", bg: "bg-rose-400/10" },
  journal_reminder: { icon: "fa-book", color: "text-amber-400", bg: "bg-amber-400/10" },
  habit_streak: { icon: "fa-fire", color: "text-amber-400", bg: "bg-amber-400/10" },
  gallery: { icon: "fa-heart", color: "text-neonPurple", bg: "bg-neonPurple/10" },
};

const accessNote = document.getElementById("notif-access-note");
const listEl = document.getElementById("notif-list");
const emptyEl = document.getElementById("notif-empty");
const markAllBtn = document.getElementById("mark-all-read-btn");

let cachedNotifs = [];

function formatTimestamp(ts) {
  if (!ts?.toDate) return "";
  return ts.toDate().toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function notifCard(n) {
  const meta = TYPE_META[n.type] || TYPE_META.login;
  const el = document.createElement("div");
  el.className = `is-visible flex items-start gap-3 p-4 rounded-xl border ${n.read ? "border-borderNeon/40 bg-darkBg/30" : "border-neonPurple/40 bg-neonPurple/5"}`;
  el.innerHTML = `
    <div class="w-9 h-9 rounded-lg ${meta.bg} ${meta.color} flex items-center justify-center flex-shrink-0"><i class="fa-solid ${meta.icon}"></i></div>
    <div class="flex-1 min-w-0">
      <div class="flex items-center gap-2">
        ${!n.read ? '<span class="w-1.5 h-1.5 rounded-full bg-neonPurple flex-shrink-0"></span>' : ""}
        <p class="text-sm font-semibold">${n.title}</p>
      </div>
      <p class="text-xs text-textGray mt-1">${n.message}</p>
      <p class="text-[10px] font-code text-textGray/70 mt-1.5">${formatTimestamp(n.createdAt)}</p>
    </div>
    ${!n.read ? `<button class="mark-read-btn flex-shrink-0 px-2.5 py-1 rounded-lg text-[10px] font-code text-textGray hover:text-neonPurple border border-borderNeon hover:border-neonPurple/50 transition-colors">Mark read</button>` : ""}`;

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
  if (!isOwner(user)) {
    accessNote.classList.remove("hidden");
    cachedNotifs = [];
    renderNotifs();
    return;
  }
  accessNote.classList.add("hidden");
  try {
    const snap = await getDocs(query(collection(db, "notifications"), where("uid", "==", user.uid)));
    cachedNotifs = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
  } catch (err) {
    console.error("[notifications] fetch failed:", err.code || err);
    cachedNotifs = [];
  }
  renderNotifs();
}

onAuthStateChanged(auth, (user) => {
  if (!user) return;
  fetchNotifications(user);
});
