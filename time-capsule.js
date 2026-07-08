import { auth, googleProvider, db, storage, canParticipate } from "./firebase-init.js";
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
  doc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
  Timestamp,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import { ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-storage.js";
import { t } from "./js/i18n.js";
import { resolveDisplayName } from "./js/identity.js";

const authControl = document.getElementById("auth-control");
const accessNote = document.getElementById("capsule-access-note");
const newCapsuleBtn = document.getElementById("new-capsule-btn");
const capsuleModal = document.getElementById("capsule-modal");
const capsuleModalClose = document.getElementById("capsule-modal-close");
const capsuleModalBackdrop = document.getElementById("capsule-modal-backdrop");
const capsuleForm = document.getElementById("capsule-form");
const capsuleStatus = document.getElementById("capsule-status");
const capsuleEditModal = document.getElementById("capsule-edit-modal");
const capsuleEditModalClose = document.getElementById("capsule-edit-modal-close");
const capsuleEditModalBackdrop = document.getElementById("capsule-edit-modal-backdrop");
const capsuleEditForm = document.getElementById("capsule-edit-form");
const capsuleEditStatus = document.getElementById("capsule-edit-status");
const emptyEl = document.getElementById("capsules-empty");
const readyEl = document.getElementById("capsules-ready");
const sealedEl = document.getElementById("capsules-sealed");
const openedEl = document.getElementById("capsules-opened");
const countSealedEl = document.getElementById("capsule-count-sealed");
const countReadyEl = document.getElementById("capsule-count-ready");
const countOpenedEl = document.getElementById("capsule-count-opened");

let cachedCapsules = [];

// Firestore Timestamps come back as objects with a toDate() method, but a defensive
// fallback (raw {seconds}, a plain Date, or an ISO-ish string) keeps this from silently
// producing "Invalid Date" if a doc's openAt was ever written in a different shape.
function parseOpenAt(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  if (value.seconds) return new Date(value.seconds * 1000);
  if (value instanceof Date) return value;
  return new Date(value);
}

function bucketOf(c) {
  const status = c.status || "sealed";
  if (status === "opened") return "opened";
  const openAt = parseOpenAt(c.openAt);
  if (openAt && openAt <= new Date()) return "ready";
  return "sealed";
}

function formatDate(ts) {
  const d = parseOpenAt(ts);
  return d ? d.toLocaleDateString(undefined, { dateStyle: "medium" }) : "";
}

function dateInputValue(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const BUCKET_BADGE = {
  sealed: { icon: "fa-lock", labelKey: "time_capsule.sealed", classes: "text-textGray bg-textGray/10" },
  ready: { icon: "fa-envelope", labelKey: "time_capsule.ready_to_open", classes: "text-neonPurple bg-neonPurple/10" },
  opened: { icon: "fa-envelope-open", labelKey: "time_capsule.opened", classes: "text-emerald-400 bg-emerald-400/10" },
};

function statusBadge(bucket) {
  const meta = BUCKET_BADGE[bucket];
  return `<span class="inline-flex items-center gap-1.5 text-[10px] font-code uppercase tracking-wide ${meta.classes} px-2 py-0.5 rounded-full"><i class="fa-solid ${meta.icon} text-[9px]"></i>${t(meta.labelKey)}</span>`;
}

function capsuleCard(c) {
  const bucket = bucketOf(c);
  const el = document.createElement("div");
  // "is-visible" (not "reveal"): cards are appended after the page's one-time, load-time
  // IntersectionObserver scan (scripts.js), which never re-observes elements added later —
  // a "reveal" class here would stay at opacity:0 forever. Every other page that renders
  // cards from JS (gallery.js, journal.js, habits.js, etc.) already follows this convention.
  el.className = "is-visible card-lift bg-cardBg/90 neon-border-purple rounded-2xl p-5 flex flex-col gap-3";

  // Sealed capsules deliberately never render `c.message` (it's meant to stay hidden until
  // opened); only the opened bucket shows the actual content.
  let body = "";
  let dateLine = "";
  if (bucket === "sealed") {
    body = `<p class="text-xs font-code text-textGray">${t("time_capsule.locked_notice", { date: formatDate(c.openAt) })}</p>`;
  } else if (bucket === "ready") {
    dateLine = `<p class="text-[10px] font-code text-textGray">${t("time_capsule.open_date_label")}: ${formatDate(c.openAt)}</p>`;
  } else {
    body = `<p class="text-sm text-white/90 whitespace-pre-wrap">${c.message}</p>
      ${c.attachmentUrl ? `<a href="${c.attachmentUrl}" target="_blank" rel="noopener" class="inline-flex items-center gap-1.5 text-xs text-neonPurple hover:underline"><i class="fa-solid fa-paperclip"></i> ${t("time_capsule.attachment_label")}</a>` : ""}`;
    dateLine = `<p class="text-[10px] font-code text-textGray">${t("time_capsule.opened_on", { date: formatDate(c.updatedAt) })}</p>`;
  }

  const actions = [];
  if (bucket === "sealed") {
    actions.push(`<button class="capsule-edit-btn text-textGray hover:text-neonPurple text-xs" title="${t("common.edit_metadata")}"><i class="fa-solid fa-pen"></i></button>`);
  }
  if (bucket === "ready") {
    actions.push(`<button class="capsule-open-btn px-3 py-1.5 bg-gradient-to-r from-neonViolet to-neonPurple rounded-lg text-[11px] font-cyber font-bold tracking-wider text-white hover:scale-105 transition-all">${t("time_capsule.open_button")}</button>`);
  }
  actions.push(`<button class="capsule-delete-btn text-textGray hover:text-rose-400 text-xs" title="${t("common.delete")}"><i class="fa-solid fa-trash"></i></button>`);

  el.innerHTML = `
    <div class="flex items-center justify-between gap-2">
      ${statusBadge(bucket)}
      <div class="flex items-center gap-3">${actions.join("")}</div>
    </div>
    <span class="text-sm font-semibold text-white truncate">${c.title}</span>
    ${body}
    ${dateLine}`;

  if (bucket === "ready") el.querySelector(".capsule-open-btn").addEventListener("click", () => openCapsule(c.id));
  if (bucket === "sealed") el.querySelector(".capsule-edit-btn").addEventListener("click", () => openEditModal(c));
  el.querySelector(".capsule-delete-btn").addEventListener("click", () => deleteCapsule(c.id));

  return el;
}

function renderCapsules() {
  try {
    const ready = cachedCapsules.filter((c) => bucketOf(c) === "ready");
    const sealed = cachedCapsules.filter((c) => bucketOf(c) === "sealed");
    const opened = cachedCapsules.filter((c) => bucketOf(c) === "opened");

    readyEl.replaceChildren(...ready.map(capsuleCard));
    sealedEl.replaceChildren(...sealed.map(capsuleCard));
    openedEl.replaceChildren(...opened.map(capsuleCard));

    readyEl.parentElement.classList.toggle("hidden", ready.length === 0);
    sealedEl.parentElement.classList.toggle("hidden", sealed.length === 0);
    openedEl.parentElement.classList.toggle("hidden", opened.length === 0);
    emptyEl.classList.toggle("hidden", cachedCapsules.length > 0);

    if (countSealedEl) countSealedEl.textContent = String(sealed.length);
    if (countReadyEl) countReadyEl.textContent = String(ready.length);
    if (countOpenedEl) countOpenedEl.textContent = String(opened.length);
  } catch (err) {
    console.error("[time-capsule] render failed:", err);
  }
}

async function openCapsule(id) {
  try {
    await updateDoc(doc(db, "time_capsules", id), { status: "opened", updatedAt: serverTimestamp() });
    const c = cachedCapsules.find((x) => x.id === id);
    if (c) c.status = "opened";
    renderCapsules();
  } catch (err) {
    console.error("[time-capsule] open failed:", err.code || err);
  }
}

async function deleteCapsule(id) {
  if (!confirm(t("common.delete_confirm"))) return;
  try {
    await deleteDoc(doc(db, "time_capsules", id));
    cachedCapsules = cachedCapsules.filter((c) => c.id !== id);
    renderCapsules();
  } catch (err) {
    console.error("[time-capsule] delete failed:", err.code || err);
  }
}

function openEditModal(c) {
  document.getElementById("capsule-edit-id").value = c.id;
  document.getElementById("capsule-edit-title").value = c.title;
  document.getElementById("capsule-edit-message").value = c.message;
  const openAt = parseOpenAt(c.openAt);
  document.getElementById("capsule-edit-open-date").value = openAt ? dateInputValue(openAt) : "";
  capsuleEditStatus.textContent = "";
  capsuleEditModal.classList.remove("hidden");
}
function closeEditModal() {
  capsuleEditModal.classList.add("hidden");
  capsuleEditForm.reset();
  capsuleEditStatus.textContent = "";
}

capsuleEditModalClose.addEventListener("click", closeEditModal);
capsuleEditModalBackdrop.addEventListener("click", closeEditModal);

capsuleEditForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const id = document.getElementById("capsule-edit-id").value;
  const title = document.getElementById("capsule-edit-title").value.trim();
  const message = document.getElementById("capsule-edit-message").value.trim();
  const openDateVal = document.getElementById("capsule-edit-open-date").value;
  if (!id || !title || !message || !openDateVal) return;

  capsuleEditStatus.textContent = t("common.saving");
  try {
    await updateDoc(doc(db, "time_capsules", id), {
      title,
      message,
      openAt: Timestamp.fromDate(new Date(openDateVal)),
      updatedAt: serverTimestamp(),
    });
    const c = cachedCapsules.find((x) => x.id === id);
    if (c) {
      c.title = title;
      c.message = message;
      c.openAt = Timestamp.fromDate(new Date(openDateVal));
    }
    capsuleEditStatus.textContent = t("common.saved");
    renderCapsules();
    setTimeout(closeEditModal, 500);
  } catch (err) {
    console.error("[time-capsule] edit save failed:", err.code || err);
    capsuleEditStatus.textContent = t("common.couldnt_save");
  }
});

async function checkCapsuleReadyNotifications(user) {
  const readyIds = cachedCapsules.filter((c) => bucketOf(c) === "ready").map((c) => c.id);
  for (const id of readyIds) {
    const key = `lfj:capsuleNotified:${id}`;
    if (localStorage.getItem(key)) continue;
    localStorage.setItem(key, "1");
    try {
      await addDoc(collection(db, "notifications"), {
        uid: user.uid,
        type: "capsule_ready",
        title: t("time_capsule.title"),
        message: t("time_capsule.home_ready_card"),
        read: false,
        createdAt: serverTimestamp(),
      });
    } catch (err) {
      console.error("[time-capsule] ready notification failed:", err.code || err);
    }
  }
}

async function fetchCapsules(user) {
  try {
    const snap = await getDocs(query(collection(db, "time_capsules"), where("uid", "==", user.uid)));
    cachedCapsules = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    cachedCapsules.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
  } catch (err) {
    console.error("[time-capsule] fetch failed:", err.code || err);
    cachedCapsules = [];
  }
  renderCapsules();
  checkCapsuleReadyNotifications(user);
}

function renderSignedOut() {
  authControl.innerHTML = `
    <button id="auth-signin-btn" class="px-4 py-2 bg-gradient-to-r from-neonViolet to-neonPurple rounded-xl text-xs font-cyber font-bold tracking-wider text-white hover:scale-105 transition-all">
      <i class="fa-brands fa-google mr-2"></i> ${t("common.sign_in")}
    </button>`;
  document.getElementById("auth-signin-btn").addEventListener("click", () => {
    signInWithPopup(auth, googleProvider).catch((err) => console.error("Sign-in failed", err));
  });
  accessNote.classList.add("hidden");
  newCapsuleBtn.classList.add("hidden");
}

async function renderSignedIn(user) {
  const displayLabel = await resolveDisplayName(user);
  authControl.innerHTML = `
    <span class="text-xs text-textGray font-code">${t("common.signed_in_as")} <span class="text-white truncate max-w-[10rem] inline-block align-bottom">${displayLabel}</span></span>
    <button id="auth-signout-btn" class="px-4 py-2 bg-cardBg/70 border border-borderNeon rounded-xl text-xs font-cyber font-bold tracking-wider text-white hover:border-neonPurple transition-all">
      ${t("common.sign_out")}
    </button>`;
  document.getElementById("auth-signout-btn").addEventListener("click", () => signOut(auth));

  const mayParticipate = canParticipate();
  newCapsuleBtn.classList.toggle("hidden", !mayParticipate);
  accessNote.classList.toggle("hidden", mayParticipate);
  maybeAutoOpenFromQuickAdd(mayParticipate);
}

let autoOpenedFromQuickAdd = false;
function maybeAutoOpenFromQuickAdd(mayParticipate) {
  if (autoOpenedFromQuickAdd || !mayParticipate) return;
  if (new URLSearchParams(location.search).get("new") === "1") {
    autoOpenedFromQuickAdd = true;
    openModal();
  }
}

onAuthStateChanged(auth, (user) => {
  if (user) {
    renderSignedIn(user);
    fetchCapsules(user);
  } else {
    renderSignedOut();
    cachedCapsules = [];
    renderCapsules();
  }
});

function openModal() {
  capsuleModal.classList.remove("hidden");
}
function closeModal() {
  capsuleModal.classList.add("hidden");
  capsuleForm.reset();
  capsuleStatus.textContent = "";
}

newCapsuleBtn.addEventListener("click", openModal);
capsuleModalClose.addEventListener("click", closeModal);
capsuleModalBackdrop.addEventListener("click", closeModal);

capsuleForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const user = auth.currentUser;
  if (!user || !canParticipate()) return;

  const title = document.getElementById("capsule-title").value.trim();
  const message = document.getElementById("capsule-message").value.trim();
  const openDateVal = document.getElementById("capsule-open-date").value;
  const file = document.getElementById("capsule-attachment").files[0];
  if (!title || !message || !openDateVal) return;

  capsuleStatus.textContent = t("common.saving");
  try {
    let attachmentUrl = null;
    let attachmentType = null;
    if (file) {
      const storagePath = `capsules/${user.uid}/${Date.now()}-${file.name}`;
      const fileRef = ref(storage, storagePath);
      await uploadBytes(fileRef, file);
      attachmentUrl = await getDownloadURL(fileRef);
      attachmentType = file.type.startsWith("image/") ? "image" : "file";
    }

    await addDoc(collection(db, "time_capsules"), {
      uid: user.uid,
      title,
      message,
      openAt: Timestamp.fromDate(new Date(openDateVal)),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      status: "sealed",
      visibility: "private",
      attachmentUrl,
      attachmentType,
    });

    capsuleStatus.textContent = t("common.saved");
    setTimeout(closeModal, 500);
    fetchCapsules(user);
  } catch (err) {
    console.error("[time-capsule] save failed:", err.code || err);
    capsuleStatus.textContent = t("common.couldnt_save");
  }
});

document.addEventListener("eden:langchange", renderCapsules);
