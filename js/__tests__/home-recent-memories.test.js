// Regression tests for home.html's "Recent Memories" widget (the fix for the reported
// invisible-but-clickable navigation-target bug: memoryCard() was assigning dynamically-created
// card anchors the `.reveal` class, but scripts.js's scroll-reveal IntersectionObserver only
// ever scans for `.reveal` elements once, at DOMContentLoaded — well before these
// Firestore-driven cards exist. They were never observed, so they stayed at `.reveal`'s base
// `opacity:0` permanently: fully clickable, correctly-routed anchors with no visible content.
//
// home.html has no separate .js file to import (every page here is one standalone inline
// <script type="module"> block, per this codebase's per-page-duplication convention), so this
// file extracts the REAL memoryCard()/renderRecentMemories() source text out of home.html itself
// (never a hand-copied duplicate that could silently drift from the shipped code) and, for
// memoryCard(), actually executes it in a sandboxed vm context against a minimal hand-rolled DOM
// stub — no jsdom/browser framework, matching this repo's "no large browser framework" and
// "existing test style" constraints (see js/__tests__/date-utils.test.js/reflection.test.js).
//
// Run with: node js/__tests__/home-recent-memories.test.js

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const HOME_HTML = fs.readFileSync(path.join(ROOT, "home.html"), "utf8");

let pass = 0;
let fail = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    fail++;
    failures.push({ name, err });
    console.log(`FAIL  - ${name}`);
    console.log(`        ${err.message}`);
  }
}

// ---- Extract a real top-level `function name(...) { ... }` from home.html's inline script ----

function extractFunctionSource(src, name) {
  const marker = `function ${name}(`;
  const start = src.indexOf(marker);
  assert.ok(start !== -1, `${name}() not found in home.html`);
  const braceStart = src.indexOf("{", start);
  let depth = 0;
  let i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  return src.slice(start, i);
}

const memoryCardSrc = extractFunctionSource(HOME_HTML, "memoryCard");
const renderRecentMemoriesSrc = extractFunctionSource(HOME_HTML, "renderRecentMemories");

// ---- Minimal DOM stub: only what memoryCard() actually touches ----

function fakeEscape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function runMemoryCard(href, icon, label, text) {
  const sandbox = {
    document: {
      createElement(tag) {
        assert.strictEqual(tag, "a", "memoryCard must create an <a> element, never a bare <div>");
        return { tagName: "A", href: "", className: "", innerHTML: "" };
      },
    },
    esc: fakeEscape,
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `${memoryCardSrc}\nglobalThis.__result = memoryCard(${JSON.stringify(href)}, ${JSON.stringify(icon)}, ${JSON.stringify(label)}, ${JSON.stringify(text)});`,
    sandbox
  );
  return sandbox.__result;
}

// ==== Populated state: valid records must be visible before they're clickable ====

await test("memoryCard() marks dynamically-created cards is-visible, never reveal", () => {
  const card = runMemoryCard("gallery.html", "fa-image", "Memories", "Beach trip");
  const classes = card.className.split(/\s+/);
  assert.ok(classes.includes("is-visible"), `expected "is-visible" class, got: ${card.className}`);
  assert.ok(
    !classes.includes("reveal"),
    '"reveal" must never be used for a card appended after page load — scripts.js\'s scroll-reveal ' +
      "IntersectionObserver only observes .reveal elements present at DOMContentLoaded, so a later-added " +
      "reveal-classed element would stay opacity:0 forever while remaining fully clickable. " +
      `got: ${card.className}`
  );
});

await test("memoryCard() routes deterministically to the correct visible destination per record type", () => {
  assert.strictEqual(runMemoryCard("gallery.html", "fa-image", "Memories", "x").href, "gallery.html");
  assert.strictEqual(runMemoryCard("journal.html", "fa-book", "Journal", "x").href, "journal.html");
  assert.strictEqual(runMemoryCard("timeline.html", "fa-timeline", "Journey", "x").href, "timeline.html");
});

await test("memoryCard() always renders non-empty visible text, so every card has a real accessible name", () => {
  const card = runMemoryCard("gallery.html", "fa-image", "Memories", "Beach trip");
  assert.ok(card.innerHTML.includes("Beach trip"));
  assert.ok(card.innerHTML.includes("Memories"));
  const textOnly = card.innerHTML.replace(/<[^>]+>/g, "").trim();
  assert.ok(textOnly.length > 0, "card must never render with zero visible text (that would make its accessible name effectively empty)");
});

await test("memoryCard() escapes record text, so a hostile caption/title can never inject markup", () => {
  const card = runMemoryCard("gallery.html", "fa-image", "Memories", "<script>evil</script>");
  assert.ok(!card.innerHTML.includes("<script>evil</script>"));
  assert.ok(card.innerHTML.includes("&lt;script&gt;"));
});

// ==== Invalid/incomplete records: renderRecentMemories() must never hand memoryCard() empty text ====

await test("renderRecentMemories() falls back to a non-empty label for a record missing its title/caption", () => {
  assert.match(renderRecentMemoriesSrc, /latestPhoto\.caption \|\| t\("common\.untitled"\)/, "missing photo caption fallback");
  assert.match(renderRecentMemoriesSrc, /latestJournal\.title \|\| t\("common\.untitled"\)/, "missing journal title fallback");
  assert.match(renderRecentMemoriesSrc, /e\.title \|\| t\("common\.untitled"\)/, "missing event title fallback");
});

await test("renderRecentMemories() only pushes a card when a record actually exists (an empty collection never reaches memoryCard())", () => {
  assert.match(renderRecentMemoriesSrc, /if \(latestPhoto\) cards\.push\(/);
  assert.match(renderRecentMemoriesSrc, /if \(latestJournal\) cards\.push\(/);
});

// ==== Loading state: zero navigation targets, visible or invisible ====

await test("#recent-memories-section's static (pre-JS) markup contains zero <a> elements", () => {
  const sectionMatch = HOME_HTML.match(/<section id="recent-memories-section"[\s\S]*?<\/section>/);
  assert.ok(sectionMatch, "#recent-memories-section not found in home.html");
  assert.ok(!/<a\s/.test(sectionMatch[0]), "the section's own static markup must contain no <a> tags before JS runs");
});

await test("#recent-memories-section starts hidden until data resolves, so there is no blank-but-hit-testable loading frame", () => {
  assert.match(HOME_HTML, /<section id="recent-memories-section" class="hidden">/);
});

// ==== Empty state: visible message, zero navigation targets ====

await test("#recent-memories-empty renders a localized message with no anchor, button, or inline click handler", () => {
  const emptyMatch = HOME_HTML.match(/<div id="recent-memories-empty"[\s\S]*?<\/div>\s*<\/div>/);
  assert.ok(emptyMatch, "#recent-memories-empty not found in home.html");
  const markup = emptyMatch[0];
  assert.ok(!/<a\s/.test(markup), "empty state must not contain an anchor");
  assert.ok(!/<button/.test(markup), "empty state must not contain a button");
  assert.ok(!/onclick=/.test(markup), "empty state must not carry an inline click handler");
  assert.match(markup, /data-i18n="home\.no_recent_memories"/, "empty state must render a localized message");
});

await test("renderRecentMemories() clears the list before showing the empty state on the friend/viewer path (no stale card left behind)", () => {
  assert.match(renderRecentMemoriesSrc, /listEl\.classList\.add\("hidden"\)/);
  assert.match(renderRecentMemoriesSrc, /emptyEl\.classList\.remove\("hidden"\)/);
});

// ==== Service worker cache: this exact fix is the reason the shell version was bumped ====

await test("service-worker.js CACHE has been bumped to at least eden-shell-v31 (this fix's own bump, home.html is precached)", () => {
  const sw = fs.readFileSync(path.join(ROOT, "service-worker.js"), "utf8");
  const m = sw.match(/const CACHE = "eden-shell-v(\d+)";/);
  assert.ok(m, "expected a version-stamped CACHE constant");
  // Pinned to a floor, not an exact string: this fix's own bump was v31, but a later,
  // unrelated fix (e.g. the iOS standalone-PWA sign-in pass) legitimately bumps it further —
  // this test only needs to confirm it never regressed below the version this fix required.
  assert.ok(Number(m[1]) >= 31, "expected the shell version to be at least the bump this fix required");
});

// ==== Decorative marks must never intercept a click meant for real content ====

await test("html::before (the decorative EdenAtlas pulse mark) is non-interactive: pointer-events:none, painted behind all content", () => {
  const styles = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");
  const idx = styles.indexOf("html::before {");
  assert.ok(idx !== -1, "html::before rule not found in styles.css");
  const block = styles.slice(idx, idx + 400);
  assert.match(block, /pointer-events:\s*none/, "html::before must stay pointer-events:none");
  assert.match(block, /z-index:\s*-1/, "html::before must stay behind all real content (z-index:-1)");
});

await test("the splash screen's logo image is marked decorative (empty alt) and its overlay stops intercepting clicks once it starts fading out", () => {
  const splash = fs.readFileSync(path.join(ROOT, "js", "splash.js"), "utf8");
  assert.match(splash, /<img src="images\/logo-mark\.png" alt="">/, "splash logo image must carry an empty alt (decorative)");

  const styles = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");
  const idx = styles.indexOf("#eden-splash.eden-splash-out");
  assert.ok(idx !== -1, "#eden-splash.eden-splash-out rule not found in styles.css");
  const block = styles.slice(idx, idx + 120);
  assert.match(block, /pointer-events:\s*none/, "a fading-out splash overlay must stop intercepting clicks");
});

// ==== Tailwind coverage: every static utility Recent Memories' runtime rendering relies on ====

await test("tailwind.generated.css contains every Tailwind utility memoryCard()'s runtime className relies on", () => {
  const cssPath = path.join(ROOT, "tailwind.generated.css");
  assert.ok(fs.existsSync(cssPath), "tailwind.generated.css must be built first (run `npm run build:css`)");
  const css = fs.readFileSync(cssPath, "utf8");

  const classAttrMatch = memoryCardSrc.match(/el\.className = "([^"]+)"/);
  assert.ok(classAttrMatch, "could not find memoryCard()'s el.className assignment");
  const classes = classAttrMatch[1].split(/\s+/).filter(Boolean);
  assert.ok(classes.length > 5, "sanity check: expected several classes on the card");

  // Project-local classes defined in styles.css, not generated by Tailwind.
  const nonTailwind = new Set(["is-visible", "card-lift", "neon-border-purple", "reveal"]);
  const tailwindEscape = (cls) => cls.replace(/[:./[\]]/g, (c) => `\\${c}`);

  classes.filter((c) => !nonTailwind.has(c)).forEach((cls) => {
    const escaped = tailwindEscape(cls);
    assert.ok(css.includes(escaped) || css.includes(cls), `tailwind.generated.css is missing utility required by Recent Memories: ${cls}`);
  });
});

await test("the Recent Memories grid container's static Tailwind utilities are present in generated CSS", () => {
  const cssPath = path.join(ROOT, "tailwind.generated.css");
  assert.ok(fs.existsSync(cssPath), "tailwind.generated.css must be built first (run `npm run build:css`)");
  const css = fs.readFileSync(cssPath, "utf8");
  const listMatch = HOME_HTML.match(/<div id="recent-memories-list" class="([^"]+)">/);
  assert.ok(listMatch, "#recent-memories-list not found in home.html");
  const classes = listMatch[1].split(/\s+/).filter(Boolean);
  const tailwindEscape = (cls) => cls.replace(/[:./[\]]/g, (c) => `\\${c}`);
  classes.forEach((cls) => {
    const escaped = tailwindEscape(cls);
    assert.ok(css.includes(escaped) || css.includes(cls), `tailwind.generated.css is missing utility required by #recent-memories-list: ${cls}`);
  });
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("\nFailures:");
  failures.forEach(({ name, err }) => console.log(`  - ${name}: ${err.message}`));
  process.exitCode = 1;
}
