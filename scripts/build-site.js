#!/usr/bin/env node
// EdenAtlas — deterministic allowlisted copy-to-publish build.
//
// Why this exists: netlify.toml used to publish the repo root directly (`publish = "."`) and
// rely on per-file 404-shadow redirects to block non-product files (firestore.rules, CLAUDE.md,
// tmp_*.ts, migrate-career.html, etc). Live testing after deploy found several of those
// redirects did not reliably block the file they targeted, and — worse — `publish = "."` also
// meant the Netlify Functions *source* directory (`netlify/functions/health.js`) was itself
// being served as a static file at `/netlify/functions/health.js`, a structurally different
// (and unintended) path from the real, separately-routed Function endpoint at
// `/.netlify/functions/health`.
//
// The fix here is structural, not another redirect: this script copies an explicit ALLOWLIST of
// files/directories — the actual product — into a generated `site/` directory, and
// `netlify.toml` points `publish` at that directory instead of the repo root. Anything not on
// the allowlist (internal docs, Firebase config, rules source, stray tracked files, the
// Functions source tree) is never copied, so it cannot be served no matter how Netlify's
// redirect engine behaves — there is nothing at that path to serve. `functions =
// "netlify/functions"` in netlify.toml is unaffected: Netlify reads Function source from the
// repo root independently of `publish`, so functions keep working with zero code changes.
//
// No dependencies, no bundler, no transpilation — every file is byte-identical to its source,
// preserving the exact same relative-path structure every page already depends on
// (styles.css/scripts.js/js/*/locales/*/images/* as siblings). This is Netlify's own
// documented `[build] command` pattern, not a new build framework.
//
// Run: `node scripts/build-site.js` (also what Netlify's own build step runs — see
// netlify.toml's `[build] command`).

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "site");

// --- Explicit allowlist. Nothing outside this list is ever copied. ---
// Deliberately hardcoded filenames, not a glob (e.g. not "*.js") — a glob would silently
// re-admit a future accidental commit (like the tmp_chats.ts/tmp_types.ts this pass removed)
// the moment it landed at the repo root. Adding a new real page/script means adding its name
// here on purpose.
const ALLOW_FILES = [
  // Pages
  "atlas.html", "calendar.html", "collection-detail.html", "collections.html",
  "constellation.html", "contact.html", "dashboard.html", "expenses.html", "gallery.html",
  "habits.html", "home.html", "index.html", "journal.html", "login.html", "me.html",
  "notifications.html", "portfolio.html", "profile.html", "project.html", "reports.html",
  "resume.html", "settings.html", "time-capsule.html", "timeline.html", "assistant.html",
  // Page scripts / shared root-level modules
  "atlas.js", "auth-guard.js", "calendar.js", "career.js", "collection-detail.js",
  "collections.js", "constellation.js", "dashboard.js", "expenses.js", "export.js",
  "firebase-init.js", "gallery.js", "global-search.js", "habits.js", "insights.js",
  "journal.js", "me.js", "notifications.js", "portfolio.js", "profile.js", "project.js",
  "scripts.js", "settings.js", "time-capsule.js", "timeline.js", "assistant.js",
  // PWA shell
  "service-worker.js", "manifest.json",
  // Styling — tailwind.generated.css is build output (produced by `npm run build:css` from
  // tailwind.config.js/tailwind-input.css, which are themselves deliberately NOT listed here —
  // source-only config, never published); copyFile() below already throws if an allowlisted
  // file is missing on disk, so a build run before `build:css` has produced this file fails
  // loudly here rather than silently shipping a page with no stylesheet.
  "styles.css", "tailwind.generated.css",
];

// Directories copied recursively, in full — each holds only product assets (client-side shared
// modules, translation dictionaries, images), never source/docs/config.
const ALLOW_DIRS = ["images", "js", "locales"];

// NOT copied, on purpose (kept in Git per the task's "keep in Git, exclude from deploy"
// instruction, or simply never meant to be public): CLAUDE.md, README.md, design-system.md,
// brand-book.md, docs/*, firestore.rules, storage.rules, firebase.json, .firebaserc,
// .gitignore, .env*, netlify.toml, netlify/ (Function source — see the header comment),
// scripts/ (this build tooling), migrate-career.html (see CLAUDE.md/the completion report for
// why it's blocked rather than deleted), tailwind.config.js/tailwind-input.css (Tailwind build
// source — only their compiled output, tailwind.generated.css, is a product asset),
// package.json/package-lock.json (Node dependency manifests), and anything not explicitly
// listed above.

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function copyFile(name) {
  const src = path.join(ROOT, name);
  if (!fs.existsSync(src)) {
    throw new Error(`build-site: allowlisted file is missing on disk: ${name}`);
  }
  const dest = path.join(OUT, name);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

// js/__tests__/ and js/package.json exist purely so Node can run js/*.js's real logic under a
// deterministic test suite (see js/package.json's own description) — neither is product code,
// so both are excluded from the deployed site the same way netlify/, scripts/, and every other
// non-product path already is. fs.cpSync's `filter` receives an absolute src path for every
// file/directory it considers; returning false skips it (and, for a directory, everything under
// it) without needing a second pass or a post-copy cleanup step.
function isTestScaffolding(src) {
  const rel = path.relative(ROOT, src).split(path.sep).join("/");
  return /(^|\/)__tests__(\/|$)/.test(rel) || /(^|\/)package(-lock)?\.json$/.test(rel);
}

function copyDir(name, filter) {
  const src = path.join(ROOT, name);
  if (!fs.existsSync(src)) {
    throw new Error(`build-site: allowlisted directory is missing on disk: ${name}`);
  }
  fs.cpSync(src, path.join(OUT, name), { recursive: true, filter });
}

function build() {
  rmrf(OUT);
  fs.mkdirSync(OUT, { recursive: true });
  ALLOW_FILES.forEach(copyFile);
  // "js" is the only ALLOW_DIRS entry that has ever grown test scaffolding (js/__tests__/,
  // js/package.json) — the filter is a no-op for images/locales, which have never had either.
  ALLOW_DIRS.forEach((name) => copyDir(name, (src) => !isTestScaffolding(src)));
  const fileCount = ALLOW_FILES.length;
  console.log(`build-site: copied ${fileCount} files + ${ALLOW_DIRS.length} directories into ${path.relative(ROOT, OUT)}/`);
}

if (require.main === module) {
  build();
}

module.exports = { build, ALLOW_FILES, ALLOW_DIRS, ROOT, OUT };
