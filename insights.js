import { auth, db } from "./firebase-init.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import { collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

const CATEGORY_META = {
  food: { label: "Food", hex: "#fbbf24" },
  transport: { label: "Transport", hex: "#6ea8fe" },
  shopping: { label: "Shopping", hex: "#a78bfa" },
  bills: { label: "Bills", hex: "#fb7185" },
  other: { label: "Other", hex: "#34d399" },
};

function cap(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "—";
}

async function fetchMine(collectionName) {
  const user = auth.currentUser;
  if (!user) return [];
  try {
    const snap = await getDocs(query(collection(db, collectionName), where("uid", "==", user.uid)));
    return snap.docs.map((d) => d.data());
  } catch (err) {
    console.error(`[insights] ${collectionName} fetch failed:`, err.code || err);
    return [];
  }
}

function isThisMonth(ts, now) {
  const d = ts?.toDate?.();
  return !!d && d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
}

let categoryChart, weekdayChart;

async function renderReport() {
  const now = new Date();
  document.getElementById("report-month-label").textContent =
    `${now.toLocaleDateString(undefined, { month: "long", year: "numeric" })} Report`;

  const [expenses, photos, journals] = await Promise.all([
    fetchMine("expenses"),
    fetchMine("photos"),
    fetchMine("journals"),
  ]);

  const monthExpenses = expenses.filter((e) => isThisMonth(e.createdAt, now));
  const monthPhotos = photos.filter((p) => isThisMonth(p.uploadedAt, now));
  const monthJournals = journals.filter((j) => isThisMonth(j.createdAt, now));

  const total = monthExpenses.reduce((sum, e) => sum + Number(e.amount || 0), 0);
  document.getElementById("rpt-total").textContent = `RM ${total.toFixed(2)}`;
  document.getElementById("rpt-photos").textContent = monthPhotos.length;
  document.getElementById("rpt-journals").textContent = monthJournals.length;

  const categoryTotals = {};
  monthExpenses.forEach((e) => {
    categoryTotals[e.category] = (categoryTotals[e.category] || 0) + Number(e.amount || 0);
  });
  const topCategory = Object.entries(categoryTotals).sort((a, b) => b[1] - a[1])[0]?.[0];
  document.getElementById("rpt-top-category").textContent = cap(topCategory);

  const catKeys = Object.keys(categoryTotals);
  categoryChart?.destroy();
  categoryChart = new Chart(document.getElementById("report-category-chart").getContext("2d"), {
    type: "doughnut",
    data: {
      labels: catKeys.map((k) => CATEGORY_META[k]?.label || k),
      datasets: [{
        data: catKeys.map((k) => categoryTotals[k]),
        backgroundColor: catKeys.map((k) => CATEGORY_META[k]?.hex || "#9793ab"),
        borderColor: "#17151f",
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "65%",
      plugins: { legend: { position: "bottom", labels: { color: "#9793ab", font: { size: 10 }, boxWidth: 10 } } },
    },
  });

  // Weekend vs weekday: compared as an average per elapsed day in each bucket (not raw totals),
  // since a month always has more weekdays than weekend days.
  let weekdayTotal = 0, weekendTotal = 0, weekdayDays = new Set(), weekendDays = new Set();
  monthExpenses.forEach((e) => {
    const d = e.createdAt?.toDate?.();
    if (!d) return;
    const isWeekend = d.getDay() === 0 || d.getDay() === 6;
    if (isWeekend) {
      weekendTotal += Number(e.amount || 0);
      weekendDays.add(d.getDate());
    } else {
      weekdayTotal += Number(e.amount || 0);
      weekdayDays.add(d.getDate());
    }
  });
  const weekdayAvg = weekdayDays.size ? weekdayTotal / weekdayDays.size : 0;
  const weekendAvg = weekendDays.size ? weekendTotal / weekendDays.size : 0;

  weekdayChart?.destroy();
  weekdayChart = new Chart(document.getElementById("report-weekday-chart").getContext("2d"), {
    type: "bar",
    data: {
      labels: ["Weekday avg/day", "Weekend avg/day"],
      datasets: [{
        data: [weekdayAvg, weekendAvg],
        backgroundColor: ["rgba(110,168,254,0.55)", "rgba(251,113,133,0.55)"],
        borderRadius: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { color: "#9793ab", font: { size: 10 } } },
        y: { grid: { color: "rgba(255,255,255,0.06)" }, ticks: { color: "#9793ab", font: { size: 10 } } },
      },
    },
  });

  const warning = document.getElementById("weekend-warning");
  const warningText = document.getElementById("weekend-warning-text");
  if (weekendAvg > weekdayAvg && weekendDays.size > 0) {
    warningText.textContent = `You're spending more on weekends (RM ${weekendAvg.toFixed(2)}/day) than weekdays (RM ${weekdayAvg.toFixed(2)}/day) this month.`;
    warning.classList.remove("hidden");
  } else {
    warning.classList.add("hidden");
  }
}

onAuthStateChanged(auth, (user) => {
  if (!user) return;
  renderReport();
});
