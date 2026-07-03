import { auth, googleProvider, db, isOwner } from "./firebase-init.js";
import {
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import {
  collection,
  query,
  where,
  getDocs,
  addDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

const CATEGORY_META = {
  food: { label: "Food", hex: "#fbbf24", text: "text-amber-400", bg: "bg-amber-400/10", border: "border-amber-400/30" },
  transport: { label: "Transport", hex: "#6ea8fe", text: "text-neonBlue", bg: "bg-neonBlue/10", border: "border-neonBlue/30" },
  shopping: { label: "Shopping", hex: "#a78bfa", text: "text-neonPurple", bg: "bg-neonPurple/10", border: "border-neonPurple/30" },
  bills: { label: "Bills", hex: "#fb7185", text: "text-rose-400", bg: "bg-rose-400/10", border: "border-rose-400/30" },
  other: { label: "Other", hex: "#34d399", text: "text-emerald-400", bg: "bg-emerald-400/10", border: "border-emerald-400/30" },
};

const authControl = document.getElementById("auth-control");
const accessNote = document.getElementById("expense-access-note");
const expenseList = document.getElementById("expense-list");
const expenseEmpty = document.getElementById("expense-empty");
const filterTabs = document.querySelectorAll(".filter-tab");
const privateTab = document.querySelector('.filter-tab[data-filter="private"]');
const newExpenseBtn = document.getElementById("new-expense-btn");
const expenseModal = document.getElementById("expense-modal");
const expenseModalClose = document.getElementById("expense-modal-close");
const expenseModalBackdrop = document.getElementById("expense-modal-backdrop");
const expenseForm = document.getElementById("expense-form");
const expenseStatus = document.getElementById("expense-status");

let cachedExpenses = [];
let activeFilter = "all";
let dailyChart = null;
let categoryChart = null;

function formatTimestamp(ts) {
  if (!ts?.toDate) return "";
  return ts.toDate().toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function dayKey(ts) {
  if (!ts?.toDate) return null;
  return ts.toDate().toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function expenseRow(expense) {
  const meta = CATEGORY_META[expense.category] || CATEGORY_META.other;
  const isPrivate = expense.visibility === "private";

  const row = document.createElement("article");
  row.className = "is-visible bg-cardBg/90 neon-border-purple rounded-2xl p-4 flex items-center justify-between gap-4";
  row.innerHTML = `
    <div class="flex items-center gap-3 min-w-0">
      <div class="w-9 h-9 rounded-lg ${meta.bg} ${meta.text} flex items-center justify-center text-xs font-code font-bold flex-shrink-0 border ${meta.border}">${meta.label.slice(0, 2).toUpperCase()}</div>
      <div class="min-w-0">
        <p class="text-sm font-medium truncate">${expense.note || meta.label}</p>
        <p class="text-[11px] text-textGray mt-0.5 font-code">${formatTimestamp(expense.createdAt)}</p>
      </div>
    </div>
    <div class="flex items-center gap-3 flex-shrink-0">
      <span class="text-[10px] font-code px-2 py-0.5 rounded-full border ${isPrivate ? "border-rose-400/30 bg-rose-400/10 text-rose-400" : "border-emerald-400/30 bg-emerald-400/10 text-emerald-400"}">
        <i class="fa-solid ${isPrivate ? "fa-lock" : "fa-globe"} mr-1"></i>${isPrivate ? "Private" : "Public"}
      </span>
      <span class="font-code font-semibold text-sm tabular-nums">RM ${Number(expense.amount).toFixed(2)}</span>
    </div>`;
  return row;
}

function renderList() {
  const visible = activeFilter === "all"
    ? cachedExpenses
    : activeFilter === "public" || activeFilter === "private"
      ? cachedExpenses.filter((e) => e.visibility === activeFilter)
      : cachedExpenses.filter((e) => e.category === activeFilter);

  expenseList.replaceChildren(...visible.map(expenseRow));
  expenseEmpty.classList.toggle("hidden", visible.length > 0);
}

function renderCharts() {
  const dailyTotals = new Map();
  cachedExpenses.forEach((e) => {
    const key = dayKey(e.createdAt);
    if (!key) return;
    dailyTotals.set(key, (dailyTotals.get(key) || 0) + Number(e.amount));
  });
  const dailyLabels = [...dailyTotals.keys()].slice(-7);
  const dailyValues = dailyLabels.map((k) => dailyTotals.get(k));

  const categoryTotals = {};
  cachedExpenses.forEach((e) => {
    categoryTotals[e.category] = (categoryTotals[e.category] || 0) + Number(e.amount);
  });
  const categoryKeys = Object.keys(categoryTotals);

  dailyChart?.destroy();
  dailyChart = new Chart(document.getElementById("daily-chart").getContext("2d"), {
    type: "bar",
    data: {
      labels: dailyLabels,
      datasets: [{
        data: dailyValues,
        backgroundColor: "rgba(167,139,250,0.55)",
        borderRadius: 6,
        maxBarThickness: 28,
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

  categoryChart?.destroy();
  categoryChart = new Chart(document.getElementById("category-chart").getContext("2d"), {
    type: "doughnut",
    data: {
      labels: categoryKeys.map((k) => CATEGORY_META[k]?.label || k),
      datasets: [{
        data: categoryKeys.map((k) => categoryTotals[k]),
        backgroundColor: categoryKeys.map((k) => CATEGORY_META[k]?.hex || "#9793ab"),
        borderColor: "#17151f",
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "65%",
      plugins: {
        legend: { position: "bottom", labels: { color: "#9793ab", font: { size: 10 }, boxWidth: 10 } },
      },
    },
  });
}

function setActiveTab(filter) {
  activeFilter = filter;
  filterTabs.forEach((btn) => {
    const active = btn.dataset.filter === filter;
    btn.classList.toggle("text-white", active);
    btn.classList.toggle("bg-neonPurple/15", active);
  });
  renderList();
}

filterTabs.forEach((btn) => btn.addEventListener("click", () => setActiveTab(btn.dataset.filter)));
setActiveTab("all");

async function fetchVisibleExpenses() {
  const expenses = [];

  const publicSnap = await getDocs(query(collection(db, "expenses"), where("visibility", "==", "public")));
  publicSnap.forEach((doc) => expenses.push(doc.data()));

  if (auth.currentUser) {
    try {
      const privateSnap = await getDocs(query(collection(db, "expenses"), where("visibility", "==", "private")));
      privateSnap.forEach((doc) => expenses.push(doc.data()));
      accessNote.classList.add("hidden");
      privateTab.classList.remove("hidden");
    } catch (err) {
      console.error("[expenses] private query failed:", err.code || err);
      accessNote.classList.remove("hidden");
      privateTab.classList.add("hidden");
      if (activeFilter === "private") setActiveTab("all");
    }
  }

  expenses.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
  cachedExpenses = expenses;
  renderList();
  renderCharts();
}

function renderSignedOut() {
  authControl.innerHTML = `
    <button id="auth-signin-btn" class="px-4 py-2 bg-gradient-to-r from-neonViolet to-neonPurple rounded-xl text-xs font-cyber font-bold tracking-wider text-white hover:scale-105 transition-all">
      <i class="fa-brands fa-google mr-2"></i> SIGN IN
    </button>`;
  document.getElementById("auth-signin-btn").addEventListener("click", () => {
    signInWithPopup(auth, googleProvider).catch((err) => console.error("Sign-in failed", err));
  });
  accessNote.classList.add("hidden");
  privateTab.classList.add("hidden");
  newExpenseBtn.classList.add("hidden");
  if (activeFilter === "private") setActiveTab("all");
}

function renderSignedIn(user) {
  authControl.innerHTML = `
    <span class="text-xs text-textGray font-code">Signed in as <span class="text-white">${user.displayName || user.email}</span></span>
    <button id="auth-signout-btn" class="px-4 py-2 bg-cardBg/70 border border-borderNeon rounded-xl text-xs font-cyber font-bold tracking-wider text-white hover:border-neonPurple transition-all">
      SIGN OUT
    </button>`;
  document.getElementById("auth-signout-btn").addEventListener("click", () => signOut(auth));

  newExpenseBtn.classList.toggle("hidden", !isOwner(user));
}

onAuthStateChanged(auth, (user) => {
  if (user) {
    renderSignedIn(user);
  } else {
    renderSignedOut();
  }
  fetchVisibleExpenses();
});

function openModal() {
  expenseModal.classList.remove("hidden");
}
function closeModal() {
  expenseModal.classList.add("hidden");
  expenseForm.reset();
  expenseStatus.textContent = "";
}

newExpenseBtn.addEventListener("click", openModal);
expenseModalClose.addEventListener("click", closeModal);
expenseModalBackdrop.addEventListener("click", closeModal);

expenseForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const user = auth.currentUser;
  if (!isOwner(user)) return;

  const amount = parseFloat(document.getElementById("expense-amount").value);
  const note = document.getElementById("expense-note").value.trim();
  const category = document.getElementById("expense-category").value;
  const visibility = expenseForm.querySelector('input[name="expense-visibility"]:checked').value;
  if (!amount || amount <= 0) return;

  expenseStatus.textContent = "Saving...";
  try {
    await addDoc(collection(db, "expenses"), {
      amount,
      category,
      note,
      visibility,
      createdAt: serverTimestamp(),
      uid: user.uid,
    });

    expenseStatus.textContent = "Saved.";
    await fetchVisibleExpenses();
    closeModal();
  } catch (err) {
    console.error("Save failed", err);
    expenseStatus.textContent = "Save failed — check console.";
  }
});
