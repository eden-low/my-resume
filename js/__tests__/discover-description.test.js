// Regression tests for the PR #8 Live QA finding: AniList's `description(asHtml: false)` field is
// documented to still leave inline markup (<br>, <i>, <b>, ...) literally embedded in the "plain"
// string it returns. discover.js's detail modal used to run that raw string through esc()
// (HTML-escape only) and interpolate it into an innerHTML template -- the escaped tag characters
// then displayed as literal visible text ("<br>", "<i>...</i>") instead of real formatting.
//
// Covers two things, in the two established conventions this repo already uses for each kind of
// claim:
//   A) descriptionToPlainText()/decodeHtmlEntities() are pure functions -- extracted from the
//      REAL discover.js source and executed in a vm sandbox, the same technique
//      js/__tests__/discover-security.test.js already established for esc()/safeAniListHref().
//   B) renderAnimeDescription() is a DOM-interaction function (creates elements, reads layout
//      properties, wires a click listener) -- loaded into a real jsdom document and exercised
//      with real click()/textContent assertions, the same technique
//      js/__tests__/discover-tabs.test.js already established for the subtab click-wiring fix.
//
// Run with: node js/__tests__/discover-description.test.js

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

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

function readSrc(file) {
  return fs.readFileSync(path.join(ROOT, file), "utf8");
}

const DISCOVER_SRC = readSrc("discover.js");

// ---- Extraction helpers (same technique as discover-security.test.js / discover-tabs.test.js) ----

function extractFunctionSource(src, name) {
  const marker = `function ${name}(`;
  const markerStart = src.indexOf(marker);
  assert.ok(markerStart !== -1, `${name}() not found in discover.js`);
  const asyncPrefix = "async ";
  const start = src.slice(Math.max(0, markerStart - asyncPrefix.length), markerStart) === asyncPrefix
    ? markerStart - asyncPrefix.length
    : markerStart;
  let depth = 0;
  let i = markerStart + marker.length - 1;
  for (; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  const bodyBraceStart = src.indexOf("{", i);
  depth = 0;
  let j = bodyBraceStart;
  for (; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") {
      depth--;
      if (depth === 0) { j++; break; }
    }
  }
  return src.slice(start, j);
}

function extractConstSource(src, marker) {
  const start = src.indexOf(marker);
  assert.ok(start !== -1, `"${marker}" not found in discover.js`);
  const end = src.indexOf(";", start);
  assert.ok(end !== -1, `no terminating ";" found for "${marker}"`);
  return src.slice(start, end + 1);
}

const HTML_ENTITY_MAP_SRC = extractConstSource(DISCOVER_SRC, "const HTML_ENTITY_MAP = {");
const DECODE_HTML_ENTITIES_SRC = extractFunctionSource(DISCOVER_SRC, "decodeHtmlEntities");
const DESCRIPTION_TO_PLAIN_TEXT_SRC = extractFunctionSource(DISCOVER_SRC, "descriptionToPlainText");
const RENDER_ANIME_DESCRIPTION_SRC = extractFunctionSource(DISCOVER_SRC, "renderAnimeDescription");

// ==================================================================================
// Section A — descriptionToPlainText()/decodeHtmlEntities(): pure-function behavior, executed via
// vm against the REAL extracted source.
// ==================================================================================

function loadDescriptionToPlainText() {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(
    `${HTML_ENTITY_MAP_SRC}\n${DECODE_HTML_ENTITIES_SRC}\n${DESCRIPTION_TO_PLAIN_TEXT_SRC}\nglobalThis.__fn = descriptionToPlainText;`,
    sandbox
  );
  return sandbox.__fn;
}
const descriptionToPlainText = loadDescriptionToPlainText();

await test("real inline formatting tags (<i>) are removed, keeping the inner text (the exact reported bug)", () => {
  assert.strictEqual(
    descriptionToPlainText("<i>Attack on Titan</i> tells the story of humanity's last stand."),
    "Attack on Titan tells the story of humanity's last stand."
  );
});

await test("a single <br> becomes a real newline", () => {
  assert.strictEqual(descriptionToPlainText("Line one.<br>Line two."), "Line one.\nLine two.");
});

await test("<br><br> (AniList's paragraph-break convention) becomes a blank-line paragraph gap", () => {
  assert.strictEqual(descriptionToPlainText("Paragraph one.<br><br>Paragraph two."), "Paragraph one.\n\nParagraph two.");
});

await test("<br> variants are all recognized case-insensitively with/without self-closing slash", () => {
  assert.strictEqual(descriptionToPlainText("A<br>B<BR>C<br/>D<br />E<Br  >F"), "A\nB\nC\nD\nE\nF");
});

await test("nested formatting tags are all stripped in one pass, regardless of nesting depth", () => {
  assert.strictEqual(descriptionToPlainText("<b><i>Bold italic</i></b> text"), "Bold italic text");
  assert.strictEqual(descriptionToPlainText("<div><span><i>deeply nested</i></span></div>"), "deeply nested");
});

await test("ordinary HTML entities are decoded (named and numeric/hex)", () => {
  assert.strictEqual(descriptionToPlainText("Good &amp; Evil &mdash; a tale"), "Good & Evil — a tale");
  assert.strictEqual(descriptionToPlainText("&#39;quoted&#39;"), "'quoted'");
  assert.strictEqual(descriptionToPlainText("&#x27;hex-quoted&#x27;"), "'hex-quoted'");
  assert.strictEqual(descriptionToPlainText("100%&nbsp;guaranteed"), "100% guaranteed");
});

await test("missing/empty description input returns an empty string (caller renders the localized fallback)", () => {
  assert.strictEqual(descriptionToPlainText(null), "");
  assert.strictEqual(descriptionToPlainText(undefined), "");
  assert.strictEqual(descriptionToPlainText(""), "");
  assert.strictEqual(descriptionToPlainText(42), "");
});

// ---- Malicious/unexpected markup (requirement 3 / 11) ----

await test("a <script> tag and its content are removed entirely, not just escaped", () => {
  const out = descriptionToPlainText("<script>alert(document.cookie)</script>Hello");
  assert.strictEqual(out, "Hello");
  assert.ok(!out.includes("script"), "no trace of the script tag or its payload text may survive");
  assert.ok(!out.includes("alert"));
});

await test("a <style> tag and its content are removed entirely", () => {
  assert.strictEqual(descriptionToPlainText("<style>body{background:url(javascript:alert(1))}</style>Hello"), "Hello");
});

await test("an <img onerror=...> payload is removed as a self-contained void tag (no inner text to leak)", () => {
  const out = descriptionToPlainText('<img src=x onerror=alert(1)>Hello');
  assert.strictEqual(out, "Hello");
  assert.ok(!out.includes("onerror") && !out.includes("alert"));
});

await test("a malformed tag with no closing '>' is left as inert literal text -- never a security issue since the caller only ever assigns via textContent, but documented here as the known display-quality limitation", () => {
  const out = descriptionToPlainText("<img src=x onerror=alert(1)");
  assert.strictEqual(out, "<img src=x onerror=alert(1)");
});

await test("an entity-encoded 'tag' only ever decodes into inert literal display text, never a live re-parsed tag (decoding runs LAST, after all real tag-stripping)", () => {
  const out = descriptionToPlainText("&lt;script&gt;alert(1)&lt;/script&gt;");
  // The output legitimately CONTAINS the literal characters "<script>" as plain text -- that is
  // safe by construction (the caller assigns this string via .textContent only, see Section B),
  // and is the whole point of decoding last: this string can never be handed to innerHTML by
  // this function or its caller, so its literal content poses no risk regardless of what it says.
  assert.strictEqual(out, "<script>alert(1)</script>");
});

await test("a doubly-nested encoded/malformed combination never throws and never reintroduces a live tag", () => {
  const out = descriptionToPlainText("&lt;img src=x onerror=alert(1)&gt;<script>evil()</script>&amp;<br>done");
  assert.strictEqual(typeof out, "string");
  assert.ok(!out.includes("evil()"));
  assert.ok(out.includes("done"));
});

await test("a non-tag angle-bracket emoticon with no matching '>' anywhere is preserved, not mistaken for a tag", () => {
  assert.strictEqual(descriptionToPlainText("I love this show <3"), "I love this show <3");
});

await test("three or more consecutive blank lines collapse to a single paragraph gap", () => {
  assert.strictEqual(descriptionToPlainText("A<br><br><br><br>B"), "A\n\nB");
});

await test("a realistic long AniList-shaped description (mixed <br>, <i>, entities, a trailing (Source: ...) line) renders as clean readable plain text", () => {
  const raw =
    "<i>Ten years ago</i>, humanity was pushed to the brink of extinction by giant humanoid " +
    "Titans.<br><br>Behind protective walls, humanity has thrived in a state of comfort &mdash; " +
    "or so it seemed.<br><br>(Source: Crunchyroll, edited)";
  const out = descriptionToPlainText(raw);
  assert.strictEqual(
    out,
    "Ten years ago, humanity was pushed to the brink of extinction by giant humanoid Titans.\n\n" +
      "Behind protective walls, humanity has thrived in a state of comfort — or so it seemed.\n\n" +
      "(Source: Crunchyroll, edited)"
  );
});

// ==================================================================================
// Section B — renderAnimeDescription(): real DOM behavior via jsdom (real click()/textContent,
// scrollHeight/clientHeight stubbed per-test to deterministically simulate overflow vs no-
// overflow, since jsdom performs no real layout).
// ==================================================================================

const EN = JSON.parse(readSrc(path.join("locales", "en.json")));
function flattenKeys(obj, prefix = "") {
  let keys = {};
  for (const [k, v] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) keys = { ...keys, ...flattenKeys(v, full) };
    else keys[full] = v;
  }
  return keys;
}
const EN_FLAT = flattenKeys(EN);

function buildHarness({ simulateOverflow = false } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="description-container"></div></body></html>', {
    runScripts: "outside-only",
    url: "https://edenatlas.netlify.app/discover.html",
  });
  const ctx = dom.getInternalVMContext();

  // Real strings from the real en.json -- catches a missing/renamed key just as surely as a
  // dedicated i18n-key-parity test would, while also proving the actual copy is wired correctly.
  ctx.i18nT = (key) => (Object.prototype.hasOwnProperty.call(EN_FLAT, key) ? EN_FLAT[key] : key);

  const script = `
    ${HTML_ENTITY_MAP_SRC}
    ${DECODE_HTML_ENTITIES_SRC}
    ${DESCRIPTION_TO_PLAIN_TEXT_SRC}
    ${RENDER_ANIME_DESCRIPTION_SRC}
    globalThis.__renderAnimeDescription = renderAnimeDescription;
  `;
  vm.runInContext(script, ctx);

  const document = dom.window.document;
  const container = document.getElementById("description-container");

  // jsdom performs no real layout -- scrollHeight/clientHeight are always 0, meaning the real
  // overflow check (`p.scrollHeight > p.clientHeight + 1`) would never fire without help. This
  // intercepts document.createElement("p") (the only element type renderAnimeDescription() reads
  // those properties from) to stub deterministic, per-test values -- the same well-established
  // technique used for testing "clamp + show more" components without a real browser, and it
  // exercises the REAL, unmodified overflow-check expression in the shipped source, not a
  // reimplementation of it.
  const realCreateElement = document.createElement.bind(document);
  document.createElement = (tag) => {
    const el = realCreateElement(tag);
    if (tag === "p") {
      Object.defineProperty(el, "scrollHeight", { value: simulateOverflow ? 300 : 100, configurable: true });
      Object.defineProperty(el, "clientHeight", { value: 100, configurable: true });
    }
    return el;
  };

  return {
    dom,
    document,
    container,
    render: (media) => vm.runInContext("renderAnimeDescription(container, media);", Object.assign(ctx, { container, media })),
  };
}

await test("a short (non-overflowing) description renders complete, with no expand button at all", () => {
  const h = buildHarness({ simulateOverflow: false });
  h.render({ description: "A short synopsis." });

  const p = h.container.querySelector("p");
  assert.ok(p, "expected a <p> element");
  assert.strictEqual(p.textContent, "A short synopsis.");
  assert.ok(!p.classList.contains("text-textGray"), "a real description must not use the fallback's muted styling");
  assert.strictEqual(h.container.querySelector("button"), null, "a short description must never show an expand/collapse button");
});

await test("a missing description renders the localized 'No description available.' fallback, with no button", () => {
  const h = buildHarness({ simulateOverflow: false });
  h.render({ description: null });

  const p = h.container.querySelector("p");
  assert.strictEqual(p.textContent, "No description available.");
  assert.ok(p.classList.contains("text-textGray"), "the fallback must use muted styling, distinct from a real description");
  assert.strictEqual(h.container.querySelector("button"), null);
});

await test("a missing description never shows a button even if scrollHeight/clientHeight would otherwise suggest overflow (fallback text is short by construction, but this guards the branch order)", () => {
  const h = buildHarness({ simulateOverflow: true });
  h.render({ description: "" });
  assert.strictEqual(h.container.querySelector("button"), null);
});

await test("a long (overflowing) description is clamped and shows a 'Show more' button", () => {
  const h = buildHarness({ simulateOverflow: true });
  h.render({ description: "A very long synopsis that would wrap across many lines in the real UI." });

  const p = h.container.querySelector("p");
  assert.ok(p.classList.contains("line-clamp-6"), "an overflowing description must be visually clamped to ~6 lines");
  const btn = h.container.querySelector("button.description-toggle-btn");
  assert.ok(btn, "expected a Show more/less toggle button");
  assert.strictEqual(btn.textContent, "Show more");
  assert.strictEqual(btn.type, "button", "must not be type=submit inside any surrounding form");
});

await test("clicking 'Show more' expands the description (removes the clamp) and flips the label to 'Show less'; clicking again re-collapses", () => {
  const h = buildHarness({ simulateOverflow: true });
  h.render({ description: "A very long synopsis." });

  const p = h.container.querySelector("p");
  const btn = h.container.querySelector("button.description-toggle-btn");

  btn.click();
  assert.ok(!p.classList.contains("line-clamp-6"), "expanding must remove the clamp class");
  assert.strictEqual(btn.textContent, "Show less");

  btn.click();
  assert.ok(p.classList.contains("line-clamp-6"), "collapsing must re-add the clamp class");
  assert.strictEqual(btn.textContent, "Show more");
});

await test("keyboard activation of the toggle button works (native <button> Enter/Space always dispatches a real 'click' event)", () => {
  const h = buildHarness({ simulateOverflow: true });
  h.render({ description: "A very long synopsis." });
  const btn = h.container.querySelector("button.description-toggle-btn");
  btn.focus();
  assert.strictEqual(h.document.activeElement, btn);
  btn.click();
  assert.strictEqual(btn.textContent, "Show less");
});

await test("re-rendering (e.g. on modal reopen) clears any previous content -- no duplicated <p>/button from a stale prior render", () => {
  const h = buildHarness({ simulateOverflow: true });
  h.render({ description: "First." });
  h.render({ description: "Second." });
  assert.strictEqual(h.container.querySelectorAll("p").length, 1);
  assert.strictEqual(h.container.querySelectorAll("button").length, 1);
  assert.strictEqual(h.container.querySelector("p").textContent, "Second.");
});

await test("uses white-space: pre-line (via the whitespace-pre-line utility class) so preserved newlines actually render as line breaks", () => {
  const h = buildHarness({ simulateOverflow: false });
  h.render({ description: "Line one.<br>Line two." });
  const p = h.container.querySelector("p");
  assert.ok(p.classList.contains("whitespace-pre-line"));
  assert.strictEqual(p.textContent, "Line one.\nLine two.");
});

// ---- Malicious markup end-to-end through the real DOM path (not just the pure function) ----

await test("a <script> payload never produces a <script> element or executes -- the paragraph ends up with plain text only, zero child elements, because assignment is always .textContent", () => {
  const h = buildHarness({ simulateOverflow: false });
  h.render({ description: "<script>window.__pwned = true;</script>Safe text" });

  assert.strictEqual(h.container.querySelector("script"), null, "no <script> element may exist anywhere in the container");
  const p = h.container.querySelector("p");
  assert.strictEqual(p.children.length, 0, "the paragraph must have zero child ELEMENTS -- only a text node, proving textContent (not innerHTML) was used");
  assert.strictEqual(p.textContent, "Safe text");
  assert.strictEqual(h.dom.window.__pwned, undefined, "the injected script must never actually execute");
});

await test("an <img onerror> payload never produces an <img> element in the DOM at all", () => {
  const h = buildHarness({ simulateOverflow: false });
  h.render({ description: '<img src=x onerror="window.__pwned2=true">Safe text' });

  assert.strictEqual(h.container.querySelector("img"), null, "no <img> element may exist anywhere in the container");
  assert.strictEqual(h.dom.window.__pwned2, undefined);
});

await test("an encoded-tag payload renders as inert literal text, never a live element", () => {
  const h = buildHarness({ simulateOverflow: false });
  h.render({ description: "&lt;script&gt;alert(1)&lt;/script&gt;" });

  assert.strictEqual(h.container.querySelector("script"), null);
  const p = h.container.querySelector("p");
  assert.strictEqual(p.children.length, 0);
  assert.strictEqual(p.textContent, "<script>alert(1)</script>");
});

// ==================================================================================
// Section C — structural checks: the old bug pattern must never reappear, and the fix's shape
// must match what Sections A/B actually exercised.
// ==================================================================================

await test("discover.js no longer interpolates media.description (raw or escaped) into any innerHTML template", () => {
  assert.ok(!DISCOVER_SRC.includes("esc(media.description)"), "the exact old bug pattern (esc(media.description) inside a template literal) must not reappear");
  assert.ok(!/\$\{media\.description[^}]*\}/.test(DISCOVER_SRC), "media.description must never be template-interpolated directly");
});

await test("renderDetailModal() calls renderAnimeDescription() against a dedicated placeholder, exactly like the established setImageWithFallback()/[data-cover-img] pattern", () => {
  assert.ok(DISCOVER_SRC.includes('data-description'), "expected a [data-description] placeholder in the modal template");
  assert.ok(DISCOVER_SRC.includes("renderAnimeDescription(animeModalBody.querySelector(\"[data-description]\"), media)"));
});

await test("renderAnimeDescription() assigns the sanitized description via .textContent, never .innerHTML", () => {
  assert.ok(/p\.textContent\s*=/.test(RENDER_ANIME_DESCRIPTION_SRC), "expected a direct p.textContent assignment");
  assert.ok(!/\.innerHTML/.test(RENDER_ANIME_DESCRIPTION_SRC), "renderAnimeDescription() must never touch .innerHTML");
});

// ---- Summary ----
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  process.exitCode = 1;
}
