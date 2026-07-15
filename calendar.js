import { auth, db } from "./firebase-init.js";
import { getLang } from "./js/i18n.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import { collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import { excludeDeleted } from "./js/memory-filters.js";

const monthLabel = document.getElementById("cal-month-label");
const calGrid = document.getElementById("cal-grid");
const calWeekdays = document.getElementById("cal-weekdays");
const prevBtn = document.getElementById("cal-prev");
const nextBtn = document.getElementById("cal-next");

let viewDate = new Date();
viewDate.setDate(1);

// Every other page's toLocaleDateString/toLocaleString call still passes `undefined` (browser
// default) rather than reading the app's own language choice — this is the one page asked to
// fix that, since a month grid full of English weekday/month names while the rest of the UI is
// in Chinese would be the most visible mismatch in the app.
function dateLocale() {
  return getLang() === "zh-CN" ? "zh-CN" : undefined;
}

function toDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Renders short weekday headers (Sun..Sat) in the app's current language. 1970-01-04 was a
// Sunday, so offsetting from it sidesteps needing today's actual weekday.
function renderWeekdayHeaders() {
  if (!calWeekdays) return;
  const fmt = new Intl.DateTimeFormat(dateLocale(), { weekday: "short" });
  const labels = Array.from({ length: 7 }, (_, i) => fmt.format(new Date(1970, 0, 4 + i)));
  calWeekdays.innerHTML = labels.map((l) => `<span>${l}</span>`).join("");
}

// Fetches the signed-in user's own docs only — no date-range filter server-side (an
// equality + range combo would need a composite index), bucketed by day client-side instead.
async function fetchMine(collectionName) {
  const user = auth.currentUser;
  if (!user) return [];
  try {
    const snap = await getDocs(query(collection(db, collectionName), where("uid", "==", user.uid)));
    // Trashed Memories never show up on the day grid — a no-op for expenses/journals, neither
    // of which carry deletedAt.
    return excludeDeleted(snap.docs.map((d) => d.data()));
  } catch (err) {
    console.error(`[calendar] ${collectionName} fetch failed:`, err.code || err);
    return [];
  }
}

let cachedMonthData = { expenses: [], photos: [], journals: [] };

async function loadMonth() {
  const [expenses, photos, journals] = await Promise.all([
    fetchMine("expenses"),
    fetchMine("photos"),
    fetchMine("journals"),
  ]);
  cachedMonthData = { expenses, photos, journals };
  renderMonth();
}

// Pure render from cachedMonthData — safe to call again on a language switch without
// re-fetching from Firestore.
function renderMonth() {
  monthLabel.textContent = viewDate.toLocaleDateString(dateLocale(), { month: "long", year: "numeric" });
  renderWeekdayHeaders();

  const { expenses, photos, journals } = cachedMonthData;
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
  loadMonth();
});
nextBtn.addEventListener("click", () => {
  viewDate.setMonth(viewDate.getMonth() + 1);
  loadMonth();
});

onAuthStateChanged(auth, (user) => {
  if (!user) return;
  loadMonth();
});

// Re-render the month label, weekday headers, and grid from the already-fetched
// cachedMonthData whenever the language switcher fires — no Firestore re-fetch needed.
document.addEventListener("eden:langchange", () => {
  renderMonth();
});
