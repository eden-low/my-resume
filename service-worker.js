// Minimal network-first service worker for offline shell caching.
// Deliberately bypasses Firebase/CDN/weather hosts so it never interferes with
// the auth flow, live Firestore/Storage reads, or third-party API calls.
const CACHE = "lfj-shell-v1";

const PRECACHE = [
  "index.html", "resume.html", "gallery.html", "journal.html", "expenses.html",
  "timeline.html", "dashboard.html", "contact.html", "login.html", "settings.html",
  "styles.css", "scripts.js", "firebase-init.js", "auth-guard.js",
  "gallery.js", "expenses.js", "journal.js", "timeline.js", "dashboard.js", "settings.js",
  "manifest.json",
];

const BYPASS_HOSTS = [
  "gstatic.com",
  "googleapis.com",
  "firebaseapp.com",
  "openweathermap.org",
  "cdn.tailwindcss.com",
  "cdnjs.cloudflare.com",
  "cdn.jsdelivr.net",
];

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
  if (url.origin !== location.origin || BYPASS_HOSTS.some((host) => url.hostname.includes(host))) {
    return; // let the browser handle Auth/Firestore/Storage/weather/CDN requests untouched
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
