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
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import {
  ref,
  uploadBytes,
  getDownloadURL,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-storage.js";

const CATEGORY_META = {
  personal: { label: "Personal", text: "text-neonPurple", bg: "bg-neonPurple/10", border: "border-neonPurple/30" },
  event: { label: "Event", text: "text-amber-400", bg: "bg-amber-400/10", border: "border-amber-400/30" },
  work: { label: "Work", text: "text-neonBlue", bg: "bg-neonBlue/10", border: "border-neonBlue/30" },
  project: { label: "Project", text: "text-emerald-400", bg: "bg-emerald-400/10", border: "border-emerald-400/30" },
};

const authControl = document.getElementById("auth-control");
const accessNote = document.getElementById("gallery-access-note");
const feedContainer = document.getElementById("feed-container");
const feedEmpty = document.getElementById("feed-empty");
const filterTabs = document.querySelectorAll(".filter-tab");
const privateTab = document.querySelector('.filter-tab[data-filter="private"]');
const newPostBtn = document.getElementById("new-post-btn");
const postModal = document.getElementById("post-modal");
const postModalClose = document.getElementById("post-modal-close");
const postModalBackdrop = document.getElementById("post-modal-backdrop");
const postForm = document.getElementById("post-form");
const postStatus = document.getElementById("post-status");

let cachedPosts = [];
let activeFilter = "all";

function formatTimestamp(ts) {
  if (!ts?.toDate) return "";
  return ts.toDate().toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function postCard(photo) {
  const meta = CATEGORY_META[photo.category] || CATEGORY_META.personal;
  const isPrivate = photo.visibility === "private";
  const isMine = !!auth.currentUser && photo.uploadedBy === auth.currentUser.uid;

  const card = document.createElement("article");
  card.className = "is-visible bg-cardBg/90 backdrop-blur-sm rounded-2xl neon-border-purple overflow-hidden";
  card.innerHTML = `
    <img src="${photo.url}" alt="${photo.caption || "Gallery post"}" class="w-full max-h-[520px] object-cover">
    <div class="p-4 space-y-2">
      ${photo.caption ? `<p class="text-sm text-white">${photo.caption}</p>` : ""}
      <div class="flex flex-wrap items-center gap-2 text-[10px] font-code">
        <span class="px-2 py-0.5 rounded-full border ${meta.border} ${meta.bg} ${meta.text}">${meta.label}</span>
        <span class="px-2 py-0.5 rounded-full border ${isPrivate ? "border-rose-400/30 bg-rose-400/10 text-rose-400" : "border-emerald-400/30 bg-emerald-400/10 text-emerald-400"}">
          <i class="fa-solid ${isPrivate ? "fa-lock" : "fa-globe"} mr-1"></i>${isPrivate ? "Private" : "Public"}
        </span>
        ${isMine ? `<span class="px-2 py-0.5 rounded-full border border-borderNeon bg-darkBg/60 text-textGray">me</span>` : ""}
        <span class="text-textGray">${formatTimestamp(photo.uploadedAt)}</span>
      </div>
    </div>`;
  return card;
}

function renderFeed() {
  const visible = activeFilter === "all"
    ? cachedPosts
    : activeFilter === "public" || activeFilter === "private"
      ? cachedPosts.filter((p) => p.visibility === activeFilter)
      : cachedPosts.filter((p) => p.category === activeFilter);

  feedContainer.replaceChildren(...visible.map(postCard));
  feedEmpty.classList.toggle("hidden", visible.length > 0);
}

function setActiveTab(filter) {
  activeFilter = filter;
  filterTabs.forEach((btn) => {
    const active = btn.dataset.filter === filter;
    btn.classList.toggle("text-white", active);
    btn.classList.toggle("bg-neonPurple/15", active);
  });
  renderFeed();
}

filterTabs.forEach((btn) => btn.addEventListener("click", () => setActiveTab(btn.dataset.filter)));
setActiveTab("all");

async function fetchVisiblePosts() {
  const posts = [];

  const publicSnap = await getDocs(query(collection(db, "photos"), where("visibility", "==", "public")));
  publicSnap.forEach((doc) => posts.push(doc.data()));

  if (auth.currentUser) {
    try {
      const privateSnap = await getDocs(query(collection(db, "photos"), where("visibility", "==", "private")));
      privateSnap.forEach((doc) => posts.push(doc.data()));
      accessNote.classList.add("hidden");
      privateTab.classList.remove("hidden");
    } catch (err) {
      console.error("[gallery] private posts query failed:", err.code || err);
      accessNote.classList.remove("hidden");
      privateTab.classList.add("hidden");
      if (activeFilter === "private") setActiveTab("all");
    }
  }

  posts.sort((a, b) => (b.uploadedAt?.toMillis?.() || 0) - (a.uploadedAt?.toMillis?.() || 0));
  cachedPosts = posts;
  renderFeed();
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
  newPostBtn.classList.add("hidden");
  if (activeFilter === "private") setActiveTab("all");
}

function renderSignedIn(user) {
  authControl.innerHTML = `
    <span class="text-xs text-textGray font-code">Signed in as <span class="text-white">${user.displayName || user.email}</span></span>
    <button id="auth-signout-btn" class="px-4 py-2 bg-cardBg/70 border border-borderNeon rounded-xl text-xs font-cyber font-bold tracking-wider text-white hover:border-neonPurple transition-all">
      SIGN OUT
    </button>`;
  document.getElementById("auth-signout-btn").addEventListener("click", () => signOut(auth));

  newPostBtn.classList.toggle("hidden", !isOwner(user));
}

onAuthStateChanged(auth, (user) => {
  if (user) {
    renderSignedIn(user);
  } else {
    renderSignedOut();
  }
  fetchVisiblePosts();
});

function openModal() {
  postModal.classList.remove("hidden");
}
function closeModal() {
  postModal.classList.add("hidden");
  postForm.reset();
  postStatus.textContent = "";
}

newPostBtn.addEventListener("click", openModal);
postModalClose.addEventListener("click", closeModal);
postModalBackdrop.addEventListener("click", closeModal);

postForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const user = auth.currentUser;
  if (!isOwner(user)) return;

  const file = document.getElementById("post-file").files[0];
  const caption = document.getElementById("post-caption").value.trim();
  const category = document.getElementById("post-category").value;
  const visibility = postForm.querySelector('input[name="post-visibility"]:checked').value;
  if (!file) return;

  postStatus.textContent = "Uploading...";
  try {
    const storagePath = `gallery/${visibility}/${category}/${Date.now()}-${file.name}`;
    const fileRef = ref(storage, storagePath);
    await uploadBytes(fileRef, file);
    const url = await getDownloadURL(fileRef);

    await addDoc(collection(db, "photos"), {
      url,
      storagePath,
      category,
      visibility,
      caption: caption || file.name,
      uploadedAt: serverTimestamp(),
      uploadedBy: user.uid,
    });

    postStatus.textContent = "Posted.";
    await fetchVisiblePosts();
    closeModal();
  } catch (err) {
    console.error("Upload failed", err);
    postStatus.textContent = "Upload failed — check console.";
  }
});
