// Mobile navigation — a fourth sanctioned shared module (auth-guard.js, global-search.js,
// i18n.js), self-injecting its DOM like global-search.js rather than requiring per-page markup.
// The desktop <header> is hidden below the `md` breakpoint (see the `hidden md:block` class
// added to every page's <header>) in favor of what this module injects: a fixed top bar, a
// slide-in drawer, a fixed bottom nav, and a Quick Add action sheet.
import { auth, getUserMode, isOwner } from "../firebase-init.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import { getLang, setLang, init as initI18n, applyTranslations } from "./i18n.js";

const DRAWER_LINKS = [
  { href: "home.html", icon: "fa-house", key: "nav.home", label: "Home" },
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
  // Discover (anime, Phase 1) is strictly Owner-only — product decision. Deliberately absent
  // from LIGHT_DRAWER_LINKS below, so a Friend/Viewer's drawer never shows it, and absent from
  // QUICK_ADD_ITEMS (no "quick add a followed anime" shortcut in Phase 1, per the brief).
  { href: "discover.html", icon: "fa-compass", key: "nav.discover", label: "Discover" },
  { href: "constellation.html", icon: "fa-star", key: "nav.constellation", label: "Constellation" },
  { href: "assistant.html", icon: "fa-wand-magic-sparkles", key: "nav.assistant", label: "Atlas Assistant" },
  { href: "me.html", icon: "fa-circle-user", key: "nav.me", label: "Me" },
];

// v3.2 "Light EdenAtlas" — still used to filter QUICK_ADD_ITEMS below (Career/Finance/Reports/
// Time Capsule/Constellation, same owner-heavy set js/sidebar.js hides); direct URLs still work
// via auth-guard.js's data-owner-only redirect.
const OWNER_ONLY_HREFS = new Set(["resume.html", "expenses.html", "reports.html", "time-capsule.html", "constellation.html"]);

// v3.3.3: a dedicated non-owner drawer list, matching js/sidebar.js's LIGHT_LINKS order and
// content exactly. Previously the Friend/Viewer drawer was DRAWER_LINKS filtered by
// OWNER_ONLY_HREFS, which (a) preserved DRAWER_LINKS' owner-oriented order — Journey landed
// after Inbox instead of after Journal — and (b) never carried Habits at all, since Habits was
// never in DRAWER_LINKS in the first place (v3.3.2's audit flagged both as a desktop/mobile
// nav inconsistency). A dedicated array fixes both while leaving DRAWER_LINKS and the Owner's
// drawer completely untouched.
const LIGHT_DRAWER_LINKS = [
  { href: "home.html", icon: "fa-house", key: "nav.home", label: "Home" },
  { href: "gallery.html", icon: "fa-images", key: "nav.memories", label: "Memories" },
  { href: "atlas.html", icon: "fa-map-location-dot", key: "nav.atlas", label: "Atlas" },
  { href: "journal.html", icon: "fa-book", key: "nav.journal", label: "Journal" },
  { href: "timeline.html", icon: "fa-timeline", key: "nav.journey", label: "Journey" },
  { href: "calendar.html", icon: "fa-calendar-days", key: "nav.calendar", label: "Calendar" },
  { href: "dashboard.html", icon: "fa-chart-line", key: "nav.people", label: "Connections" },
  { href: "notifications.html", icon: "fa-bell", key: "nav.inbox", label: "Inbox" },
  { href: "habits.html", icon: "fa-list-check", key: "nav.habits", label: "Habits" },
  { href: "me.html", icon: "fa-circle-user", key: "nav.me", label: "Me" },
];

const BOTTOM_ITEMS = [
  { href: "home.html", icon: "fa-house", key: "mobilenav.home", label: "Home" },
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

const here = location.pathname.split("/").pop() || "home.html";

// user.displayName/email are Google-account-controlled, not app-controlled — escape before
// interpolating into the insertAdjacentHTML template below.
function escapeHTML(str) {
  return str.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function injectUI(user) {
  // window-scoped (not a module-level `let`) so a second accidental <script> tag for this same
  // module on one page — which would otherwise get its own fresh module instance with its own
  // "not yet injected" flag — can't inject a duplicate topbar/drawer/bottom-nav and double-bind
  // every listener on top of it. Checked again at the very end, AFTER binding — see below for why.
  if (window.__edenMobileNavBound) return;
  const anchor = document.querySelector("header");
  if (!anchor) return;

  // Inject only if missing — idempotent, so a later retry of this function (see below) after an
  // earlier attempt injected the DOM but failed before finishing doesn't insert a second copy.
  if (!document.getElementById("mobile-topbar")) {
    // Prefer isOwner(user) (a direct email check on the live Firebase user) over the cached
    // lfj:userMode alone — that cache can be missing (cleared storage, iOS Safari private/ITP,
    // a device that's never been through login.html's resolveUserMode()) and getUserMode()'s own
    // fallback is "VIEWER", which would wrongly drop the owner to the light nav instead of just
    // failing open to full nav for the one account that's always allowed everywhere.
    const isOwnerRole = isOwner(user) || getUserMode() === "OWNER";
    document.body.insertAdjacentHTML("afterbegin", topBarHTML());
    document.body.insertAdjacentHTML("beforeend", drawerHTML(isOwnerRole, user));
    document.body.insertAdjacentHTML("beforeend", bottomNavHTML());
    document.body.insertAdjacentHTML("beforeend", quickAddHTML(isOwnerRole));
  }

  const { drawer, backdrop, hamburger } = getDrawerEls();
  if (!hamburger || !drawer || !backdrop) {
    // Don't set the bound guard here — an onAuthStateChanged re-fire (token refresh, etc.) gets
    // another chance to finish injection/binding instead of this page being permanently stuck
    // half-initialized because the guard was already flipped true from a run that never finished.
    console.error("[MobileNav] missing required elements after injection", { hamburger: !!hamburger, drawer: !!drawer, backdrop: !!backdrop });
    return;
  }

  // Re-assert closed state now that the DOM definitely exists — see forceClosedInitialState()'s
  // own comment for why this isn't just "trust the template string's initial classes."
  forceClosedInitialState();

  if (window.__edenMobileNavBound) return;
  wireTopBar();
  wireDrawer();
  wireBottomNav();
  wireQuickAdd();

  // Mobile WebKit (iOS Safari) can compute a stale hit-test region for a `position:fixed`
  // element that was inserted into the DOM after the initial paint (rather than present in the
  // parsed HTML) — it's drawn in the correct place, but taps land on whatever page content is
  // underneath until something forces WebKit to rebuild its hit-test tree, which normally only
  // happens on the user's first real scroll. That's exactly "the hamburger only works after
  // scrolling all the way down" — CSS alone (z-index, opacity, even a transform on the topbar
  // itself) can't fix this, since the problem is a stale *hit-test* region, not a paint/stacking
  // one. It shows up worse on heavier pages (map/chart/larger Firestore query pages) simply
  // because there's more time between injection and the user's first scroll for the stale region
  // to matter. Forcing a synchronous reflow + a same-position scroll + a resize event right after
  // injection gives WebKit that rebuild immediately instead of waiting on the user to scroll.
  void document.body.offsetHeight;
  window.scrollTo(window.scrollX, window.scrollY);
  window.dispatchEvent(new Event("resize"));
  // A second, delayed nudge covers content that finishes loading *after* injection (a Leaflet
  // map's tiles, a Firestore query's first snapshot, Chart.js's own layout pass) — each of those
  // is itself a layout change that can re-introduce the same stale hit-test region a moment
  // after the immediate nudge above already ran.
  window.setTimeout(() => {
    void document.body.offsetHeight;
    window.scrollTo(window.scrollX, window.scrollY);
    window.dispatchEvent(new Event("resize"));
  }, 1000);

  // Only now, after every wire*() call has actually run without throwing, is it safe to say
  // "don't do this again" — setting this any earlier (as a previous version of this function
  // did) meant a single unexpected exception partway through binding left the rest of that
  // page's session permanently unbound, with no way to recover short of a full reload.
  window.__edenMobileNavBound = true;
}

function topBarHTML() {
  // #mobile-topbar-brand and its img/span get hard pixel-locked sizing in styles.css (not just
  // the w-5/h-5/truncate Tailwind classes below) — the same "flash of the source PNG's native
  // size before Tailwind Play CDN's JIT compiles this dynamically-injected node's classes" bug
  // fixed for the drawer header logo. On the top bar specifically, a momentarily-oversized image
  // inside this flex row was what pushed the "EdenAtlas" wordmark past the right edge (read as
  // both "a giant logo" and "clipped text") — min-w-0 + truncate below is the second half of the
  // fix, so even in a genuinely narrow layout the wordmark ellipsizes instead of overflowing.
  return `
    <div id="mobile-topbar" class="md:hidden fixed top-0 inset-x-0 z-40 flex items-center justify-between gap-2 px-4 bg-cardBg/90 backdrop-blur-md border-b border-borderNeon">
      <button id="mobile-hamburger-btn" type="button" aria-label="Open menu" aria-expanded="false" class="min-w-[44px] min-h-[44px] flex-shrink-0 flex items-center justify-center text-white text-lg"><i class="fa-solid fa-bars"></i></button>
      <span id="mobile-topbar-brand" class="flex items-center gap-2 min-w-0 overflow-hidden">
        <img src="images/logo-mark.png" alt="" class="w-5 h-5 object-contain flex-shrink-0 eden-logo-plate">
        <span class="font-cyber font-semibold text-sm tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-white to-neonPurple truncate">EdenAtlas</span>
      </span>
      <a href="me.html" aria-label="Account" class="min-w-[44px] min-h-[44px] flex-shrink-0 flex items-center justify-center text-white text-lg"><i class="fa-solid fa-circle-user"></i></a>
    </div>`;
}

function drawerHTML(isOwnerRole, user) {
  const visibleLinks = isOwnerRole ? DRAWER_LINKS : LIGHT_DRAWER_LINKS;
  // `.mobile-drawer-link`/`.mobile-drawer-link.active` are real semantic classes with hard CSS
  // rules in styles.css — the active pill used to be rendered *only* via a Tailwind utility
  // ternary (`text-neonPurple bg-neonPurple/10` vs `text-white hover:bg-darkBg/40`), which is
  // exactly the same class of bug already found and fixed elsewhere in this shell (drawer
  // transform, backdrop opacity, topbar sizing): a utility class on dynamically-injected content
  // depends on the Tailwind Play CDN's runtime JIT compiling it in time, and an opacity-suffixed
  // utility like `bg-neonPurple/10` is exactly the kind of less-common class that JIT can lag on.
  // When it lagged, the active item silently lost its pill/color and looked like "the old design"
  // — this is why Home (first page loaded, JIT warmed up) looked right while a page landed on
  // directly (fresh JIT context) could look inconsistent. The Tailwind classes stay in the
  // markup too (harmless redundancy); the semantic classes are now what's load-bearing.
  const links = visibleLinks.map((item) => {
    const isActive = item.href === here;
    return `
    <a href="${item.href}" ${isActive ? 'aria-current="page"' : ""} class="mobile-drawer-link${isActive ? " active" : ""} flex items-center gap-3 px-3 py-3 min-h-[44px] rounded-xl ${isActive ? "text-neonPurple bg-neonPurple/10" : "text-white hover:bg-darkBg/40"} transition-colors">
      <i class="fa-solid ${item.icon} w-5 text-center"></i> <span data-i18n="${item.key}">${item.label}</span>
    </a>`;
  }).join("");
  // Compact header line 2 — reuses the Auth user object already passed into injectUI(), no
  // extra users/{uid} fetch (that's what me.html's own header is for). Optional by design: if
  // neither is set, the header just shows the wordmark alone.
  const handle = escapeHTML((user && (user.displayName || user.email)) || "");
  // #mobile-drawer and #mobile-drawer-backdrop are independent fixed-position siblings (no
  // wrapping overlay div) — both need to stay in the DOM at all times so their transform/opacity
  // transitions can actually animate; a `display:none` toggle on a wrapper can't be transitioned.
  // Closed state is the *default* class list (backdrop: hidden + opacity-0 + pointer-events-none;
  // drawer: -translate-x-full) so a fresh page load never flashes the drawer open before JS runs.
  return `
    <div id="mobile-drawer-backdrop" class="md:hidden hidden opacity-0 pointer-events-none fixed inset-0 bg-darkBg/80 backdrop-blur-sm"></div>
    <div id="mobile-drawer" role="dialog" aria-label="Navigation menu" class="md:hidden -translate-x-full fixed top-0 left-0 bg-cardBg neon-border-purple">
      <div id="mobile-drawer-header" class="flex items-center justify-between gap-2 px-4 py-3 border-b border-borderNeon/60">
        <span class="flex items-center gap-2 min-w-0">
          <img src="images/logo-mark.png" alt="" class="object-contain flex-shrink-0 eden-logo-plate">
          <span class="min-w-0 leading-tight">
            <span class="block font-cyber font-semibold text-sm text-transparent bg-clip-text bg-gradient-to-r from-white to-neonPurple truncate">EdenAtlas</span>
            ${handle ? `<span class="block text-[11px] text-textGray truncate">${handle}</span>` : ""}
          </span>
        </span>
        <button id="mobile-drawer-close" type="button" aria-label="Close menu" class="min-w-[44px] min-h-[44px] flex items-center justify-center text-textGray hover:text-white text-xl leading-none flex-shrink-0">&times;</button>
      </div>
      <div id="mobile-drawer-nav" class="flex flex-col gap-1 px-3 pt-2">
        ${links}
      </div>
      <div id="mobile-drawer-footer" class="px-3 py-3 space-y-2 border-t border-borderNeon/60">
        <div class="flex items-center justify-between">
          <span class="text-sm text-textGray" data-i18n="settings.language">Language</span>
          <div id="drawer-lang-toggle" class="flex items-center gap-1 bg-darkBg/60 border border-borderNeon rounded-full p-1 text-xs font-code">
            <button data-lang-choice="en" class="drawer-lang-btn px-3 py-1.5 min-h-[36px] rounded-full transition-colors">EN</button>
            <button data-lang-choice="zh-CN" class="drawer-lang-btn px-3 py-1.5 min-h-[36px] rounded-full transition-colors">中文</button>
          </div>
        </div>
        <button id="drawer-logout-btn" type="button" class="w-full flex items-center gap-3 px-3 py-3 min-h-[44px] rounded-xl text-rose-400 hover:bg-rose-400/10 transition-colors">
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
    // min-w-0 overrides flex-1's default min-width:auto — without it, a longer label (e.g.
    // "Connections") sets its own content width as this item's floor and refuses to shrink to
    // its equal 1/5 share, spilling into the neighboring item and reading as overlapping/
    // squeezed text ("HomeMemories"). truncate is the second half: if a label is ever still
    // wider than its slot, it ellipsizes instead of overflowing past the flex item's box.
    return `
      <a href="${item.href}" ${active ? 'aria-current="page"' : ""} class="flex flex-col items-center justify-center gap-0.5 min-w-0 min-h-[44px] flex-1 ${active ? "text-neonPurple" : "text-textGray"}">
        <i class="fa-solid ${item.icon}"></i>
        <span class="bottomnav-label w-full text-center truncate text-[10px] font-code" data-i18n="${item.key}">${item.label}</span>
      </a>`;
  }).join("");
  return `
    <nav id="mobile-bottomnav" class="md:hidden fixed bottom-0 inset-x-0 z-40 flex items-stretch justify-between px-2 bg-cardBg/95 backdrop-blur-md border-t border-borderNeon" style="padding-bottom: env(safe-area-inset-bottom, 0)">
      ${items}
    </nav>`;
}

function quickAddHTML(isOwnerRole) {
  const visibleItems = isOwnerRole
    ? QUICK_ADD_ITEMS
    : QUICK_ADD_ITEMS.filter((item) => !OWNER_ONLY_HREFS.has(item.href.split("?")[0]));
  const items = visibleItems.map((item) => `
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

// Explicit open/closed flag rather than reading a class off the DOM — the hamburger button
// toggles off this, not off whatever classes happen to be on the DOM at the time.
let mobileDrawerOpen = false;

function getDrawerEls() {
  return {
    drawer: document.getElementById("mobile-drawer"),
    backdrop: document.getElementById("mobile-drawer-backdrop"),
    hamburger: document.getElementById("mobile-hamburger-btn"),
    closeBtn: document.getElementById("mobile-drawer-close"),
  };
}

// Called once right after injection, before any listener can fire — re-asserts the closed state
// in code instead of trusting that the template string's initial class list (-translate-x-full /
// hidden opacity-0 pointer-events-none) survived to first paint. The template already has those
// classes, but this makes "closed on load" true by explicit assignment rather than by convention,
// so a future edit to the template can't silently reopen this bug.
function forceClosedInitialState() {
  const { drawer, backdrop } = getDrawerEls();
  mobileDrawerOpen = false;

  document.body.classList.remove("drawer-open");
  document.documentElement.classList.remove("drawer-open");

  if (drawer) {
    drawer.classList.remove("translate-x-0");
    drawer.classList.add("-translate-x-full");
  }

  if (backdrop) {
    backdrop.classList.remove("opacity-100", "pointer-events-auto");
    backdrop.classList.add("hidden", "opacity-0", "pointer-events-none");
  }
}

function openDrawer() {
  const { drawer, backdrop, hamburger } = getDrawerEls();
  if (!drawer || !backdrop) return;
  mobileDrawerOpen = true;

  backdrop.classList.remove("hidden");
  // rAF between un-hiding (display:none -> block) and starting the opacity/transform change —
  // otherwise the browser can coalesce both style changes into a single frame and the
  // fade-in/slide-in never visibly plays.
  requestAnimationFrame(() => {
    backdrop.classList.remove("opacity-0", "pointer-events-none");
    backdrop.classList.add("opacity-100", "pointer-events-auto");

    drawer.classList.remove("-translate-x-full");
    drawer.classList.add("translate-x-0");
  });

  document.body.classList.add("drawer-open");
  document.documentElement.classList.add("drawer-open");
  hamburger?.setAttribute("aria-expanded", "true");
}

function closeDrawer(options = {}) {
  const { drawer, backdrop, hamburger } = getDrawerEls();
  if (!drawer || !backdrop) return;
  mobileDrawerOpen = false;

  drawer.classList.remove("translate-x-0");
  drawer.classList.add("-translate-x-full");

  backdrop.classList.remove("opacity-100", "pointer-events-auto");
  backdrop.classList.add("opacity-0", "pointer-events-none");

  document.body.classList.remove("drawer-open");
  document.documentElement.classList.remove("drawer-open");
  hamburger?.setAttribute("aria-expanded", "false");

  if (options.immediate) {
    backdrop.classList.add("hidden");
    return;
  }

  // Only actually display:none the backdrop after its fade-out finishes (matches the drawer's
  // own 250ms slide) — and only if nothing re-opened the drawer in the meantime.
  window.setTimeout(() => {
    if (!mobileDrawerOpen) backdrop.classList.add("hidden");
  }, 250);
}

function toggleDrawer() {
  if (mobileDrawerOpen) closeDrawer();
  else openDrawer();
}

function wireTopBar() {
  const { hamburger } = getDrawerEls();
  hamburger?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleDrawer();
  });
}

function wireDrawer() {
  const { drawer, backdrop, closeBtn } = getDrawerEls();
  closeBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    closeDrawer();
  });
  backdrop?.addEventListener("click", closeDrawer);
  document.getElementById("drawer-logout-btn")?.addEventListener("click", async () => {
    await signOut(auth);
    location.href = "login.html";
  });
  // Close the drawer the moment a nav link is tapped, rather than leaving it visibly open while
  // the browser navigates away.
  drawer?.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => closeDrawer());
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
    if (event.key === "Escape" && mobileDrawerOpen) {
      closeDrawer();
    }
  });
}

function wireBottomNav() {
  // Optional-chained — these were the one remaining pair of unguarded document.getElementById(...)
  // .addEventListener(...) calls in this module. A throw here (element unexpectedly missing)
  // used to abort the rest of injectUI()'s synchronous body, silently skipping wireQuickAdd() and
  // forceClosedInitialState() entirely on whichever page hit it.
  document.getElementById("mobile-quickadd-btn")?.addEventListener("click", () => {
    document.getElementById("quickadd-sheet-overlay")?.classList.remove("hidden");
  });
}

function wireQuickAdd() {
  const overlay = document.getElementById("quickadd-sheet-overlay");
  const close = () => overlay?.classList.add("hidden");
  document.getElementById("quickadd-sheet-backdrop")?.addEventListener("click", close);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && overlay && !overlay.classList.contains("hidden")) close();
  });
}

// Belt-and-suspenders per this module being `type="module"` (already deferred by spec, so
// document.body always exists by the time any module script runs) — if that ever stopped being
// true for some reason on some page, this retries on DOMContentLoaded instead of failing silently.
function initMobileNav(user) {
  if (!document.body) {
    document.addEventListener("DOMContentLoaded", () => initMobileNav(user), { once: true });
    return;
  }
  injectUI(user);
}

onAuthStateChanged(auth, (user) => {
  if (user) initMobileNav(user);
});
