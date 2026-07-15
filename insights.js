import { auth, db } from "./firebase-init.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import { collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import { t, getLang } from "./js/i18n.js";
import { excludeDeleted } from "./js/memory-filters.js";

function downloadFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const CATEGORY_META = {
  food: { key: "food", hex: "#fbbf24" },
  transport: { key: "transport", hex: "#6ea8fe" },
  shopping: { key: "shopping", hex: "#a78bfa" },
  bills: { key: "bills", hex: "#fb7185" },
  other: { key: "other", hex: "#34d399" },
};

function categoryLabel(key) {
  return t(`finance.category_${key}`) || cap(key);
}

function cap(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "—";
}

async function fetchMine(collectionName) {
  const user = auth.currentUser;
  if (!user) return [];
  try {
    const snap = await getDocs(query(collection(db, collectionName), where("uid", "==", user.uid)));
    // Trashed Memories never count toward Reports' stat cards/Monthly Story/Year in Review —
    // a no-op for every other collection this is called with, none of which carry deletedAt.
    return excludeDeleted(snap.docs.map((d) => d.data()));
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
    `${now.toLocaleDateString(getLang() === "zh-CN" ? "zh-CN" : undefined, { month: "long", year: "numeric" })} ${t("reports.title")}`;

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
  document.getElementById("rpt-top-category").textContent = topCategory ? categoryLabel(topCategory) : "—";

  const catKeys = Object.keys(categoryTotals);
  categoryChart?.destroy();
  categoryChart = new Chart(document.getElementById("report-category-chart").getContext("2d"), {
    type: "doughnut",
    data: {
      labels: catKeys.map((k) => categoryLabel(k)),
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
      labels: [t("reports.weekday_avg"), t("reports.weekend_avg")],
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
    warningText.textContent = t("reports.weekend_warning", { weekend: weekendAvg.toFixed(2), weekday: weekdayAvg.toFixed(2) });
    warning.classList.remove("hidden");
  } else {
    warning.classList.add("hidden");
  }
}

// ---- Shared data fetch for Reflections/Monthly Story/Year in Review ----

let allData = null;

async function loadAllForStory() {
  const [expenses, photos, journals, habits, events, collections, careerProjects, capsules, reflections] = await Promise.all([
    fetchMine("expenses"), fetchMine("photos"), fetchMine("journals"), fetchMine("habits"),
    fetchMine("life_events"), fetchMine("collections"), fetchMine("career_projects"),
    fetchMine("time_capsules"), fetchMine("daily_reflections"),
  ]);
  allData = { expenses, photos, journals, habits, events, collections, careerProjects, capsules, reflections };
  return allData;
}

function inMonth(dateField, list, year, month) {
  return list.filter((item) => {
    const d = item[dateField]?.toDate?.();
    return d && d.getFullYear() === year && d.getMonth() === month;
  });
}

function inYear(dateField, list, year) {
  return list.filter((item) => {
    const d = item[dateField]?.toDate?.();
    return d && d.getFullYear() === year;
  });
}

function distinctLocations(list) {
  return new Set(list.map((item) => item.locationName).filter(Boolean));
}

function longestConsecutiveRun(dateKeys) {
  const days = [...new Set(dateKeys)].sort();
  if (!days.length) return 0;
  let longest = 1, run = 1;
  for (let i = 1; i < days.length; i++) {
    const prev = new Date(days[i - 1]);
    const cur = new Date(days[i]);
    const diff = Math.round((cur - prev) / 86400000);
    run = diff === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
  return longest;
}

function activityQualifier(total, lang) {
  if (lang === "zh-CN") {
    if (total >= 20) return "扎实成长";
    if (total >= 8) return "稳步推进";
    return "静谧";
  }
  return total >= 20 ? "a month of steady progress" : total >= 8 ? "a quietly productive month" : "a calm month";
}

function joinEn(clauses) {
  if (!clauses.length) return "";
  if (clauses.length === 1) return clauses[0];
  return `${clauses.slice(0, -1).join(", ")}, and ${clauses[clauses.length - 1]}`;
}

// ---- Daily Reflection summary ----

function renderReflectionsSummary() {
  const section = document.getElementById("reflection-summary-section");
  const reflections = allData?.reflections || [];
  const now = new Date();
  const monthReflections = reflections.filter((r) => r.dateKey && r.dateKey.startsWith(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`));
  section.classList.toggle("hidden", monthReflections.length === 0);
  if (!monthReflections.length) return;
  document.getElementById("reflection-days-count").textContent = monthReflections.length;
  const counts = {};
  monthReflections.forEach((r) => { counts[r.mood] = (counts[r.mood] || 0) + 1; });
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
  document.getElementById("reflection-top-mood").textContent = top ? t(`reflection.mood_${top}`) : "—";
}

// ---- Monthly Story ----

let storyDate = new Date();

function statTile(label, value) {
  return `<div><p class="text-textGray">${label}</p><p class="text-white font-semibold mt-0.5">${value}</p></div>`;
}

function computeMonthlyStats(year, month) {
  const memories = inMonth("uploadedAt", allData.photos, year, month);
  const journals = inMonth("createdAt", allData.journals, year, month);
  const expenses = inMonth("createdAt", allData.expenses, year, month);
  const collectionsUpdated = allData.collections.filter((c) => {
    const d = (c.updatedAt || c.createdAt)?.toDate?.();
    return d && d.getFullYear() === year && d.getMonth() === month;
  });
  const capsuleActivity = allData.capsules.filter((c) => {
    const created = c.createdAt?.toDate?.();
    const opened = c.status === "opened" ? c.updatedAt?.toDate?.() : null;
    return (created && created.getFullYear() === year && created.getMonth() === month)
        || (opened && opened.getFullYear() === year && opened.getMonth() === month);
  });
  const reflections = (allData.reflections || []).filter((r) => r.dateKey && r.dateKey.startsWith(`${year}-${String(month + 1).padStart(2, "0")}`));
  const locations = distinctLocations([...memories, ...journals, ...inMonth("date", allData.events, year, month)]);
  const monthKey = `${year}-${String(month + 1).padStart(2, "0")}`;
  const monthHabitCheckins = allData.habits.reduce((sum, h) => sum + (h.completedDates || []).filter((d) => d.startsWith(monthKey)).length, 0);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const habitsPct = allData.habits.length ? Math.round((monthHabitCheckins / (allData.habits.length * daysInMonth)) * 100) : null;
  const expenseTotal = expenses.reduce((sum, e) => sum + Number(e.amount || 0), 0);

  return {
    memories: memories.length, journals: journals.length, expenseTotal,
    habitsPct, collectionsUpdated: collectionsUpdated.length, locations: locations.size,
    capsules: capsuleActivity.length, reflections: reflections.length,
    total: memories.length + journals.length + expenses.length,
  };
}

function buildMonthlyStoryText(stats, monthLabel, lang) {
  if (stats.total === 0 && !stats.reflections && !stats.collectionsUpdated) return t("reports.monthly_story.empty");
  const qualifier = activityQualifier(stats.total, lang);
  if (lang === "zh-CN") {
    const clauses = [`新增了 ${stats.memories} 段回忆`, `写下 ${stats.journals} 篇日记`];
    if (stats.habitsPct !== null) clauses.push(`习惯完成度达到 ${stats.habitsPct}%`);
    if (stats.expenseTotal > 0) clauses.push(`记录了 RM ${stats.expenseTotal.toFixed(2)} 的支出`);
    if (stats.locations > 0) clauses.push(`到访了 ${stats.locations} 个地方`);
    if (stats.collectionsUpdated > 0) clauses.push(`更新了 ${stats.collectionsUpdated} 个收藏集`);
    if (stats.capsules > 0) clauses.push(`时间胶囊也有了新的进展`);
    if (stats.reflections > 0) clauses.push(`记录了 ${stats.reflections} 天的心情`);
    return `${monthLabel}是${qualifier}的一个月。你${clauses.join("，")}。`;
  }
  const clauses = [`added ${stats.memories} memories`, `wrote ${stats.journals} journals`];
  if (stats.habitsPct !== null) clauses.push(`kept your habits at ${stats.habitsPct}% completion`);
  if (stats.expenseTotal > 0) clauses.push(`recorded RM ${stats.expenseTotal.toFixed(2)} in expenses`);
  if (stats.locations > 0) clauses.push(`visited ${stats.locations} place${stats.locations === 1 ? "" : "s"}`);
  if (stats.collectionsUpdated > 0) clauses.push(`updated ${stats.collectionsUpdated} collection${stats.collectionsUpdated === 1 ? "" : "s"}`);
  if (stats.capsules > 0) clauses.push("kept your time capsules moving");
  if (stats.reflections > 0) clauses.push(`checked in with yourself on ${stats.reflections} day${stats.reflections === 1 ? "" : "s"}`);
  return `${monthLabel} was ${qualifier}. You ${joinEn(clauses)}.`;
}

function renderMonthlyStory() {
  if (!allData) return;
  const lang = getLang();
  const year = storyDate.getFullYear();
  const month = storyDate.getMonth();
  const monthLabel = storyDate.toLocaleDateString(lang === "zh-CN" ? "zh-CN" : undefined, { month: "long", year: "numeric" });
  document.getElementById("story-month-label").textContent = monthLabel;

  const stats = computeMonthlyStats(year, month);
  document.getElementById("story-paragraph").textContent = buildMonthlyStoryText(stats, monthLabel, lang);
  document.getElementById("story-stats").innerHTML = [
    statTile(t("reports.monthly_story.memories_count"), stats.memories),
    statTile(t("reports.monthly_story.journal_count"), stats.journals),
    statTile(t("reports.monthly_story.finance_total"), `RM ${stats.expenseTotal.toFixed(2)}`),
    statTile(t("reports.monthly_story.habits_completion"), stats.habitsPct === null ? "—" : `${stats.habitsPct}%`),
    statTile(t("reports.monthly_story.locations_visited"), stats.locations),
    statTile(t("reports.monthly_story.collections_updated"), stats.collectionsUpdated),
    statTile(t("reports.monthly_story.capsules_activity"), stats.capsules),
    statTile(t("reports.monthly_story.reflections_count"), stats.reflections),
  ].join("");
}

document.getElementById("story-prev").addEventListener("click", () => {
  storyDate = new Date(storyDate.getFullYear(), storyDate.getMonth() - 1, 1);
  renderMonthlyStory();
});
document.getElementById("story-next").addEventListener("click", () => {
  storyDate = new Date(storyDate.getFullYear(), storyDate.getMonth() + 1, 1);
  renderMonthlyStory();
});
document.getElementById("story-export-btn").addEventListener("click", () => {
  const lang = getLang();
  const monthLabel = document.getElementById("story-month-label").textContent;
  const paragraph = document.getElementById("story-paragraph").textContent;
  const md = `# ${t("reports.monthly_story.title")} — ${monthLabel}\n\n${paragraph}\n`;
  downloadFile(`monthly-story-${storyDate.getFullYear()}-${storyDate.getMonth() + 1}.md`, md, "text/markdown");
});

// ---- Year in Review ----

let reviewYear = new Date().getFullYear();

function computeYearStats(year) {
  const memories = inYear("uploadedAt", allData.photos, year);
  const journals = inYear("createdAt", allData.journals, year);
  const expenses = inYear("createdAt", allData.expenses, year);
  const projects = inYear("createdAt", allData.careerProjects, year);
  const capsulesCreated = inYear("createdAt", allData.capsules, year);
  const capsulesOpened = allData.capsules.filter((c) => c.status === "opened" && c.updatedAt?.toDate?.()?.getFullYear() === year);
  const reflections = (allData.reflections || []).filter((r) => r.dateKey && r.dateKey.startsWith(String(year)));
  const events = inYear("date", allData.events, year);

  const locationCounts = {};
  [...memories, ...journals, ...events].forEach((item) => {
    if (item.locationName) locationCounts[item.locationName] = (locationCounts[item.locationName] || 0) + 1;
  });
  const topLocations = Object.entries(locationCounts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name]) => name);

  const collectionLabel = (c) => (getLang() === "zh-CN" ? c.title_zh || c.title_en : c.title_en || c.title_zh) || "";
  const topCollections = inYear("createdAt", allData.collections, year).slice(0, 3).map(collectionLabel).filter(Boolean);

  const monthTotals = Array(12).fill(0);
  [...memories, ...journals, ...expenses].forEach((item) => {
    const d = (item.uploadedAt || item.createdAt)?.toDate?.();
    if (d) monthTotals[d.getMonth()]++;
  });
  const mostActiveMonthIdx = monthTotals.indexOf(Math.max(...monthTotals));
  const mostActiveMonth = Math.max(...monthTotals) > 0
    ? new Date(year, mostActiveMonthIdx, 1).toLocaleDateString(getLang() === "zh-CN" ? "zh-CN" : undefined, { month: "long" })
    : null;

  const longestStreak = allData.habits.length
    ? Math.max(0, ...allData.habits.map((h) => longestConsecutiveRun((h.completedDates || []).filter((d) => d.startsWith(String(year))))))
    : 0;

  const moodCounts = {};
  reflections.forEach((r) => { moodCounts[r.mood] = (moodCounts[r.mood] || 0) + 1; });
  const topMood = Object.entries(moodCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  return {
    totalMemories: memories.length, totalJournals: journals.length, totalExpenses: expenses.length,
    topCollections, topLocations, longestStreak, mostActiveMonth, careerProjects: projects.length,
    capsulesCreated: capsulesCreated.length, capsulesOpened: capsulesOpened.length,
    topMood, reflectionDays: reflections.length,
    total: memories.length + journals.length + expenses.length,
  };
}

function buildYearInReviewText(stats, year, lang) {
  if (stats.total === 0) return t("reports.year_review.empty");
  if (lang === "zh-CN") {
    const clauses = [`新增了 ${stats.totalMemories} 段回忆`, `写下 ${stats.totalJournals} 篇日记`, `记录了 ${stats.totalExpenses} 笔支出`];
    if (stats.longestStreak > 0) clauses.push(`习惯最长连续坚持了 ${stats.longestStreak} 天`);
    if (stats.mostActiveMonth) clauses.push(`最活跃的月份是 ${stats.mostActiveMonth}`);
    if (stats.careerProjects > 0) clauses.push(`新增了 ${stats.careerProjects} 个项目`);
    if (stats.topLocations.length) clauses.push(`留下足迹的地方包括 ${stats.topLocations.join("、")}`);
    if (stats.topMood) clauses.push(`最常出现的心情是「${t("reflection.mood_" + stats.topMood)}」`);
    return `${year} 是持续建设、学习与记录人生章节的一年。你${clauses.join("，")}。`;
  }
  const clauses = [`added ${stats.totalMemories} memories`, `wrote ${stats.totalJournals} journals`, `recorded ${stats.totalExpenses} expenses`];
  if (stats.longestStreak > 0) clauses.push(`kept a habit streak of ${stats.longestStreak} day${stats.longestStreak === 1 ? "" : "s"}`);
  if (stats.mostActiveMonth) clauses.push(`were most active in ${stats.mostActiveMonth}`);
  if (stats.careerProjects > 0) clauses.push(`added ${stats.careerProjects} new project${stats.careerProjects === 1 ? "" : "s"} to your Career`);
  if (stats.topLocations.length) clauses.push(`left footprints in ${stats.topLocations.join(", ")}`);
  if (stats.topMood) clauses.push(`felt "${t("reflection.mood_" + stats.topMood)}" more than anything else`);
  return `${year} was a year of building, learning, and recording meaningful chapters. You ${joinEn(clauses)}.`;
}

function renderYearInReview() {
  if (!allData) return;
  const lang = getLang();
  document.getElementById("review-year-label").textContent = String(reviewYear);
  const stats = computeYearStats(reviewYear);
  document.getElementById("review-paragraph").textContent = buildYearInReviewText(stats, reviewYear, lang);
  document.getElementById("review-stats").innerHTML = [
    statTile(t("reports.year_review.total_memories"), stats.totalMemories),
    statTile(t("reports.year_review.total_journals"), stats.totalJournals),
    statTile(t("reports.year_review.total_expenses"), stats.totalExpenses),
    statTile(t("reports.year_review.longest_streak"), stats.longestStreak),
    statTile(t("reports.year_review.most_active_month"), stats.mostActiveMonth || "—"),
    statTile(t("reports.year_review.career_projects"), stats.careerProjects),
    statTile(t("reports.year_review.top_locations"), stats.topLocations.join(", ") || "—"),
    statTile(t("reports.year_review.top_collections"), stats.topCollections.join(", ") || "—"),
  ].join("");
}

document.getElementById("review-prev").addEventListener("click", () => {
  reviewYear -= 1;
  renderYearInReview();
});
document.getElementById("review-next").addEventListener("click", () => {
  reviewYear += 1;
  renderYearInReview();
});
document.getElementById("review-export-btn").addEventListener("click", () => {
  const paragraph = document.getElementById("review-paragraph").textContent;
  const md = `# ${t("reports.year_review.title")} — ${reviewYear}\n\n${paragraph}\n`;
  downloadFile(`year-in-review-${reviewYear}.md`, md, "text/markdown");
});
document.getElementById("review-print-btn").addEventListener("click", () => window.print());

document.addEventListener("eden:langchange", () => {
  renderReflectionsSummary();
  renderMonthlyStory();
  renderYearInReview();
});

onAuthStateChanged(auth, async (user) => {
  if (!user) return;
  renderReport();
  await loadAllForStory();
  renderReflectionsSummary();
  renderMonthlyStory();
  renderYearInReview();
});
