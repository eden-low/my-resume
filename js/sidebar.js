// Desktop application sidebar — a fifth sanctioned shared module (i18n.js, auth-guard.js,
// global-search.js, mobile-nav.js, now sidebar.js), self-injecting like the others. Desktop
// only (`hidden md:flex`) — mobile keeps its existing top bar/drawer/bottom-nav from
// mobile-nav.js untouched. Replaces the old horizontal top-nav, which is now permanently
// hidden (see the sitewide `<header class="hidden ...">` → `<header class="hidden">` pass).
import { auth } from "../firebase-init.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import { getLang, setLang, init as initI18n, applyTranslations } from "./i18n.js";

const COLLAPSE_KEY = "eden:sidebarCollapsed";
const EXPANDED_W = "240px";
const COLLAPSED_W = "72px";

// Matches the brief's order. Habits/Contact are real pages that would otherwise become
// unreachable on desktop once the old top-nav is retired — the brief's list wasn't exhaustive
// (mobile-nav.js's drawer already omits them from its primary set the same way), so they're
// kept as a smaller secondary group rather than silently dropped.
const PRIMARY_LINKS = [
  { href: "index.html", icon: "home", key: "nav.home", label: "Home" },
  { href: "resume.html", icon: "briefcase", key: "nav.career", label: "Career" },
  { href: "gallery.html", icon: "image", key: "nav.memories", label: "Memories" },
  { href: "atlas.html", icon: "map", key: "nav.atlas", label: "Atlas" },
  { href: "journal.html", icon: "book-open", key: "nav.journal", label: "Journal" },
  { href: "expenses.html", icon: "wallet", key: "nav.finance", label: "Finance" },
  { href: "calendar.html", icon: "calendar-days", key: "nav.calendar", label: "Calendar" },
  { href: "dashboard.html", icon: "users", key: "nav.people", label: "Connections" },
  { href: "reports.html", icon: "pie-chart", key: "nav.reports", label: "Reports" },
  { href: "notifications.html", icon: "bell", key: "nav.inbox", label: "Inbox" },
];

// Journey stays reachable but de-emphasized now that Atlas is the larger location/chapter
// module; Habits/Contact were already here for the same "still a real page, just not primary" reason.
const SECONDARY_LINKS = [
  { href: "timeline.html", icon: "compass", key: "nav.journey", label: "Journey" },
  { href: "habits.html", icon: "list-checks", key: "nav.habits", label: "Habits" },
  { href: "time-capsule.html", icon: "hourglass", key: "nav.time_capsule", label: "Time Capsule" },
  { href: "constellation.html", icon: "sparkles", key: "nav.constellation", label: "Constellation" },
  { href: "contact.html", icon: "mail", key: "nav.contact", label: "Contact" },
];

const here = location.pathname.split("/").pop() || "index.html";
let collapsed = localStorage.getItem(COLLAPSE_KEY) === "1";
let injected = false;

function applyWidth() {
  document.documentElement.style.setProperty("--sidebar-w", collapsed ? COLLAPSED_W : EXPANDED_W);
  const aside = document.getElementById("eden-sidebar");
  if (aside) aside.classList.toggle("eden-sidebar-collapsed", collapsed);
}

function navRow(item) {
  const active = item.href === here;
  const a = document.createElement("a");
  a.href = item.href;
  a.title = item.label;
  a.className = `flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-colors ${active ? "bg-neonPurple/15 text-neonPurple" : "text-textGray hover:bg-darkBg/40 hover:text-white"}`;
  a.innerHTML = `<i data-lucide="${item.icon}" class="w-[18px] h-[18px] flex-shrink-0"></i><span class="eden-sidebar-label truncate" data-i18n="${item.key}">${item.label}</span>`;
  return a;
}

function sidebarHTML() {
  const primary = PRIMARY_LINKS.map((item) => navRow(item).outerHTML).join("");
  const secondary = SECONDARY_LINKS.map((item) => navRow(item).outerHTML).join("");
  return `
    <aside id="eden-sidebar" class="hidden md:flex flex-col fixed left-0 inset-y-0 z-30 bg-cardBg/90 backdrop-blur-md border-r border-borderNeon" style="width:var(--sidebar-w)">
      <div class="flex items-center gap-2.5 px-4 h-16 flex-shrink-0 border-b border-borderNeon/60">
        <div class="w-8 h-8 flex items-center justify-center flex-shrink-0">
          <img src="images/logo-mark.png" alt="EdenAtlas" class="w-full h-full object-contain">
        </div>
        <span class="eden-sidebar-label font-cyber font-semibold text-sm tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-white to-neonPurple truncate">EdenAtlas</span>
      </div>
      <nav class="flex-1 overflow-y-auto px-2.5 py-3 space-y-0.5">
        ${primary}
        <div class="my-2 border-t border-borderNeon/40"></div>
        ${secondary}
      </nav>
      <div class="px-2.5 py-3 border-t border-borderNeon/60 space-y-0.5 flex-shrink-0">
        <div class="eden-sidebar-lang-row flex items-center justify-between px-3 py-1.5 mb-1">
          <span class="text-[11px] font-code text-textGray" data-i18n="settings.language">Language</span>
          <div id="sidebar-lang-toggle" class="flex items-center gap-0.5 bg-darkBg/60 border border-borderNeon rounded-full p-0.5 text-[10px] font-code">
            <button data-lang-choice="en" class="sidebar-lang-btn px-2 py-1 rounded-full transition-colors">EN</button>
            <button data-lang-choice="zh-CN" class="sidebar-lang-btn px-2 py-1 rounded-full transition-colors">中文</button>
          </div>
        </div>
        <a href="me.html" title="Me" class="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-textGray hover:bg-darkBg/40 hover:text-white transition-colors">
          <i data-lucide="user" class="w-[18px] h-[18px] flex-shrink-0"></i><span class="eden-sidebar-label truncate" data-i18n="nav.me">Me</span>
        </a>
        <button id="eden-sidebar-logout" type="button" class="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-textGray hover:bg-rose-400/10 hover:text-rose-400 transition-colors">
          <i data-lucide="log-out" class="w-[18px] h-[18px] flex-shrink-0"></i><span class="eden-sidebar-label truncate" data-i18n="nav.logout">Log Out</span>
        </button>
        <button id="eden-sidebar-collapse" type="button" title="Collapse sidebar" class="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-textGray hover:bg-darkBg/40 hover:text-white transition-colors">
          <i data-lucide="panel-left-close" class="w-[18px] h-[18px] flex-shrink-0"></i><span class="eden-sidebar-label truncate" data-i18n="common.collapse">Collapse</span>
        </button>
      </div>
    </aside>`;
}

function injectUI() {
  if (injected) return;
  const anchor = document.querySelector("header");
  if (!anchor) return;
  injected = true;

  document.body.insertAdjacentHTML("afterbegin", sidebarHTML());
  applyWidth();

  document.getElementById("eden-sidebar-logout").addEventListener("click", async () => {
    await signOut(auth);
    location.href = "login.html";
  });

  // Same setLang()/getLang() from js/i18n.js that Me's Preferences tab and the mobile drawer
  // use — one language state, three surfaces, no separate implementation.
  const langButtons = document.querySelectorAll(".sidebar-lang-btn");
  const paintActiveLang = () => {
    langButtons.forEach((btn) => {
      const active = btn.dataset.langChoice === getLang();
      btn.classList.toggle("bg-neonPurple/20", active);
      btn.classList.toggle("text-white", active);
      btn.classList.toggle("text-textGray", !active);
    });
  };
  initI18n().then(() => {
    applyTranslations(document);
    paintActiveLang();
  });
  langButtons.forEach((btn) => btn.addEventListener("click", async () => {
    await setLang(btn.dataset.langChoice);
    paintActiveLang();
  }));
  document.addEventListener("eden:langchange", paintActiveLang);

  const collapseBtn = document.getElementById("eden-sidebar-collapse");
  const collapseIcon = collapseBtn.querySelector("i");
  collapseBtn.addEventListener("click", () => {
    collapsed = !collapsed;
    localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
    applyWidth();
    collapseIcon.setAttribute("data-lucide", collapsed ? "panel-left-open" : "panel-left-close");
    if (window.lucide) window.lucide.createIcons();
  });

  if (window.lucide) window.lucide.createIcons();
}

onAuthStateChanged(auth, (user) => {
  if (user) injectUI();
});
