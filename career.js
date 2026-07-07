import { auth, googleProvider, db, storage, isOwner } from "./firebase-init.js";
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
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import { ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-storage.js";
import { getLang } from "./js/i18n.js";

const authControl = document.getElementById("auth-control");

// ---- Bilingual content helper ----
// Career docs store title_en/title_zh (etc.) as flat fields — this picks the active language,
// falling back to English so a partially-translated entry never renders blank.
function bi(obj, field) {
  const suffix = getLang() === "zh-CN" ? "_zh" : "_en";
  return obj[field + suffix] || obj[field + "_en"] || "";
}

// ---- Fetch: same mine+public merge pattern as journals/timeline/habits. Career write access
// is Owner-only (see firestore.rules), so the "mine" half only ever returns anything when the
// signed-in user IS the owner — Viewers/Friends/HR transparently only ever see public items. ----
async function fetchCareerCollection(name) {
  const map = new Map();
  try {
    const publicSnap = await getDocs(query(collection(db, name), where("visibility", "==", "public")));
    publicSnap.forEach((d) => map.set(d.id, { id: d.id, ...d.data() }));
  } catch (err) {
    console.error(`[career] ${name} public query failed:`, err.code || err);
  }
  const user = auth.currentUser;
  if (user) {
    try {
      const mineSnap = await getDocs(query(collection(db, name), where("uid", "==", user.uid)));
      mineSnap.forEach((d) => map.set(d.id, { id: d.id, ...d.data() }));
    } catch (err) {
      console.error(`[career] ${name} own query failed:`, err.code || err);
    }
  }
  return [...map.values()];
}

let cachedExperiences = [];
let cachedProjects = [];
let cachedCertificates = [];
let cachedAwards = [];
let activeProjectCategory = "all";

async function loadAll() {
  [cachedExperiences, cachedProjects, cachedCertificates, cachedAwards] = await Promise.all([
    fetchCareerCollection("career_experiences"),
    fetchCareerCollection("career_projects"),
    fetchCareerCollection("career_certificates"),
    fetchCareerCollection("career_awards"),
  ]);
  renderExperiences();
  renderProjects();
  renderCertificates();
  renderAwards();
}

// Re-render bilingual content (not just chrome — see js/i18n.js's applyTranslations for that)
// whenever the language switcher fires.
document.addEventListener("eden:langchange", () => {
  renderExperiences();
  renderProjects();
  renderCertificates();
  renderAwards();
});

// ---- Storage upload helper (mirrors gallery.js's upload flow) ----
async function uploadCareerFile(file, visibility, subfolder) {
  const user = auth.currentUser;
  const storagePath = `career/${user.uid}/${visibility}/${subfolder}/${Date.now()}-${file.name}`;
  const fileRef = ref(storage, storagePath);
  await uploadBytes(fileRef, file);
  const url = await getDownloadURL(fileRef);
  return { url, storagePath };
}

function ownerControlsHTML(id, collectionName) {
  return `
    <div class="flex items-center gap-2 flex-shrink-0">
      <button class="career-edit-btn text-textGray hover:text-neonPurple text-xs" data-id="${id}" data-collection="${collectionName}"><i class="fa-solid fa-pen"></i></button>
      <button class="career-delete-btn text-textGray hover:text-rose-400 text-xs" data-id="${id}" data-collection="${collectionName}"><i class="fa-solid fa-trash"></i></button>
    </div>`;
}

function wireOwnerControls(root, onEdit) {
  root.querySelectorAll(".career-edit-btn").forEach((btn) => {
    btn.addEventListener("click", () => onEdit(btn.dataset.id));
  });
  root.querySelectorAll(".career-delete-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this item?")) return;
      try {
        await deleteDoc(doc(db, btn.dataset.collection, btn.dataset.id));
        await loadAll();
      } catch (err) {
        console.error("[career] delete failed:", err.code || err);
      }
    });
  });
}

// ==================== Experience ====================

function renderExperiences() {
  const listEl = document.getElementById("experience-list");
  const emptyEl = document.getElementById("experience-empty");
  const owner = isOwner(auth.currentUser);
  document.getElementById("add-experience-btn").classList.toggle("hidden", !owner);
  emptyEl.classList.toggle("hidden", cachedExperiences.length > 0);

  const sorted = [...cachedExperiences].sort((a, b) => (b.startDate || "").localeCompare(a.startDate || ""));
  listEl.replaceChildren(
    ...sorted.map((exp) => {
      const el = document.createElement("div");
      el.className = "bg-darkBg/60 border border-borderNeon rounded-xl p-5";
      const dates = `${exp.startDate || ""} – ${exp.endDate || "Present"}`;
      const skills = (exp.skills || []).map((s) => `<span class="px-2 py-0.5 rounded-full border border-borderNeon text-[10px] font-code text-textGray">${s}</span>`).join(" ");
      el.innerHTML = `
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="font-cyber font-bold text-sm text-white">${bi(exp, "role")}</p>
            <p class="text-xs text-neonPurple font-code mt-0.5">${exp.company || ""}</p>
            <p class="text-[11px] text-textGray font-code mt-0.5">${dates}${exp.location ? " · " + exp.location : ""}</p>
          </div>
          ${owner ? ownerControlsHTML(exp.id, "career_experiences") : ""}
        </div>
        <p class="text-sm text-textGray mt-3 leading-relaxed">${bi(exp, "description")}</p>
        ${skills ? `<div class="flex flex-wrap gap-1.5 mt-3">${skills}</div>` : ""}`;
      return el;
    })
  );
  wireOwnerControls(listEl, openExperienceForm);
}

function openExperienceForm(id) {
  const exp = id ? cachedExperiences.find((e) => e.id === id) : null;
  document.getElementById("experience-form-id").value = id || "";
  document.getElementById("experience-company").value = exp?.company || "";
  document.getElementById("experience-role-en").value = exp?.role_en || "";
  document.getElementById("experience-role-zh").value = exp?.role_zh || "";
  document.getElementById("experience-start").value = exp?.startDate || "";
  document.getElementById("experience-end").value = exp?.endDate || "";
  document.getElementById("experience-location").value = exp?.location || "";
  document.getElementById("experience-description-en").value = exp?.description_en || "";
  document.getElementById("experience-description-zh").value = exp?.description_zh || "";
  document.getElementById("experience-skills").value = (exp?.skills || []).join(", ");
  document.querySelector(`#experience-form input[name="experience-visibility"][value="${exp?.visibility || "public"}"]`).checked = true;
  document.getElementById("experience-modal").classList.remove("hidden");
}

document.getElementById("add-experience-btn").addEventListener("click", () => openExperienceForm(null));
document.getElementById("experience-modal-close").addEventListener("click", () => document.getElementById("experience-modal").classList.add("hidden"));
document.getElementById("experience-modal-backdrop").addEventListener("click", () => document.getElementById("experience-modal").classList.add("hidden"));

document.getElementById("experience-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const user = auth.currentUser;
  if (!isOwner(user)) return;
  const id = document.getElementById("experience-form-id").value;
  const payload = {
    uid: user.uid,
    company: document.getElementById("experience-company").value.trim(),
    role_en: document.getElementById("experience-role-en").value.trim(),
    role_zh: document.getElementById("experience-role-zh").value.trim(),
    startDate: document.getElementById("experience-start").value,
    endDate: document.getElementById("experience-end").value,
    location: document.getElementById("experience-location").value.trim(),
    description_en: document.getElementById("experience-description-en").value.trim(),
    description_zh: document.getElementById("experience-description-zh").value.trim(),
    skills: document.getElementById("experience-skills").value.split(",").map((s) => s.trim()).filter(Boolean),
    visibility: document.querySelector('#experience-form input[name="experience-visibility"]:checked').value,
    updatedAt: serverTimestamp(),
  };
  try {
    if (id) {
      await updateDoc(doc(db, "career_experiences", id), payload);
    } else {
      await addDoc(collection(db, "career_experiences"), { ...payload, createdAt: serverTimestamp() });
    }
    document.getElementById("experience-modal").classList.add("hidden");
    await loadAll();
  } catch (err) {
    console.error("[career] experience save failed:", err.code || err);
  }
});

// ==================== Projects ====================

const PROJECT_CATEGORIES = ["personal", "internship", "fyp", "coursework", "work"];

function renderProjects() {
  const owner = isOwner(auth.currentUser);
  document.getElementById("add-project-btn").classList.toggle("hidden", !owner);

  const visible = activeProjectCategory === "all" ? cachedProjects : cachedProjects.filter((p) => p.category === activeProjectCategory);
  const featured = visible.filter((p) => p.featured);

  const featuredSection = document.getElementById("featured-projects-section");
  featuredSection.classList.toggle("hidden", featured.length === 0);
  document.getElementById("featured-projects-list").replaceChildren(...featured.map((p) => projectCard(p, owner)));

  const emptyEl = document.getElementById("projects-empty");
  emptyEl.classList.toggle("hidden", visible.length > 0);
  document.getElementById("projects-list").replaceChildren(...visible.map((p) => projectCard(p, owner)));
}

function projectCard(project, owner) {
  const el = document.createElement("div");
  el.className = "card-lift bg-darkBg/60 border border-borderNeon rounded-xl overflow-hidden hover:border-neonPurple/40 transition-all cursor-pointer flex flex-col";
  const tech = (project.techStack || []).slice(0, 4).map((s) => `<span class="px-2 py-0.5 rounded-full border border-borderNeon text-[10px] font-code text-textGray">${s}</span>`).join(" ");
  const cover = project.images?.[0]?.url || project.images?.[0];
  const coverHTML = cover
    ? `<img src="${cover}" alt="" class="w-full h-36 object-cover">`
    : `<div class="w-full h-36 bg-darkBg/80 flex items-center justify-center text-textGray/50"><i class="fa-solid fa-diagram-project text-2xl"></i></div>`;
  el.innerHTML = `
    ${coverHTML}
    <div class="p-5 flex-1 flex flex-col">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <p class="font-cyber font-bold text-sm text-white truncate">${bi(project, "title")}</p>
          <p class="text-[10px] font-code text-neonPurple mt-1 uppercase tracking-wider">${project.category || ""}</p>
        </div>
        ${owner ? ownerControlsHTML(project.id, "career_projects") : ""}
      </div>
      <p class="text-xs text-textGray mt-3 leading-relaxed flex-1">${bi(project, "summary")}</p>
      ${tech ? `<div class="flex flex-wrap gap-1.5 mt-3">${tech}</div>` : ""}
      <button type="button" class="view-details-btn mt-4 self-start flex items-center gap-1.5 text-xs font-code text-neonPurple hover:underline">
        View Details <i class="fa-solid fa-arrow-right text-[10px]"></i>
      </button>
    </div>`;
  el.addEventListener("click", (event) => {
    if (event.target.closest(".career-edit-btn, .career-delete-btn")) return;
    openProjectDetail(project);
  });
  wireOwnerControls(el, openProjectForm);
  return el;
}

document.querySelectorAll(".project-category-tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    activeProjectCategory = btn.dataset.category;
    document.querySelectorAll(".project-category-tab").forEach((b) => b.classList.toggle("text-neonPurple", b === btn));
    renderProjects();
  });
});

function openProjectDetail(project) {
  const modal = document.getElementById("project-detail-modal");
  document.getElementById("project-detail-title").textContent = bi(project, "title");
  document.getElementById("project-detail-category").textContent = project.category || "";
  document.getElementById("project-detail-summary").textContent = bi(project, "summary");
  document.getElementById("project-detail-description").textContent = bi(project, "description");
  document.getElementById("project-detail-reflection").textContent = bi(project, "reflection");
  document.getElementById("project-detail-reflection-section").classList.toggle("hidden", !bi(project, "reflection"));

  const tech = (project.techStack || []).map((s) => `<span class="px-2 py-0.5 rounded-full border border-borderNeon text-[10px] font-code text-textGray">${s}</span>`).join(" ");
  document.getElementById("project-detail-tech").innerHTML = tech;

  const links = [];
  if (project.githubUrl) links.push(`<a href="${project.githubUrl}" target="_blank" rel="noopener" class="text-neonPurple hover:underline text-xs"><i class="fa-brands fa-github mr-1"></i>GitHub</a>`);
  if (project.demoUrl) links.push(`<a href="${project.demoUrl}" target="_blank" rel="noopener" class="text-neonPurple hover:underline text-xs"><i class="fa-solid fa-arrow-up-right-from-square mr-1"></i>Demo</a>`);
  document.getElementById("project-detail-links").innerHTML = links.join(" &middot; ");
  document.getElementById("project-detail-links-section").classList.toggle("hidden", links.length === 0);

  const images = (project.images || []).map((img) => `<img src="${img.url || img}" class="w-full h-32 object-cover rounded-lg">`).join("");
  document.getElementById("project-detail-images").innerHTML = images;
  document.getElementById("project-detail-gallery-section").classList.toggle("hidden", !(project.images || []).length);

  const docs = (project.documents || []).map((d) => `<a href="${d.url || d}" target="_blank" rel="noopener" class="flex items-center gap-2 text-xs text-neonPurple hover:underline"><i class="fa-solid fa-file"></i>${d.name || "Document"}</a>`).join("");
  document.getElementById("project-detail-documents").innerHTML = docs;
  document.getElementById("project-detail-documents-section").classList.toggle("hidden", !(project.documents || []).length);

  modal.classList.remove("hidden");
}
document.getElementById("project-detail-close").addEventListener("click", () => document.getElementById("project-detail-modal").classList.add("hidden"));
document.getElementById("project-detail-backdrop").addEventListener("click", () => document.getElementById("project-detail-modal").classList.add("hidden"));

function openProjectForm(id) {
  const project = id ? cachedProjects.find((p) => p.id === id) : null;
  document.getElementById("project-form-id").value = id || "";
  document.getElementById("project-title-en").value = project?.title_en || "";
  document.getElementById("project-title-zh").value = project?.title_zh || "";
  document.getElementById("project-summary-en").value = project?.summary_en || "";
  document.getElementById("project-summary-zh").value = project?.summary_zh || "";
  document.getElementById("project-description-en").value = project?.description_en || "";
  document.getElementById("project-description-zh").value = project?.description_zh || "";
  document.getElementById("project-reflection-en").value = project?.reflection_en || "";
  document.getElementById("project-reflection-zh").value = project?.reflection_zh || "";
  document.getElementById("project-tech-stack").value = (project?.techStack || []).join(", ");
  document.getElementById("project-category").value = project?.category || "personal";
  document.getElementById("project-github-url").value = project?.githubUrl || "";
  document.getElementById("project-demo-url").value = project?.demoUrl || "";
  document.getElementById("project-featured").checked = !!project?.featured;
  document.getElementById("project-images-existing").dataset.value = JSON.stringify(project?.images || []);
  document.getElementById("project-documents-existing").dataset.value = JSON.stringify(project?.documents || []);
  document.querySelector(`#project-form input[name="project-visibility"][value="${project?.visibility || "public"}"]`).checked = true;
  document.getElementById("project-status").textContent = "";
  document.getElementById("project-modal").classList.remove("hidden");
}

document.getElementById("add-project-btn").addEventListener("click", () => openProjectForm(null));
document.getElementById("project-modal-close").addEventListener("click", () => document.getElementById("project-modal").classList.add("hidden"));
document.getElementById("project-modal-backdrop").addEventListener("click", () => document.getElementById("project-modal").classList.add("hidden"));

document.getElementById("project-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const user = auth.currentUser;
  if (!isOwner(user)) return;
  const statusEl = document.getElementById("project-status");
  const id = document.getElementById("project-form-id").value;
  const visibility = document.querySelector('#project-form input[name="project-visibility"]:checked').value;
  statusEl.textContent = "Saving…";
  try {
    let images = JSON.parse(document.getElementById("project-images-existing").dataset.value || "[]");
    let documents = JSON.parse(document.getElementById("project-documents-existing").dataset.value || "[]");

    const imageFiles = document.getElementById("project-image-files").files;
    for (const file of imageFiles) {
      images.push(await uploadCareerFile(file, visibility, "projects/images"));
    }
    const docFiles = document.getElementById("project-document-files").files;
    for (const file of docFiles) {
      const uploaded = await uploadCareerFile(file, visibility, "projects/documents");
      documents.push({ ...uploaded, name: file.name });
    }

    const payload = {
      uid: user.uid,
      title_en: document.getElementById("project-title-en").value.trim(),
      title_zh: document.getElementById("project-title-zh").value.trim(),
      summary_en: document.getElementById("project-summary-en").value.trim(),
      summary_zh: document.getElementById("project-summary-zh").value.trim(),
      description_en: document.getElementById("project-description-en").value.trim(),
      description_zh: document.getElementById("project-description-zh").value.trim(),
      reflection_en: document.getElementById("project-reflection-en").value.trim(),
      reflection_zh: document.getElementById("project-reflection-zh").value.trim(),
      techStack: document.getElementById("project-tech-stack").value.split(",").map((s) => s.trim()).filter(Boolean),
      category: document.getElementById("project-category").value,
      githubUrl: document.getElementById("project-github-url").value.trim(),
      demoUrl: document.getElementById("project-demo-url").value.trim(),
      images,
      documents,
      visibility,
      featured: document.getElementById("project-featured").checked,
      updatedAt: serverTimestamp(),
    };

    if (id) {
      await updateDoc(doc(db, "career_projects", id), payload);
    } else {
      await addDoc(collection(db, "career_projects"), { ...payload, createdAt: serverTimestamp() });
    }
    document.getElementById("project-modal").classList.add("hidden");
    await loadAll();
  } catch (err) {
    console.error("[career] project save failed:", err.code || err);
    statusEl.textContent = "Couldn't save — check console.";
  }
});

// ==================== Certificates ====================

function renderCertificates() {
  const listEl = document.getElementById("certificates-list");
  const emptyEl = document.getElementById("certificates-empty");
  const owner = isOwner(auth.currentUser);
  document.getElementById("add-certificate-btn").classList.toggle("hidden", !owner);
  emptyEl.classList.toggle("hidden", cachedCertificates.length > 0);

  const sorted = [...cachedCertificates].sort((a, b) => (b.issueDate || "").localeCompare(a.issueDate || ""));
  listEl.replaceChildren(
    ...sorted.map((cert) => {
      const el = document.createElement("div");
      el.className = "bg-darkBg/60 border border-borderNeon rounded-xl p-4";
      const link = cert.credentialUrl || cert.fileUrl;
      el.innerHTML = `
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="font-cyber font-bold text-xs text-white">${bi(cert, "title")}</p>
            <p class="text-[11px] text-neonPurple font-code mt-0.5">${cert.issuer || ""} ${cert.issueDate ? "· " + cert.issueDate : ""}</p>
            ${link ? `<a href="${link}" target="_blank" rel="noopener" class="text-[11px] text-textGray hover:text-neonPurple mt-1 inline-block"><i class="fa-solid fa-arrow-up-right-from-square mr-1"></i>View</a>` : ""}
          </div>
          ${owner ? ownerControlsHTML(cert.id, "career_certificates") : ""}
        </div>`;
      return el;
    })
  );
  wireOwnerControls(listEl, openCertificateForm);
}

function openCertificateForm(id) {
  const cert = id ? cachedCertificates.find((c) => c.id === id) : null;
  document.getElementById("certificate-form-id").value = id || "";
  document.getElementById("certificate-title-en").value = cert?.title_en || "";
  document.getElementById("certificate-title-zh").value = cert?.title_zh || "";
  document.getElementById("certificate-issuer").value = cert?.issuer || "";
  document.getElementById("certificate-issue-date").value = cert?.issueDate || "";
  document.getElementById("certificate-credential-url").value = cert?.credentialUrl || "";
  document.getElementById("certificate-file-existing").dataset.value = cert?.fileUrl || "";
  document.querySelector(`#certificate-form input[name="certificate-visibility"][value="${cert?.visibility || "public"}"]`).checked = true;
  document.getElementById("certificate-status").textContent = "";
  document.getElementById("certificate-modal").classList.remove("hidden");
}

document.getElementById("add-certificate-btn").addEventListener("click", () => openCertificateForm(null));
document.getElementById("certificate-modal-close").addEventListener("click", () => document.getElementById("certificate-modal").classList.add("hidden"));
document.getElementById("certificate-modal-backdrop").addEventListener("click", () => document.getElementById("certificate-modal").classList.add("hidden"));

document.getElementById("certificate-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const user = auth.currentUser;
  if (!isOwner(user)) return;
  const statusEl = document.getElementById("certificate-status");
  const id = document.getElementById("certificate-form-id").value;
  const visibility = document.querySelector('#certificate-form input[name="certificate-visibility"]:checked').value;
  statusEl.textContent = "Saving…";
  try {
    let fileUrl = document.getElementById("certificate-file-existing").dataset.value || "";
    const file = document.getElementById("certificate-file").files[0];
    if (file) {
      const uploaded = await uploadCareerFile(file, visibility, "certificates");
      fileUrl = uploaded.url;
    }
    const payload = {
      uid: user.uid,
      title_en: document.getElementById("certificate-title-en").value.trim(),
      title_zh: document.getElementById("certificate-title-zh").value.trim(),
      issuer: document.getElementById("certificate-issuer").value.trim(),
      issueDate: document.getElementById("certificate-issue-date").value,
      credentialUrl: document.getElementById("certificate-credential-url").value.trim(),
      fileUrl,
      visibility,
      updatedAt: serverTimestamp(),
    };
    if (id) {
      await updateDoc(doc(db, "career_certificates", id), payload);
    } else {
      await addDoc(collection(db, "career_certificates"), { ...payload, createdAt: serverTimestamp() });
    }
    document.getElementById("certificate-modal").classList.add("hidden");
    await loadAll();
  } catch (err) {
    console.error("[career] certificate save failed:", err.code || err);
    statusEl.textContent = "Couldn't save — check console.";
  }
});

// ==================== Awards ====================

function renderAwards() {
  const listEl = document.getElementById("awards-list");
  const emptyEl = document.getElementById("awards-empty");
  const owner = isOwner(auth.currentUser);
  document.getElementById("add-award-btn").classList.toggle("hidden", !owner);
  emptyEl.classList.toggle("hidden", cachedAwards.length > 0);

  const sorted = [...cachedAwards].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  listEl.replaceChildren(
    ...sorted.map((award) => {
      const el = document.createElement("div");
      el.className = "bg-darkBg/60 border border-borderNeon rounded-xl p-4 hover:border-amber-400/40 transition-all";
      el.innerHTML = `
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <i class="fa-solid fa-trophy text-amber-400 text-lg mb-2"></i>
            <p class="font-cyber font-bold text-xs text-white">${bi(award, "title")}</p>
            <p class="text-[11px] text-amber-400 font-code mt-0.5">${award.issuer || ""} ${award.date ? "· " + award.date : ""}</p>
            <p class="text-xs text-textGray mt-2">${bi(award, "description")}</p>
          </div>
          ${owner ? ownerControlsHTML(award.id, "career_awards") : ""}
        </div>`;
      return el;
    })
  );
  wireOwnerControls(listEl, openAwardForm);
}

function openAwardForm(id) {
  const award = id ? cachedAwards.find((a) => a.id === id) : null;
  document.getElementById("award-form-id").value = id || "";
  document.getElementById("award-title-en").value = award?.title_en || "";
  document.getElementById("award-title-zh").value = award?.title_zh || "";
  document.getElementById("award-issuer").value = award?.issuer || "";
  document.getElementById("award-date").value = award?.date || "";
  document.getElementById("award-description-en").value = award?.description_en || "";
  document.getElementById("award-description-zh").value = award?.description_zh || "";
  document.querySelector(`#award-form input[name="award-visibility"][value="${award?.visibility || "public"}"]`).checked = true;
  document.getElementById("award-modal").classList.remove("hidden");
}

document.getElementById("add-award-btn").addEventListener("click", () => openAwardForm(null));
document.getElementById("award-modal-close").addEventListener("click", () => document.getElementById("award-modal").classList.add("hidden"));
document.getElementById("award-modal-backdrop").addEventListener("click", () => document.getElementById("award-modal").classList.add("hidden"));

document.getElementById("award-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const user = auth.currentUser;
  if (!isOwner(user)) return;
  const id = document.getElementById("award-form-id").value;
  const payload = {
    uid: user.uid,
    title_en: document.getElementById("award-title-en").value.trim(),
    title_zh: document.getElementById("award-title-zh").value.trim(),
    issuer: document.getElementById("award-issuer").value.trim(),
    date: document.getElementById("award-date").value,
    description_en: document.getElementById("award-description-en").value.trim(),
    description_zh: document.getElementById("award-description-zh").value.trim(),
    visibility: document.querySelector('#award-form input[name="award-visibility"]:checked').value,
    updatedAt: serverTimestamp(),
  };
  try {
    if (id) {
      await updateDoc(doc(db, "career_awards", id), payload);
    } else {
      await addDoc(collection(db, "career_awards"), { ...payload, createdAt: serverTimestamp() });
    }
    document.getElementById("award-modal").classList.add("hidden");
    await loadAll();
  } catch (err) {
    console.error("[career] award save failed:", err.code || err);
  }
});

// ==================== Auth chrome (same pattern as every other page) ====================

function renderSignedOut() {
  authControl.innerHTML = `
    <button id="auth-signin-btn" class="px-4 py-2 bg-gradient-to-r from-neonViolet to-neonPurple rounded-xl text-xs font-cyber font-bold tracking-wider text-white hover:scale-105 transition-all">
      <i class="fa-brands fa-google mr-2"></i> SIGN IN
    </button>`;
  document.getElementById("auth-signin-btn").addEventListener("click", () => {
    signInWithPopup(auth, googleProvider).catch((err) => console.error("Sign-in failed", err));
  });
}

function renderSignedIn(user) {
  authControl.innerHTML = `
    <span class="text-xs text-textGray font-code">Signed in as <span class="text-white">${user.displayName || user.email}</span></span>
    <button id="auth-signout-btn" class="px-4 py-2 bg-cardBg/70 border border-borderNeon rounded-xl text-xs font-cyber font-bold tracking-wider text-white hover:border-neonPurple transition-all">
      SIGN OUT
    </button>`;
  document.getElementById("auth-signout-btn").addEventListener("click", () => signOut(auth));
}

onAuthStateChanged(auth, (user) => {
  if (user) {
    renderSignedIn(user);
  } else {
    renderSignedOut();
  }
  loadAll();
});
