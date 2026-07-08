// Mobile navigation — a fourth sanctioned shared module (auth-guard.js, global-search.js,
// i18n.js), self-injecting its DOM like global-search.js rather than requiring per-page markup.
// The desktop <header> is hidden below the `md` breakpoint (see the `hidden md:block` class
// added to every page's <header>) in favor of what this module injects: a fixed top bar, a
// slide-in drawer, a fixed bottom nav, and a Quick Add action sheet.
import { auth } from "../firebase-init.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import { getLang, setLang, init as initI18n, applyTranslations } from "./i18n.js";

const DRAWER_LINKS = [
  { href: "index.html", icon: "fa-house", key: "nav.home", label: "Home" },
  { href: "resume.html", icon: "fa-scroll", key: "nav.career", label: "Career" },
  { href: "gallery.html", icon: "fa-images", key: "nav.memories", label: "Memories" },
  { href: "atlas.html", icon: "fa-map-location-dot", key: "nav.atlas", label: "Atlas" },
  { href: "journal.html", icon: "fa-book", key: "nav.journal", label: "Journal" },
  { href: "expenses.html", icon: "fa-wallet", key: "nav.finance", label: "Finance" },
  { href: "calendar.html", icon: "fa-calendar-days", key: "nav.calendar", label: "Calendar" },
  { href: "dashboard.html", icon: "fa-chart-line", key: "nav.people", label: "Connections" },
  { href: "reports.html", icon: "fa-chart-pie", key: "nav.reports", label: "Reports" },
  { href: "notifications.html", icon: "fa-bell", key: "nav.inbox", label: "Inbox" },
  { href: "timeline.html", icon: "fa-timeline", key: "nav.journey", label: "Journey" },
  { href: "time-capsule.html", icon: "fa-box-archive", key: "nav.time_capsule", label: "Time Capsule" },
  { href: "constellation.html", icon: "fa-star", key: "nav.constellation", label: "Constellation" },
  { href: "me.html", icon: "fa-circle-user", key: "nav.me", label: "Me" },
];

const BOTTOM_ITEMS = [
  { href: "index.html", icon: "fa-house", key: "mobilenav.home", label: "Home" },
  { href: "gallery.html", icon: "fa-images", key: "mobilenav.memories", label: "Memories" },
  { action: "quick-add", icon: "fa-plus", key: "mobilenav.quick_add", label: "Add" },
  { href: "dashboard.html", icon: "fa-user-group", key: "mobilenav.people", label: "Connections" },
  { href: "me.html", icon: "fa-circle-user", key: "mobilenav.me", label: "Me" },
];

const QUICK_ADD_ITEMS = [
  { href: "expenses.html?new=1", icon: "fa-wallet", key: "mobilenav.add_expense", label: "Add Expense" },
  { href: "journal.html?new=1", icon: "fa-book", key: "mobilenav.write_journal", label: "Write Journal" },
  { href: "gallery.html?new=1", icon: "fa-image", key: "mobilenav.upload_photo", label: "Upload Photo" },
  { href: "timeline.html?new=1", icon: "fa-timeline", key: "mobilenav.add_timeline_event", label: "Add Timeline Event" },
  { href: "habits.html?new=1", icon: "fa-list-check", key: "mobilenav.add_habit", label: "Add Habit" },
  { href: "collections.html?new=1", icon: "fa-layer-group", key: "mobilenav.new_collection", label: "New Collection" },
  { href: "time-capsule.html?new=1", icon: "fa-box-archive", key: "mobilenav.new_capsule", label: "New Capsule" },
];

const here = location.pathname.split("/").pop() || "index.html";
let injected = false;

function injectUI() {
  if (injected) return;
  const anchor = document.querySelector("header");
  if (!anchor) return;
  injected = true;

  document.body.insertAdjacentHTML("afterbegin", topBarHTML());
  document.body.insertAdjacentHTML("beforeend", drawerHTML());
  document.body.insertAdjacentHTML("beforeend", bottomNavHTML());
  document.body.insertAdjacentHTML("beforeend", quickAddHTML());

  wireTopBar();
  wireDrawer();
  wireBottomNav();
  wireQuickAdd();
}

function topBarHTML() {
  return `
    <div id="mobile-topbar" class="md:hidden fixed top-0 inset-x-0 z-40 flex items-center justify-between px-4 py-3 bg-cardBg/90 backdrop-blur-md border-b border-borderNeon">
      <button id="mobile-hamburger-btn" type="button" aria-label="Open menu" aria-expanded="false" class="min-w-[44px] min-h-[44px] flex items-center justify-center text-white text-lg"><i class="fa-solid fa-bars"></i></button>
      <span class="flex items-center gap-2">
        <img src="images/logo-mark.png" alt="" class="w-5 h-5 object-contain">
        <span class="font-cyber font-semibold text-sm tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-white to-neonPurple">EdenAtlas</span>
      </span>
      <a href="me.html" aria-label="Account" class="min-w-[44px] min-h-[44px] flex items-center justify-center text-white text-lg"><i class="fa-solid fa-circle-user"></i></a>
    </div>`;
}

function drawerHTML() {
  const links = DRAWER_LINKS.map((item) => `
    <a href="${item.href}" class="flex items-center gap-3 px-3 py-3 min-h-[44px] rounded-xl ${item.href === here ? "text-neonPurple bg-neonPurple/10" : "text-white hover:bg-darkBg/40"} transition-colors">
      <i class="fa-solid ${item.icon} w-5 text-center"></i> <span data-i18n="${item.key}">${item.label}</span>
    </a>`).join("");
  return `
    <div id="mobile-drawer-overlay" class="hidden md:hidden fixed inset-0 z-50">
      <div id="mobile-drawer-backdrop" class="absolute inset-0 bg-darkBg/80 backdrop-blur-sm"></div>
      <div id="mobile-drawer" role="dialog" aria-label="Navigation menu" class="absolute inset-y-0 left-0 w-72 max-w-[85vw] bg-cardBg neon-border-purple overflow-y-auto p-4 flex flex-col gap-1">
        <div class="flex items-center justify-between mb-2 px-1">
          <span class="flex items-center gap-2">
            <img src="images/logo-mark.png" alt="" class="w-6 h-6 object-contain">
            <span class="font-cyber font-semibold text-sm text-transparent bg-clip-text bg-gradient-to-r from-white to-neonPurple">EdenAtlas</span>
          </span>
          <button id="mobile-drawer-close" type="button" aria-label="Close menu" class="min-w-[44px] min-h-[44px] flex items-center justify-center text-textGray hover:text-white text-xl leading-none">&times;</button>
        </div>
        ${links}
        <div class="flex items-center justify-between px-3 py-3">
          <span class="text-sm text-textGray" data-i18n="settings.language">Language</span>
          <div id="drawer-lang-toggle" class="flex items-center gap-1 bg-darkBg/60 border border-borderNeon rounded-full p-1 text-xs font-code">
            <button data-lang-choice="en" class="drawer-lang-btn px-3 py-1.5 min-h-[36px] rounded-full transition-colors">EN</button>
            <button data-lang-choice="zh-CN" class="drawer-lang-btn px-3 py-1.5 min-h-[36px] rounded-full transition-colors">中文</button>
          </div>
        </div>
        <button id="drawer-logout-btn" type="button" class="mt-2 flex items-center gap-3 px-3 py-3 min-h-[44px] rounded-xl text-rose-400 hover:bg-rose-400/10 transition-colors">
          <i class="fa-solid fa-arrow-right-from-bracket w-5 text-center"></i> <span data-i18n="nav.logout">Log Out</span>
        </button>
      </div>
    </div>`;
}

function bottomNavHTML() {
  const items = BOTTOM_ITEMS.map((item) => {
    const isCenter = item.action === "quick-add";
    const active = item.href === here;
    if (isCenter) {
      return `
        <button id="mobile-quickadd-btn" type="button" aria-label="Quick Add" class="flex flex-col items-center justify-center min-w-[44px] min-h-[44px] -mt-4">
          <span class="w-11 h-11 rounded-full bg-gradient-to-r from-neonViolet to-neonPurple flex items-center justify-center text-white text-lg shadow-lg shadow-neonPurple/30"><i class="fa-solid ${item.icon}"></i></span>
        </button>`;
    }
    return `
      <a href="${item.href}" class="flex flex-col items-center justify-center gap-0.5 min-w-[44px] min-h-[44px] flex-1 ${active ? "text-neonPurple" : "text-textGray"}">
        <i class="fa-solid ${item.icon}"></i>
        <span class="text-[10px] font-code" data-i18n="${item.key}">${item.label}</span>
      </a>`;
  }).join("");
  return `
    <nav id="mobile-bottomnav" class="md:hidden fixed bottom-0 inset-x-0 z-40 flex items-stretch justify-between px-2 bg-cardBg/95 backdrop-blur-md border-t border-borderNeon" style="padding-bottom: env(safe-area-inset-bottom, 0)">
      ${items}
    </nav>`;
}

function quickAddHTML() {
  const items = QUICK_ADD_ITEMS.map((item) => `
    <a href="${item.href}" class="flex items-center gap-3 px-4 py-3 min-h-[44px] rounded-xl hover:bg-darkBg/40 transition-colors">
      <span class="w-9 h-9 rounded-lg bg-neonPurple/10 text-neonPurple flex items-center justify-center flex-shrink-0"><i class="fa-solid ${item.icon}"></i></span>
      <span class="text-sm text-white" data-i18n="${item.key}">${item.label}</span>
    </a>`).join("");
  return `
    <div id="quickadd-sheet-overlay" class="hidden md:hidden fixed inset-0 z-50 flex items-end">
      <div id="quickadd-sheet-backdrop" class="absolute inset-0 bg-darkBg/80 backdrop-blur-sm"></div>
      <div class="relative w-full bg-cardBg neon-border-purple rounded-t-2xl p-3 pb-6" style="padding-bottom: calc(1.5rem + env(safe-area-inset-bottom, 0))">
        <div class="w-10 h-1 rounded-full bg-borderNeon mx-auto mb-3"></div>
        ${items}
      </div>
    </div>`;
}

function wireTopBar() {
  document.getElementById("mobile-hamburger-btn").addEventListener("click", openDrawer);
}

function openDrawer() {
  document.getElementById("mobile-drawer-overlay").classList.remove("hidden");
  document.getElementById("mobile-hamburger-btn").setAttribute("aria-expanded", "true");
}
function closeDrawer() {
  document.getElementById("mobile-drawer-overlay").classList.add("hidden");
  document.getElementById("mobile-hamburger-btn").setAttribute("aria-expanded", "false");
}

function wireDrawer() {
  document.getElementById("mobile-drawer-close").addEventListener("click", closeDrawer);
  document.getElementById("mobile-drawer-backdrop").addEventListener("click", closeDrawer);
  document.getElementById("drawer-logout-btn").addEventListener("click", async () => {
    await signOut(auth);
    location.href = "login.html";
  });

  // Same setLang()/getLang() from js/i18n.js that Settings uses — no separate mobile logic.
  const langButtons = document.querySelectorAll(".drawer-lang-btn");
  const paintActive = () => {
    langButtons.forEach((btn) => {
      const active = btn.dataset.langChoice === getLang();
      btn.classList.toggle("bg-neonPurple/20", active);
      btn.classList.toggle("text-white", active);
      btn.classList.toggle("text-textGray", !active);
    });
  };
  // Await init() (safe to call repeatedly) so the initial paint reflects the fully-resolved
  // language (localStorage → Firestore → browser) rather than whatever currentLang defaulted
  // to before init() finished — the same ordering fix applied to Settings' own toggle.
  initI18n().then(() => {
    applyTranslations(document);
    paintActive();
  });
  langButtons.forEach((btn) => btn.addEventListener("click", async () => {
    await setLang(btn.dataset.langChoice);
    paintActive();
  }));
  // Repaint if the language changed via another control (e.g. Settings' inline toggle).
  document.addEventListener("eden:langchange", paintActive);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !document.getElementById("mobile-drawer-overlay").classList.contains("hidden")) {
      closeDrawer();
    }
  });
}

function wireBottomNav() {
  document.getElementById("mobile-quickadd-btn").addEventListener("click", () => {
    document.getElementById("quickadd-sheet-overlay").classList.remove("hidden");
  });
}

function wireQuickAdd() {
  const overlay = document.getElementById("quickadd-sheet-overlay");
  const close = () => overlay.classList.add("hidden");
  document.getElementById("quickadd-sheet-backdrop").addEventListener("click", close);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !overlay.classList.contains("hidden")) close();
  });
}

onAuthStateChanged(auth, (user) => {
  if (user) injectUI();
});
