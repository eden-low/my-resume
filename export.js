import { auth, db } from "./firebase-init.js";
import { collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

// Available to any signed-in user now (everyone has their own private space) — exports
// always mean "my own docs", never anyone else's, even their public ones.

const SETTINGS_KEY = "lfj:settings";

const exportStatus = document.getElementById("export-status");

function setStatus(text) {
  exportStatus.textContent = text;
}

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

function isoDate(ts) {
  return ts?.toDate ? ts.toDate().toISOString() : null;
}

// Exports are always "my own docs" (uid == me) — same scoping as dashboard.js's analytics.
async function fetchMyCollection(name) {
  const user = auth.currentUser;
  if (!user) return [];
  try {
    const snap = await getDocs(query(collection(db, name), where("uid", "==", user.uid)));
    return snap.docs.map((d) => d.data());
  } catch (err) {
    console.error(`[export] ${name} query failed:`, err.code || err);
    return [];
  }
}

function csvEscape(value) {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function exportExpensesCsv() {
  setStatus("Exporting expenses...");
  const expenses = await fetchMyCollection("expenses");
  const rows = [["date", "amount", "category", "note"]];
  expenses
    .sort((a, b) => (a.createdAt?.toMillis?.() || 0) - (b.createdAt?.toMillis?.() || 0))
    .forEach((e) => {
      rows.push([
        e.createdAt?.toDate?.().toISOString().slice(0, 10) || "",
        Number(e.amount || 0).toFixed(2),
        e.category || "",
        e.note || "",
      ]);
    });
  const csv = rows.map((row) => row.map(csvEscape).join(",")).join("\n");
  downloadFile("expenses.csv", csv, "text/csv");
  setStatus("Expenses exported.");
}

async function exportJournalMarkdown() {
  setStatus("Exporting journal...");
  const entries = await fetchMyCollection("journals");
  const blocks = entries
    .sort((a, b) => (a.createdAt?.toMillis?.() || 0) - (b.createdAt?.toMillis?.() || 0))
    .map((e) => {
      const date = e.createdAt?.toDate?.().toLocaleDateString(undefined, { dateStyle: "medium" }) || "";
      const tags = (e.tags || []).map((t) => `#${t}`).join(" ");
      return `# ${e.title}\n${date}\n${e.mood || ""}\n${tags}\n\n${e.content || ""}`;
    });
  downloadFile("journal.md", blocks.join("\n\n---\n\n"), "text/markdown");
  setStatus("Journal exported.");
}

async function exportTimelineJson() {
  setStatus("Exporting timeline...");
  const events = await fetchMyCollection("life_events");
  const data = events.map((e) => ({ ...e, date: isoDate(e.date) }));
  downloadFile("timeline.json", JSON.stringify(data, null, 2), "application/json");
  setStatus("Timeline exported.");
}

async function exportGalleryJson() {
  setStatus("Exporting gallery metadata...");
  const photos = await fetchMyCollection("photos");
  const data = photos.map((p) => ({ ...p, uploadedAt: isoDate(p.uploadedAt) }));
  downloadFile("gallery_metadata.json", JSON.stringify(data, null, 2), "application/json");
  setStatus("Gallery metadata exported.");
}

async function exportFullBackup() {
  setStatus("Building full backup...");
  const user = auth.currentUser;
  const [expenses, journals, timeline, photos, habits] = await Promise.all([
    fetchMyCollection("expenses"),
    fetchMyCollection("journals"),
    fetchMyCollection("life_events"),
    fetchMyCollection("photos"),
    fetchMyCollection("habits"),
  ]);

  let settings = {};
  try {
    settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
  } catch {
    settings = {};
  }

  const backup = {
    profile: {
      uid: user.uid,
      email: user.email,
      displayName: user.displayName,
      photoURL: user.photoURL,
      creationTime: user.metadata?.creationTime || null,
      lastSignInTime: user.metadata?.lastSignInTime || null,
    },
    settings,
    expenses: expenses.map((e) => ({ ...e, createdAt: isoDate(e.createdAt) })),
    journals: journals.map((j) => ({ ...j, createdAt: isoDate(j.createdAt) })),
    timeline: timeline.map((t) => ({ ...t, date: isoDate(t.date) })),
    gallery_metadata: photos.map((p) => ({ ...p, uploadedAt: isoDate(p.uploadedAt) })),
    habits: habits.map((h) => ({ ...h, createdAt: isoDate(h.createdAt) })),
  };

  downloadFile("personal_os_backup.json", JSON.stringify(backup, null, 2), "application/json");
  setStatus("Full backup downloaded.");
}

document.getElementById("export-expenses-btn").addEventListener("click", () => exportExpensesCsv().catch((err) => { console.error(err); setStatus("Export failed — check console."); }));
document.getElementById("export-journal-btn").addEventListener("click", () => exportJournalMarkdown().catch((err) => { console.error(err); setStatus("Export failed — check console."); }));
document.getElementById("export-timeline-btn").addEventListener("click", () => exportTimelineJson().catch((err) => { console.error(err); setStatus("Export failed — check console."); }));
document.getElementById("export-gallery-btn").addEventListener("click", () => exportGalleryJson().catch((err) => { console.error(err); setStatus("Export failed — check console."); }));
document.getElementById("export-backup-btn").addEventListener("click", () => exportFullBackup().catch((err) => { console.error(err); setStatus("Export failed — check console."); }));
