// Deterministic checks for the Tailwind local build migration (Production Hardening Phase 2).
// No test framework, no network access beyond what an already-installed local devDependency
// needs — mirrors netlify/functions/__tests__/weather.test.js's plain test(name, fn) +
// pass/fail-tally style (an async run() function called fire-and-forget at the very end, never
// a true top-level await, so this file stays unambiguously CommonJS under this repo's root
// package.json, which has no "type" field). Run with:
// node scripts/__tests__/tailwind-migration.test.js (or `npm run test:tailwind-migration`).
// Exits non-zero on any failure.
//
// This script is intentionally self-sufficient rather than assuming a particular invocation
// order: if tailwind.generated.css or site/ don't already exist, it builds them itself (via the
// exact same `npm run build:css` / scripts/build-site.js the real build uses — never a
// hand-rolled compile step) before asserting against them. Safe to run on a clean checkout with
// only `npm ci` already done, or repeatedly after `npm run build`.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

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

// The 25 pages the approved Phase 2 scope converted from the CDN to the local build.
const CONVERTED_PAGES = [
  "home.html", "assistant.html", "index.html", "login.html", "project.html", "resume.html",
  "timeline.html", "time-capsule.html", "settings.html", "reports.html", "habits.html",
  "notifications.html", "profile.html", "gallery.html", "journal.html", "dashboard.html",
  "expenses.html", "constellation.html", "contact.html", "collections.html", "calendar.html",
  "atlas.html", "me.html", "collection-detail.html", "migrate-career.html",
];

async function run() {
  // --- Ensure build artifacts exist before asserting against them (see header comment) ---
  if (!exists("tailwind.generated.css")) {
    execSync("npm run build:css", { cwd: ROOT, stdio: "pipe" });
  }
  if (!exists("site/tailwind.generated.css")) {
    execSync("node scripts/build-site.js", { cwd: ROOT, stdio: "pipe" });
  }

  const allTrackedHtml = fs.readdirSync(ROOT).filter((f) => f.endsWith(".html"));

  await test("exactly 25 pages are in the approved conversion scope", () => {
    assert.strictEqual(CONVERTED_PAGES.length, 25);
  });

  await test("no HTML file (repo root) contains cdn.tailwindcss.com", () => {
    const offenders = allTrackedHtml.filter((f) => read(f).includes("cdn.tailwindcss.com"));
    assert.deepStrictEqual(offenders, []);
  });

  await test("no HTML file (repo root) contains an inline tailwind.config assignment", () => {
    const offenders = allTrackedHtml.filter((f) => /tailwind\.config\s*=/.test(read(f)));
    assert.deepStrictEqual(offenders, []);
  });

  await test("each of the 25 approved pages links tailwind.generated.css exactly once", () => {
    for (const page of CONVERTED_PAGES) {
      const html = read(page);
      const matches = html.match(/tailwind\.generated\.css/g) || [];
      assert.strictEqual(matches.length, 1, `${page} has ${matches.length} tailwind.generated.css references, expected 1`);
      assert.match(html, /<link rel="stylesheet" href="tailwind\.generated\.css">/, `${page} is missing the expected <link> tag shape`);
    }
  });

  await test("portfolio.html (redirect stub) does not link tailwind.generated.css", () => {
    const html = read("portfolio.html");
    assert.ok(!html.includes("tailwind.generated.css"));
    assert.ok(!html.includes("cdn.tailwindcss.com"));
    assert.ok(!/tailwind\.config\s*=/.test(html));
  });

  await test("home.html's stylesheet order is normalized: tailwind.generated.css before styles.css", () => {
    const html = read("home.html");
    const genIdx = html.indexOf("tailwind.generated.css");
    const stylesIdx = html.indexOf('href="styles.css"');
    assert.ok(genIdx !== -1 && stylesIdx !== -1 && genIdx < stylesIdx);
  });

  await test("package.json pins tailwindcss exactly to 3.4.19 (no caret/tilde/range)", () => {
    const pkg = JSON.parse(read("package.json"));
    assert.strictEqual(pkg.devDependencies && pkg.devDependencies.tailwindcss, "3.4.19");
    assert.strictEqual(pkg.dependencies && pkg.dependencies["firebase-admin"], "^14.2.0");
  });

  await test("package-lock.json resolves tailwindcss to exactly 3.4.19", () => {
    const lock = JSON.parse(read("package-lock.json"));
    const node = lock.packages && lock.packages["node_modules/tailwindcss"];
    assert.ok(node, "node_modules/tailwindcss entry missing from package-lock.json");
    assert.strictEqual(node.version, "3.4.19");
  });

  await test("tailwind.config.js contains the required tokens, content globs, and no safelist/plugins", () => {
    const cfg = read("tailwind.config.js");
    // Strip //-line-comments before checking for actual key assignments, so prose in the file's
    // own explanatory comments (which legitimately mentions "darkMode"/"safelist"/"plugins" by
    // name to explain why they're absent) can never produce a false-positive failure here.
    const code = cfg.replace(/\/\/.*$/gm, "");
    const requiredColors = ["darkBg", "cardBg", "borderNeon", "neonPurple", "neonBlue", "neonViolet", "textGray"];
    const requiredHex = ["#0a0a0e", "#17151f", "#2a2833", "#a78bfa", "#6ea8fe", "#8b7cf0", "#9793ab"];
    requiredColors.forEach((token) => assert.ok(code.includes(token), `missing color token ${token}`));
    requiredHex.forEach((hex) => assert.ok(code.includes(hex), `missing hex value ${hex}`));
    ["cyber", "code", "sans"].forEach((font) => assert.ok(code.includes(`${font}:`), `missing fontFamily key ${font}`));
    assert.ok(code.includes('"./*.html"'));
    assert.ok(code.includes('"./*.js"'));
    assert.ok(code.includes('"./js/**/*.js"'));
    assert.ok(code.includes('"!./js/**/__tests__/**"'));
    assert.ok(!/darkMode\s*:/.test(code), "darkMode key must not be set");
    assert.ok(!/safelist\s*:/.test(code), "safelist key must not be present");
    assert.ok(!/plugins\s*:/.test(code), "plugins must not be present");
  });

  await test("tailwind-input.css contains only the three required @tailwind directives", () => {
    // Normalize line endings before comparing, not the file itself: this repo is edited on both
    // Windows (core.autocrlf=true checks this out with CRLF) and Unix checkouts (LF) — the
    // committed blob is LF-only (verified: `git show HEAD:tailwind-input.css` has no \r), so a
    // platform-specific working-tree line ending is a checkout artifact, not a real content
    // difference, and must never fail this check. Still asserts the exact three directives, in
    // the exact order, with no extra content — CRLF/CR normalization only, no other leniency.
    const raw = read("tailwind-input.css");
    const normalized = raw.replace(/\r\n?/g, "\n").trim();
    assert.strictEqual(normalized, "@tailwind base;\n@tailwind components;\n@tailwind utilities;");
  });

  await test("tailwind.generated.css exists and is non-empty after build:css", () => {
    const stat = fs.statSync(path.join(ROOT, "tailwind.generated.css"));
    assert.ok(stat.size > 0);
  });

  await test("generated CSS includes representative critical utilities", () => {
    const css = read("tailwind.generated.css");
    const required = [
      "bg-darkBg", "bg-cardBg", "border-borderNeon", "text-neonPurple", "text-neonBlue",
      "text-textGray", "font-cyber", "font-code", "font-sans",
    ];
    required.forEach((cls) => assert.ok(css.includes(cls), `missing critical utility: ${cls}`));
    // At least one slash-opacity utility (Tailwind CSS-escapes "/" as "\/" in the selector).
    assert.ok(/\\\/\d+\{/.test(css) || css.includes("bg-cardBg\\/90"), "no slash-opacity utility found in compiled CSS");
    // At least one arbitrary-value text utility (used throughout career.js/atlas.js/etc).
    assert.ok(css.includes("text-\\[10px\\]") || /text-\\\[\d+px\\\]/.test(css), "no arbitrary-value text utility found in compiled CSS");
  });

  await test("scripts/build-site.js explicitly allowlists tailwind.generated.css", () => {
    const src = read(path.join("scripts", "build-site.js"));
    assert.ok(/["']tailwind\.generated\.css["']/.test(src));
    const copiedSection = src.split("NOT copied")[0] || "";
    assert.ok(!/["']tailwind\.config\.js["']/.test(copiedSection), "tailwind.config.js must not appear in the copied allowlist section");
    assert.ok(!/["']tailwind-input\.css["']/.test(copiedSection), "tailwind-input.css must not appear in the copied allowlist section");
  });

  await test("site/tailwind.generated.css exists after the full build", () => {
    const stat = fs.statSync(path.join(ROOT, "site", "tailwind.generated.css"));
    assert.ok(stat.size > 0);
  });

  await test("site/ excludes Tailwind source, package files, tests, and build scripts", () => {
    const excluded = [
      "tailwind.config.js", "tailwind-input.css", "package.json", "package-lock.json",
      path.join("scripts", "build-site.js"),
      path.join("scripts", "__tests__", "tailwind-migration.test.js"),
    ];
    excluded.forEach((rel) => {
      assert.ok(!fs.existsSync(path.join(ROOT, "site", rel)), `site/${rel} should not exist`);
    });
    assert.ok(!fs.existsSync(path.join(ROOT, "site", "scripts")));
    assert.ok(!fs.existsSync(path.join(ROOT, "site", "js", "__tests__")));
  });

  await test("service-worker.js PRECACHE includes tailwind.generated.css", () => {
    const sw = read("service-worker.js");
    const precacheBlock = sw.slice(sw.indexOf("const PRECACHE"), sw.indexOf("const BYPASS_HOSTS"));
    assert.ok(precacheBlock.includes('"tailwind.generated.css"'));
  });

  await test("service-worker.js CACHE is at least eden-shell-v30", () => {
    // Exact-pinned to v30 through the Tailwind migration pass itself; a later, unrelated pass
    // (e.g. the Recent Memories invisible-click-target fix) is expected to bump this further —
    // this test only needs to confirm the migration's own bump was never silently reverted.
    const sw = read("service-worker.js");
    const match = sw.match(/const CACHE = "eden-shell-v(\d+)";/);
    assert.ok(match, "service-worker.js is missing the expected CACHE = \"eden-shell-vN\" line");
    assert.ok(Number(match[1]) >= 30, `expected eden-shell-v30 or later, got eden-shell-v${match[1]}`);
  });

  await test("cdn.tailwindcss.com is absent from service-worker.js BYPASS_HOSTS", () => {
    const sw = read("service-worker.js");
    const bypassStart = sw.indexOf("const BYPASS_HOSTS");
    const bypassBlock = sw.slice(bypassStart, bypassStart + 400);
    assert.ok(!bypassBlock.includes("cdn.tailwindcss.com"));
  });

  await test("service-worker.js still bypasses every other pre-existing host/path", () => {
    const sw = read("service-worker.js");
    ["gstatic.com", "googleapis.com", "firebaseapp.com", "openweathermap.org", "cdnjs.cloudflare.com", "cdn.jsdelivr.net", "unpkg.com", "aliyuncs.com"].forEach((host) => {
      assert.ok(sw.includes(host), `missing pre-existing bypass host: ${host}`);
    });
    assert.ok(sw.includes("/.netlify/functions/"), "must still bypass Netlify Function responses");
  });

  await test("netlify.toml invokes the repository build script, not a duplicated Tailwind command", () => {
    const toml = read("netlify.toml");
    assert.match(toml, /command\s*=\s*"npm run build"/);
    assert.ok(!/tailwindcss/.test(toml), "netlify.toml must not duplicate the Tailwind CLI invocation");
  });

  await test("package.json build script runs build:css, then generate-deploy-origin, then build-site.js", () => {
    // Updated by the Atlas Assistant Deploy Preview CORS fix — pkg.scripts.build legitimately
    // grew a new step (scripts/generate-deploy-origin.js, which must run before Netlify bundles
    // Functions with esbuild, i.e. before this whole command finishes; its exact position
    // relative to build-site.js doesn't matter functionally, since the two write to unrelated
    // locations, but stays between build:css and build-site.js for a stable, documented order).
    const pkg = JSON.parse(read("package.json"));
    assert.strictEqual(pkg.scripts.build, "npm run build:css && node scripts/generate-deploy-origin.js && node scripts/build-site.js");
    assert.strictEqual(pkg.scripts["build:css"], "tailwindcss -c tailwind.config.js -i ./tailwind-input.css -o ./tailwind.generated.css --minify");
    assert.strictEqual(pkg.scripts["watch:css"], "tailwindcss -c tailwind.config.js -i ./tailwind-input.css -o ./tailwind.generated.css --watch");
    assert.strictEqual(pkg.scripts["generate:deploy-origin"], "node scripts/generate-deploy-origin.js");
  });

  await test("existing test scripts (test:functions, test:frontend, test) still run every prior suite", () => {
    // Structural check (split each npm script on "&&" into its individual commands), not a
    // fragile whole-string equality or a loose "contains somewhere" regex: test:frontend
    // legitimately grew a new, ADDITIONAL entry (js/__tests__/home-recent-memories.test.js, the
    // Recent Memories invisible-click-target regression fix) after this migration pass, but every
    // command that ran before this pass must still be present, unmodified, and in its original
    // relative order — this is a strict superset check, not a loosened one.
    const splitCmds = (script) => script.split("&&").map((c) => c.trim());
    const pkg = JSON.parse(read("package.json"));

    const functionsCmds = splitCmds(pkg.scripts["test:functions"]);
    // assistant.test.js/weather.test.js/anilist.test.js are the prior baseline; discover-ai.test.js
    // (Discover AI — Qwen Chinese translation + "For You" recommendations) is the new addition on
    // top — never a silent removal disguised as a reorder.
    const priorFunctionsCmds = [
      "node netlify/functions/__tests__/assistant.test.js",
      "node netlify/functions/__tests__/weather.test.js",
      "node netlify/functions/__tests__/anilist.test.js",
    ];
    let functionsCursor = 0;
    priorFunctionsCmds.forEach((cmd) => {
      const idx = functionsCmds.indexOf(cmd, functionsCursor);
      assert.ok(idx !== -1 && idx >= functionsCursor, `test:functions dropped or reordered pre-existing command: ${cmd}`);
      functionsCursor = idx + 1;
    });
    assert.deepStrictEqual(functionsCmds, [
      ...priorFunctionsCmds,
      "node netlify/functions/__tests__/discover-ai.test.js",
    ]);

    const frontendCmds = splitCmds(pkg.scripts["test:frontend"]);
    // "Prior" here means "predates the Discover AI (Qwen translation + For You) pass's own new
    // suites," reconciled by folding every previously-new addition (xss-security.test.js,
    // auth-pulse-scope.test.js, discover-security.test.js, discover-tabs.test.js,
    // discover-description.test.js) into this baseline list — the same "new addition becomes next
    // pass's baseline" convention this assertion has followed every time it was updated before.
    const priorFrontendCmds = [
      "node js/__tests__/date-utils.test.js",
      "node js/__tests__/reflection.test.js",
      "node js/__tests__/home-recent-memories.test.js",
      "node js/__tests__/xss-security.test.js",
      "node js/__tests__/auth-pulse-scope.test.js",
      "node js/__tests__/discover-security.test.js",
      "node js/__tests__/discover-tabs.test.js",
      "node js/__tests__/discover-description.test.js",
    ];
    // Every pre-existing command is still present, in its original relative order (a genuine
    // ordered-subsequence check, not just an unordered "includes all of" set check).
    let cursor = 0;
    priorFrontendCmds.forEach((cmd) => {
      const idx = frontendCmds.indexOf(cmd, cursor);
      assert.ok(idx !== -1 && idx >= cursor, `test:frontend dropped or reordered pre-existing command: ${cmd}`);
      cursor = idx + 1;
    });
    // And exactly two new commands were added on top — Discover AI's "For You" tab-lifecycle
    // suite and its Translate to Chinese / View Original + localStorage-cache suite — never a
    // silent removal disguised as a reorder.
    assert.deepStrictEqual(frontendCmds, [
      ...priorFrontendCmds,
      "node js/__tests__/discover-foryou.test.js",
      "node js/__tests__/discover-translate.test.js",
    ]);

    assert.strictEqual(pkg.scripts.test, "npm run test:functions && npm run test:frontend");
  });

  await test(".gitignore ignores tailwind.generated.css without disturbing existing entries", () => {
    const gi = read(".gitignore");
    assert.ok(gi.includes("/tailwind.generated.css"));
    assert.ok(gi.includes("/site/"));
    assert.ok(gi.includes("node_modules/"));
    assert.ok(gi.includes("/netlify/functions/lib/deploy-origin.generated.json"));
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log("\nFailures:");
    failures.forEach(({ name, err }) => console.log(`  - ${name}: ${err.message}`));
    process.exitCode = 1;
  }
}

run();
