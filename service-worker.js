// Minimal network-first service worker for offline shell caching.
// Deliberately bypasses Firebase/CDN/weather hosts so it never interferes with
// the auth flow, live Firestore/Storage reads, or third-party API calls.
// v23 (Qwen Atlas Assistant MVP): adds assistant.html/assistant.js to PRECACHE (the new
// Owner-only page's static client shell — same treatment as every other page/script here).
// Bumped from v22 specifically because v22 was already deployed as its own separate release
// before this pass (per this pass's own instructions: only reuse a version stamp when there is
// evidence it was never shipped on its own) — this guarantees the new assistant.html/assistant.js
// entries actually get fetched into the offline cache on update, rather than an already-active
// v22 service worker never re-running its install step. Also fixes a real (if latent) gap: the
// fetch handler below used to only bypass *cross-origin* requests by host — but
// /.netlify/functions/* is SAME-origin (it's this site's own domain), so a Function response
// (health, and now the AI assistant) would previously have been written into the Cache Storage
// API on every call, regardless of the HTTP `Cache-Control: no-store` header netlify.toml already
// sends (Cache Storage doesn't auto-respect that header — only an explicit fetch-handler bypass
// does). AI answers and any other Function response must always be network-only. The Qwen/
// Alibaba Model Studio endpoint itself is never fetched by the browser at all (only server-side,
// from netlify/functions/assistant.js) — nothing here can ever intercept that call — this SW's
// existing cross-origin bypass (line below) already covers it if that ever changes.
// Earlier: v22 ("Portfolio to root" routing change — index.html is now the public recruiter
// Portfolio, home.html is the private app landing page), v21 (Trash privacy fix), v20 (Memory
// Trash + location-edit fix), v19 (canonical location pipeline fix).
const CACHE = "eden-shell-v23";

const PRECACHE = [
  "index.html", "home.html", "resume.html", "gallery.html", "journal.html", "expenses.html",
  "timeline.html", "dashboard.html", "contact.html", "login.html", "settings.html",
  "habits.html", "notifications.html", "calendar.html", "reports.html",
  "profile.html", "atlas.html", "portfolio.html", "project.html", "assistant.html",
  "styles.css", "scripts.js", "firebase-init.js", "auth-guard.js", "global-search.js",
  "gallery.js", "expenses.js", "journal.js", "timeline.js", "dashboard.js", "settings.js",
  "habits.js", "notifications.js", "export.js", "calendar.js", "insights.js",
  "profile.js", "career.js", "atlas.js", "portfolio.js", "project.js", "assistant.js",
  "js/i18n.js", "js/mobile-nav.js", "js/sidebar.js", "js/splash.js", "js/location-search.js",
  "js/location-fields.js", "js/memory-filters.js", "js/resume-data.js",
  "locales/en.json", "locales/zh-CN.json",
  "manifest.json", "images/icon-192.png", "images/icon-512.png", "images/logo-mark.png",
];

const BYPASS_HOSTS = [
  "gstatic.com",
  "googleapis.com",
  "firebaseapp.com",
  "openweathermap.org",
  "cdn.tailwindcss.com",
  "cdnjs.cloudflare.com",
  "cdn.jsdelivr.net",
  "unpkg.com",
  // Qwen / Alibaba Cloud Model Studio: never actually reachable from this service worker's
  // scope (the browser never calls it directly — only netlify/functions/assistant.js does,
  // server-side), listed anyway as an explicit, self-documenting guarantee rather than relying
  // solely on the cross-origin check below.
  "aliyuncs.com",
];

// Netlify Function invocations — same-origin, so the cross-origin check below does NOT catch
// these on its own. Every response here must be network-only: an AI answer, a rate-limit
// rejection, or an auth error must never be replayed from a cache.
const NEVER_CACHE_PATH_PREFIXES = ["/.netlify/functions/"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const isCrossOrigin = url.origin !== location.origin;
  const isBypassHost = BYPASS_HOSTS.some((host) => url.hostname.includes(host));
  const isNeverCachePath = NEVER_CACHE_PATH_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));

  if (isCrossOrigin || isBypassHost) {
    return; // let the browser handle Auth/Firestore/Storage/weather/CDN requests untouched
  }

  if (isNeverCachePath) {
    // Plain pass-through fetch, no cache.put — Netlify Functions (health, the AI assistant, any
    // future one) are always network-only, matching their own `Cache-Control: no-store` header.
    event.respondWith(fetch(event.request));
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const clone = response.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
