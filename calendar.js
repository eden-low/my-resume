import { auth, db } from "./firebase-init.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import { collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

const monthLabel = document.getElementById("cal-month-label");
const calGrid = document.getElementById("cal-grid");
const prevBtn = document.getElementById("cal-prev");
const nextBtn = document.getElementById("cal-next");

let viewDate = new Date();
viewDate.setDate(1);

function toDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Fetches the signed-in user's own docs only — no date-range filter server-side (an
// equality + range combo would need a composite index), bucketed by day client-side instead.
async function fetchMine(collectionName) {
  const user = auth.currentUser;
  if (!user) return [];
  try {
    const snap = await getDocs(query(collection(db, collectionName), where("uid", "==", user.uid)));
    return snap.docs.map((d) => d.data());
  } catch (err) {
    console.error(`[calendar] ${collectionName} fetch failed:`, err.code || err);
    return [];
  }
}

async function renderMonth() {
  monthLabel.textContent = viewDate.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  const [expenses, photos, journals] = await Promise.all([
    fetchMine("expenses"),
    fetchMine("photos"),
    fetchMine("journals"),
  ]);

  const byDay = new Map();
  function addItem(dateField, item, render) {
    const d = item[dateField]?.toDate?.();
    if (!d || d.getFullYear() !== viewDate.getFullYear() || d.getMonth() !== viewDate.getMonth()) return;
    const key = toDateKey(d);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(render(item));
  }

  expenses.forEach((e) => addItem("createdAt", e, (item) => `💰 RM ${Number(item.amount || 0).toFixed(0)}`));
  photos.forEach((p) => addItem("uploadedAt", p, () => `📷 Photo`));
  journals.forEach((j) => addItem("createdAt", j, (item) => `📝 ${item.title || "Entry"}`));

  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstWeekday = new Date(year, month, 1).getDay();
  const todayKey = toDateKey(new Date());

  const cells = [];
  for (let i = 0; i < firstWeekday; i++) {
    cells.push(`<div class="min-h-[90px] rounded-lg bg-darkBg/20"></div>`);
  }
  for (let day = 1; day <= daysInMonth; day++) {
    const key = toDateKey(new Date(year, month, day));
    const items = byDay.get(key) || [];
    const isToday = key === todayKey;
    cells.push(`
      <div class="min-h-[90px] rounded-lg border ${isToday ? "border-neonPurple/60 bg-neonPurple/5" : "border-borderNeon/60 bg-darkBg/30"} p-1.5 flex flex-col gap-0.5 overflow-hidden">
        <span class="text-[10px] font-code ${isToday ? "text-neonPurple font-bold" : "text-textGray"}">${day}</span>
        ${items.slice(0, 3).map((t) => `<span class="text-[9px] text-white leading-tight truncate">${t}</span>`).join("")}
        ${items.length > 3 ? `<span class="text-[9px] text-textGray">+${items.length - 3} more</span>` : ""}
      </div>`);
  }

  calGrid.innerHTML = cells.join("");
}

prevBtn.addEventListener("click", () => {
  viewDate.setMonth(viewDate.getMonth() - 1);
  renderMonth();
});
nextBtn.addEventListener("click", () => {
  viewDate.setMonth(viewDate.getMonth() + 1);
  renderMonth();
});

onAuthStateChanged(auth, (user) => {
  if (!user) return;
  renderMonth();
});
