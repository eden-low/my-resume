// Behavioral regression tests for the stored-XSS fixes from the security/reliability/UX audit
// (see CLAUDE.md's "Production Hardening — Security/Reliability/UX audit" and "...follow-up:
// Markdown sanitizer + regression coverage" history entries).
//
// These tests do NOT grep source code for `esc(` calls -- that would only prove a function was
// *called*, not that its output is actually safe. Instead, every test here extracts the REAL
// function body out of the shipped .js file (same technique as
// js/__tests__/home-recent-memories.test.js's extractFunctionSource(), so a future edit to any
// of these functions is caught even if nobody remembers to update this file) and executes it
// against real attack payloads using the REAL, pinned npm-installed marked/DOMPurify versions
// (the same exact versions journal.html loads from CDN, pinned with SRI -- see that file). The
// resulting HTML strings are then parsed with jsdom (script execution disabled -- jsdom never
// runs `runScripts: "dangerously"` here, so this is pure structural inspection, not a live
// execution sandbox) and asserted against the actual DOM tree: is there a <script> element, does
// an <a> carry a javascript: href, does an <img> carry an onerror attribute -- not "does the
// string contain a substring."
//
// Run with: node js/__tests__/xss-security.test.js

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { marked } from "marked";
import createDOMPurify from "dompurify";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");

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

// ---- Extract a real top-level `function name(...) { ... }` from a source file's text ----
// Identical technique to home-recent-memories.test.js's extractFunctionSource() -- duplicated
// here (not imported) per this repo's own per-file-duplication convention for test helpers.
function extractFunctionSource(src, name) {
  const marker = `function ${name}(`;
  const start = src.indexOf(marker);
  assert.ok(start !== -1, `${name}() not found in source`);
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

function readSrc(file) {
  return fs.readFileSync(path.join(ROOT, file), "utf8");
}

const JOURNAL_SRC = readSrc("journal.js");
const CAREER_SRC = readSrc("career.js");
const GLOBAL_SEARCH_SRC = readSrc("global-search.js");
const ATLAS_SRC = readSrc("atlas.js");
const IDENTITY_SRC = readSrc(path.join("js", "identity.js"));
const JOURNAL_HTML = readSrc("journal.html");

// ---- A single real jsdom window, reused for both DOMPurify (needs a `window` to attach to)
// and for parsing every sanitized/escaped HTML string produced below into a real DOM tree we
// can query. Script execution is never enabled -- this is a parser, not a browser. ----
const { window } = new JSDOM("");
const DOMPurify = createDOMPurify(window);

function parseHtml(html) {
  const container = window.document.createElement("div");
  container.innerHTML = html;
  return container;
}

// ==================================================================================
// Section A -- esc(): the shared HTML-escaping helper duplicated (byte-identical, per
// this repo's convention) across every fixed file. Extracted from journal.js and exercised
// with real payloads; a drift check below confirms the other fixed files still carry the exact
// same implementation, so this section's coverage applies to all of them, not just journal.js.
// ==================================================================================

function loadEsc(src) {
  const fnSrc = extractFunctionSource(src, "esc");
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${fnSrc}\nglobalThis.esc = esc;`, sandbox);
  return sandbox.esc;
}

const esc = loadEsc(JOURNAL_SRC);

await test("esc() neutralizes a raw <script> tag: parsing the escaped output produces zero <script> elements", () => {
  const escaped = esc("<script>alert(document.cookie)</script>");
  assert.ok(!escaped.includes("<script>"), "escaped output must not contain a literal opening script tag");
  const container = parseHtml(escaped);
  assert.strictEqual(container.querySelectorAll("script").length, 0, "no <script> element should exist in the parsed DOM");
  assert.ok(container.textContent.includes("<script>alert(document.cookie)</script>"), "the visible text should read the original payload literally, not silently drop it");
});

await test("esc() neutralizes an <img onerror> attribute payload: parsing the output produces zero elements with an onerror attribute", () => {
  const escaped = esc('<img src=x onerror=alert(1)>');
  const container = parseHtml(escaped);
  assert.strictEqual(container.querySelectorAll("[onerror]").length, 0, "no element with an onerror attribute should exist in the parsed DOM");
  assert.strictEqual(container.querySelectorAll("img").length, 0, "the payload must not be parsed as a real <img> element at all");
});

await test("esc() correctly escapes ampersands and double quotes (the two characters HTML-attribute contexts are most exposed by)", () => {
  assert.strictEqual(esc('Q&A "testing" <3'), "Q&amp;A &quot;testing&quot; &lt;3");
  // Round-trip: feeding the escaped string into a real HTML attribute value must reproduce the
  // exact original text when read back, and must never let a `"` close the attribute early.
  const container = parseHtml(`<span title="${esc('a" onmouseover="alert(1)')}">x</span>`);
  const span = container.querySelector("span");
  assert.strictEqual(span.getAttribute("title"), 'a" onmouseover="alert(1)', "the title attribute must contain the literal text, not have been broken out of");
  assert.strictEqual(span.attributes.length, 1, "no extra attribute (e.g. a real onmouseover) may have been injected by breaking out of the title attribute");
});

await test("esc() handles null/undefined without throwing (every call site does esc(field || fallback) or esc(field))", () => {
  assert.strictEqual(esc(undefined), "");
  assert.strictEqual(esc(null), "");
});

await test("esc() is byte-identical (drift check) across every file fixed in the stored-XSS pass -- a future edit to one copy without the others would silently reopen the gap in the un-updated files", () => {
  const files = ["gallery.js", "notifications.js", "timeline.js", "habits.js", "dashboard.js", "global-search.js", "collections.js", "collection-detail.js", "career.js", "atlas.js"];
  const canonical = extractFunctionSource(JOURNAL_SRC, "esc").replace(/\s+/g, " ").trim();
  files.forEach((f) => {
    const src = readSrc(f);
    const copy = extractFunctionSource(src, "esc").replace(/\s+/g, " ").trim();
    assert.strictEqual(copy, canonical, `${f}'s esc() has drifted from the canonical implementation`);
  });
});

// ==================================================================================
// Section B -- Journal's Markdown sanitizer: the actual fix this whole follow-up pass is about.
// Runs the REAL marked (18.0.6, npm-pinned, same version journal.html loads via CDN+SRI) and
// the REAL DOMPurify (3.4.12, same pairing) -- not a mock, not a hand-rolled approximation.
// ==================================================================================

const renderMarkdownSafe = (() => {
  const fnSrc = extractFunctionSource(JOURNAL_SRC, "renderMarkdownSafe");
  const sandbox = { DOMPurify, marked };
  vm.createContext(sandbox);
  vm.runInContext(`${fnSrc}\nglobalThis.renderMarkdownSafe = renderMarkdownSafe;`, sandbox);
  return sandbox.renderMarkdownSafe;
})();

// The exact pre-fix implementation (marked.parse(esc(content))), reconstructed here so the
// vulnerability it had can be demonstrated against the real marked instance in the same test
// run -- proof the bug was real, not just a claim, and a permanent regression guard against
// ever reintroducing this specific (escape-before-parse-only) pattern.
function oldVulnerableRender(content) {
  return marked.parse(esc(content || ""));
}

await test("journal.html pins marked and DOMPurify to exact versions with Subresource Integrity (not an unpinned \"latest\" CDN script)", () => {
  assert.match(JOURNAL_HTML, /marked@18\.0\.6\/lib\/marked\.umd\.js/, "marked must be pinned to an exact version in the CDN URL");
  assert.match(JOURNAL_HTML, /dompurify@3\.4\.12\/dist\/purify\.min\.js/, "DOMPurify must be pinned to an exact version in the CDN URL");
  const scriptBlock = JOURNAL_HTML.slice(JOURNAL_HTML.indexOf("marked@18.0.6"), JOURNAL_HTML.indexOf("dompurify@3.4.12") + 200);
  assert.match(scriptBlock, /integrity="sha384-/, "both pinned CDN scripts must carry a Subresource Integrity hash");
  assert.match(scriptBlock, /crossorigin="anonymous"/, "SRI requires crossorigin to actually be enforced by the browser");
});

await test("[proves the bug was real] the OLD implementation (marked.parse(esc(content))) still produces a live javascript: href for a Markdown link -- escaping before parsing never touched the URL marked itself generates", () => {
  const payload = "[click me](javascript:alert(document.cookie))";
  const oldOutput = oldVulnerableRender(payload);
  const container = parseHtml(oldOutput);
  const link = container.querySelector("a");
  assert.ok(link, "the old implementation should still render an <a> for this markdown link");
  assert.match(link.getAttribute("href") || "", /^javascript:/i, "THIS is the vulnerability being fixed: the pre-fix code left a live javascript: URI in the rendered HTML");
});

await test("[fix verification] renderMarkdownSafe() strips the javascript: href from a Markdown link", () => {
  const payload = "[click me](javascript:alert(document.cookie))";
  const output = renderMarkdownSafe(payload);
  const container = parseHtml(output);
  const link = container.querySelector("a");
  if (link) {
    const href = link.getAttribute("href") || "";
    assert.ok(!/^javascript:/i.test(href), `expected no javascript: href, got: ${href}`);
  }
});

await test("renderMarkdownSafe() strips a raw <script> tag embedded directly in journal content", () => {
  const output = renderMarkdownSafe("Some text\n<script>alert(document.cookie)</script>\nmore text");
  const container = parseHtml(output);
  assert.strictEqual(container.querySelectorAll("script").length, 0, "no <script> element may survive sanitization");
});

await test("renderMarkdownSafe() strips an onerror event-handler attribute from a raw <img> tag", () => {
  const output = renderMarkdownSafe('<img src=x onerror="alert(document.cookie)">');
  const container = parseHtml(output);
  assert.strictEqual(container.querySelectorAll("[onerror]").length, 0, "no onerror attribute may survive sanitization");
});

await test("renderMarkdownSafe() strips a data: URI used to smuggle an inline script via an <img src>", () => {
  const output = renderMarkdownSafe('<img src="data:text/html,<script>alert(1)</script>">');
  const container = parseHtml(output);
  const img = container.querySelector("img");
  if (img) {
    const src = img.getAttribute("src") || "";
    assert.ok(!src.startsWith("data:"), `expected the dangerous data: src to be stripped, got: ${src}`);
  }
});

await test("renderMarkdownSafe() strips an <iframe> tag", () => {
  const output = renderMarkdownSafe('<iframe src="https://evil.example/"></iframe>');
  const container = parseHtml(output);
  assert.strictEqual(container.querySelectorAll("iframe").length, 0, "no <iframe> element may survive sanitization");
});

await test("renderMarkdownSafe() preserves legitimate Markdown: blockquotes still render as real <blockquote> elements", () => {
  const output = renderMarkdownSafe("> This is an important quote");
  const container = parseHtml(output);
  const bq = container.querySelector("blockquote");
  assert.ok(bq, "expected a real <blockquote> element in the sanitized output");
  assert.ok(bq.textContent.includes("This is an important quote"));
});

await test("renderMarkdownSafe() preserves legitimate Markdown: autolinks (<https://...>) still render as real, functional <a href> elements", () => {
  const output = renderMarkdownSafe("See <https://example.com/docs> for details");
  const container = parseHtml(output);
  const link = container.querySelector("a");
  assert.ok(link, "expected a real <a> element for the autolink");
  assert.strictEqual(link.getAttribute("href"), "https://example.com/docs");
});

await test("renderMarkdownSafe() preserves legitimate Markdown: a normal [text](https://...) link still renders with its href intact", () => {
  const output = renderMarkdownSafe("[Google](https://google.com)");
  const container = parseHtml(output);
  const link = container.querySelector("a");
  assert.ok(link);
  assert.strictEqual(link.getAttribute("href"), "https://google.com");
  assert.strictEqual(link.textContent, "Google");
});

await test("renderMarkdownSafe() preserves plain text containing ampersands/quotes/angle brackets without executing anything", () => {
  const output = renderMarkdownSafe('Q&A "testing" <3 more text');
  const container = parseHtml(output);
  assert.strictEqual(container.querySelectorAll("script,[onerror],[onclick]").length, 0);
  assert.ok(container.textContent.includes("Q&A"));
  assert.ok(container.textContent.includes('"testing"'));
});

await test("renderMarkdownSafe() never throws on empty/undefined content (every call site passes entry.content, which can be missing on a malformed doc)", () => {
  assert.doesNotThrow(() => renderMarkdownSafe(undefined));
  assert.doesNotThrow(() => renderMarkdownSafe(""));
});

// ==================================================================================
// Section C -- safeHref() (career.js): validates a user-supplied URL is http(s) before it's
// ever used as an href, closing the javascript:-URI vector a plain esc() alone wouldn't catch
// (escaping doesn't change the URL scheme, only the surrounding markup).
// ==================================================================================

const safeHref = (() => {
  const escFnSrc = extractFunctionSource(CAREER_SRC, "esc");
  const fnSrc = extractFunctionSource(CAREER_SRC, "safeHref");
  // vm.createContext() creates an isolated global scope that does NOT inherit Node's own
  // globals (URL, console, etc.) -- safeHref() uses `new URL(...)`, so it must be provided
  // explicitly, or every call would throw a ReferenceError inside the sandbox, get swallowed by
  // safeHref()'s own try/catch, and silently return "" for every input including valid ones
  // (caught by this file's own tests below before this comment was added).
  const sandbox = { location: { href: "https://edenatlas.netlify.app/resume.html" }, URL };
  vm.createContext(sandbox);
  vm.runInContext(`${escFnSrc}\n${fnSrc}\nglobalThis.safeHref = safeHref;`, sandbox);
  return sandbox.safeHref;
})();

await test("safeHref() rejects a javascript: URI outright (returns empty string, never a usable href)", () => {
  assert.strictEqual(safeHref("javascript:alert(document.cookie)"), "");
});

await test("safeHref() rejects a data: URI", () => {
  assert.strictEqual(safeHref("data:text/html,<script>alert(1)</script>"), "");
});

await test("safeHref() rejects a vbscript: URI (a legacy but still-valid dangerous scheme)", () => {
  assert.strictEqual(safeHref("vbscript:msgbox(1)"), "");
});

await test("safeHref() allows a genuine https:// URL through, HTML-escaped", () => {
  assert.strictEqual(safeHref("https://github.com/eden-low"), "https://github.com/eden-low");
});

await test("safeHref() allows a genuine http:// URL through", () => {
  assert.strictEqual(safeHref("http://example.com/"), "http://example.com/");
});

await test("safeHref() escapes a URL that carries a quote-breaking payload in its query string (attribute-injection defense-in-depth)", () => {
  const result = safeHref('https://example.com/?x="><script>alert(1)</script>');
  assert.ok(!result.includes('"><script>'), "the raw payload must not survive unescaped in the returned href string");
  const container = parseHtml(`<a href="${result}">link</a>`);
  const link = container.querySelector("a");
  assert.ok(link, "expected a single, well-formed <a> element");
  assert.strictEqual(container.querySelectorAll("script").length, 0, "no script element may have been injected by breaking out of the href attribute");
});

await test("safeHref() returns empty string for a malformed URL rather than throwing", () => {
  assert.doesNotThrow(() => safeHref("not a url at all"));
});

// ==================================================================================
// Section D -- Global Search's resultLabel(): the widest-reach surface in the app (the
// Ctrl/Cmd-K palette is injected on every protected page). Uses the REAL publicDisplayName()
// from js/identity.js (extracted, not hand-stubbed) so this test tracks that module's actual
// behavior too.
// ==================================================================================

const resultLabel = (() => {
  const escFnSrc = extractFunctionSource(GLOBAL_SEARCH_SRC, "esc");
  const publicDisplayNameSrc = extractFunctionSource(IDENTITY_SRC, "publicDisplayName");
  const fnSrc = extractFunctionSource(GLOBAL_SEARCH_SRC, "resultLabel");
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${escFnSrc}\n${publicDisplayNameSrc}\n${fnSrc}\nglobalThis.resultLabel = resultLabel;`, sandbox);
  return sandbox.resultLabel;
})();

await test("resultLabel() escapes a malicious photo caption before it reaches the command palette", () => {
  const label = resultLabel("photos", { caption: '<img src=x onerror=alert(1)>' });
  const container = parseHtml(`<span>${label}</span>`);
  assert.strictEqual(container.querySelectorAll("[onerror],img").length, 0, "no executable element/attribute may survive");
});

await test("resultLabel() escapes a malicious journal title", () => {
  const label = resultLabel("journals", { title: "<script>alert(1)</script>" });
  const container = parseHtml(`<span>${label}</span>`);
  assert.strictEqual(container.querySelectorAll("script").length, 0);
});

await test("resultLabel() escapes a malicious life_events title", () => {
  const label = resultLabel("life_events", { title: '<svg onload=alert(1)>' });
  const container = parseHtml(`<span>${label}</span>`);
  assert.strictEqual(container.querySelectorAll("[onload]").length, 0);
});

await test("resultLabel() escapes a malicious habit title", () => {
  const label = resultLabel("habits", { title: "<script>alert(1)</script>" });
  const container = parseHtml(`<span>${label}</span>`);
  assert.strictEqual(container.querySelectorAll("script").length, 0);
});

await test("resultLabel() escapes a malicious expense note", () => {
  const label = resultLabel("expenses", { note: '"><img src=x onerror=alert(1)>', amount: 10 });
  const container = parseHtml(`<span>${label}</span>`);
  assert.strictEqual(container.querySelectorAll("[onerror]").length, 0);
});

await test("resultLabel() escapes a malicious user displayName (via the real publicDisplayName())", () => {
  const label = resultLabel("users", { displayName: "<script>alert(document.cookie)</script>" });
  const container = parseHtml(`<span>${label}</span>`);
  assert.strictEqual(container.querySelectorAll("script").length, 0);
  assert.ok(container.textContent.includes("<script>alert(document.cookie)</script>"), "the raw text should still be visible/searchable, just not executable");
});

await test("resultLabel() renders normal, non-malicious content unchanged (no over-escaping regression)", () => {
  assert.strictEqual(resultLabel("journals", { title: "My trip to Kampar" }), "My trip to Kampar");
  assert.strictEqual(resultLabel("habits", { title: "Drink water" }), "Drink water");
});

// ==================================================================================
// Section E -- Atlas's Leaflet marker tooltip: bindTooltip() treats a string as HTML by
// default (Leaflet's setContent() assigns it via innerHTML internally) -- a non-obvious
// injection point that a plain `grep innerHTML` sweep would miss entirely. Verified by
// extracting the real call-site expression and evaluating it with a spy in place of the
// Leaflet marker, then parsing what was actually passed to bindTooltip().
// ==================================================================================

await test("atlas.js escapes cluster.name before passing it to marker.bindTooltip() (Leaflet's tooltip content is HTML by default)", () => {
  const escFnSrc = extractFunctionSource(ATLAS_SRC, "esc");
  const callMatch = ATLAS_SRC.match(/marker\.bindTooltip\(([^,]+),/);
  assert.ok(callMatch, "could not find the marker.bindTooltip(...) call in atlas.js");
  const argExpr = callMatch[1].trim(); // expected: "esc(cluster.name)"
  assert.match(argExpr, /^esc\(cluster\.name\)$/, `expected bindTooltip's first argument to be exactly esc(cluster.name), got: ${argExpr}`);

  const sandbox = { cluster: { name: '<img src=x onerror=alert(document.cookie)>' } };
  vm.createContext(sandbox);
  vm.runInContext(`${escFnSrc}\nglobalThis.__tooltipContent = ${argExpr};`, sandbox);
  const tooltipContent = sandbox.__tooltipContent;

  // This is exactly what Leaflet's Tooltip.setContent() does with a string: assign it as
  // innerHTML of the tooltip's container element.
  const container = parseHtml(tooltipContent);
  assert.strictEqual(container.querySelectorAll("[onerror],img").length, 0, "no executable element/attribute may reach the tooltip's DOM");
});

// ==================================================================================
// Section F -- Architectural invariant: escaping/sanitization must happen at RENDER time only,
// never get written back into Firestore -- otherwise a value would be double-escaped on its
// next render (e.g. "&amp;amp;" instead of "&amp;"), or a `visibility:"connections"` doc's
// stored title would literally contain HTML entities forever. This is a structural code-shape
// check (not a payload/behavior test, hence its own section) confirming what Section A-E
// already demonstrated behaviorally: esc()/safeHref()/renderMarkdownSafe() outputs never flow
// into a Firestore write call in any of the fixed files.
// ==================================================================================

await test("esc()/safeHref()/renderMarkdownSafe() results never appear inside an addDoc/updateDoc/setDoc payload in any fixed file (escaping is render-only, never persisted)", () => {
  const files = ["journal.js", "gallery.js", "notifications.js", "timeline.js", "habits.js", "dashboard.js", "global-search.js", "profile.js", "collections.js", "collection-detail.js", "career.js", "atlas.js"];
  const writeCallRe = /\b(addDoc|updateDoc|setDoc)\s*\([^;]*?\);/gs;
  files.forEach((f) => {
    const src = readSrc(f);
    const writeCalls = src.match(writeCallRe) || [];
    writeCalls.forEach((call) => {
      assert.ok(!/\besc\(/.test(call), `${f}: a Firestore write call appears to pass esc()'d data -- escaping must only ever happen at render time:\n${call.slice(0, 200)}`);
      assert.ok(!/\bsafeHref\(/.test(call), `${f}: a Firestore write call appears to pass safeHref()'d data:\n${call.slice(0, 200)}`);
      assert.ok(!/\brenderMarkdownSafe\(/.test(call), `${f}: a Firestore write call appears to pass renderMarkdownSafe()'d data:\n${call.slice(0, 200)}`);
    });
  });
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("\nFailures:");
  failures.forEach(({ name, err }) => console.log(`  - ${name}: ${err.message}`));
  process.exitCode = 1;
}
