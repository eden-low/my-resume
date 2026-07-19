// Regression test for a manual-QA bug found in Part 2 (Dark/Light audit): styles.css's
// `html::before` EA-mark loading watermark used to carry
// `animation: eden-auth-pulse 1.6s ease-in-out infinite` unconditionally, so it kept pulsing
// forever, not just during the brief auth-check window auth-guard.js actually needs it for. It's
// normally hidden behind opaque page content once auth resolves, but this app is full of
// deliberately translucent, blurred glass cards (bg-cardBg/90, backdrop-blur-sm, etc.) that let
// whatever's compositing behind them show through faintly -- so an infinite opacity animation on
// a full-viewport, always-dark layer (the Part 2 fix that made this backplate always-dark, not
// theme-switching) read as a continuous background flicker, worst in Light mode.
//
// The fix scopes the animation itself to `html:has(body.auth-check-pending)::before` -- CSS's
// own `:has()` relational pseudo-class, universally supported by evergreen browsers this app
// already targets (including iOS Safari 16.4+) -- so no JS change was needed: auth-guard.js
// already toggles that exact class today.
//
// This is a structural check on the real styles.css text (same convention
// home-recent-memories.test.js already uses for CSS assertions, since this repo has no CSS
// parser/computed-style test infrastructure), not a live-browser animation trace -- it proves
// the *shape* of the fix (animation is conditional, not unconditional; reduced-motion still
// covers the conditional selector; the splash's own separate pulse is untouched) rather than
// sampling actual frame-by-frame opacity in a real renderer.
//
// Run with: node js/__tests__/auth-pulse-scope.test.js

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const STYLES = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");

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

// Extracts the first `{ ... }` block immediately following an exact selector string, requiring
// the selector to be followed only by whitespace before the opening brace -- so, e.g., searching
// for "html::before" does NOT accidentally match inside "html:has(body.auth-check-pending)::before".
function extractRuleBlock(css, selector) {
  const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{", "g");
  let match;
  while ((match = re.exec(css))) {
    const braceStart = match.index + match[0].length - 1;
    let depth = 0;
    let i = braceStart;
    for (; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") { depth--; if (depth === 0) { i++; break; } }
    }
    return { block: css.slice(braceStart, i), fullMatch: css.slice(match.index, i) };
  }
  return null;
}

const AUTH_SCOPED_SELECTOR = 'html:has(body.auth-check-pending)::before';

await test("the base (unconditional) html::before rule carries NO animation property -- it must never animate just by existing", () => {
  const rule = extractRuleBlock(STYLES, "html::before");
  assert.ok(rule, "base html::before rule not found in styles.css");
  assert.ok(!/animation\s*:/.test(rule.block), `base html::before must not carry an animation property. Found block:\n${rule.block}`);
});

await test("the base html::before rule has a static opacity so it never snaps to fully opaque once the auth-pending animation stops", () => {
  const rule = extractRuleBlock(STYLES, "html::before");
  assert.ok(rule, "base html::before rule not found in styles.css");
  assert.match(rule.block, /opacity\s*:\s*0\.55/, "expected a static opacity matching the pulse animation's own trough value");
});

await test("the infinite pulse animation is scoped to html:has(body.auth-check-pending)::before -- only while auth-guard.js's own auth-check-pending class is present", () => {
  const rule = extractRuleBlock(STYLES, AUTH_SCOPED_SELECTOR);
  assert.ok(rule, `expected a rule for ${AUTH_SCOPED_SELECTOR} in styles.css`);
  assert.match(rule.block, /animation\s*:\s*eden-auth-pulse\s+1\.6s\s+ease-in-out\s+infinite/, `expected the infinite pulse animation on the scoped selector. Found:\n${rule.block}`);
});

await test("prefers-reduced-motion still disables the pulse -- scoped to the SAME selector (not just the bare html::before), so it actually wins the cascade against the scoped animation rule above (equal specificity, later rule wins)", () => {
  const idx = STYLES.indexOf("@media (prefers-reduced-motion: reduce)");
  let found = false;
  let cursor = idx;
  while (cursor !== -1) {
    const mediaBlockStart = STYLES.indexOf("{", cursor);
    let depth = 0, i = mediaBlockStart;
    for (; i < STYLES.length; i++) {
      if (STYLES[i] === "{") depth++;
      else if (STYLES[i] === "}") { depth--; if (depth === 0) { i++; break; } }
    }
    const mediaBlock = STYLES.slice(mediaBlockStart, i);
    if (mediaBlock.includes(AUTH_SCOPED_SELECTOR) && /animation\s*:\s*none/.test(mediaBlock)) {
      found = true;
      break;
    }
    cursor = STYLES.indexOf("@media (prefers-reduced-motion: reduce)", i);
  }
  assert.ok(found, `expected a @media (prefers-reduced-motion: reduce) block containing "${AUTH_SCOPED_SELECTOR} { animation: none; }"`);
});

await test("the reduced-motion override for the auth-pulse selector has EXACTLY the same selector text as the animating rule (equal CSS specificity is required for the cascade tie-break to reliably favor the later, reduced-motion rule)", () => {
  const animRule = extractRuleBlock(STYLES, AUTH_SCOPED_SELECTOR);
  assert.ok(animRule);
  // The reduced-motion override must appear strictly after the animating rule in source order,
  // since with equal specificity CSS resolves ties by cascade/source order (last rule wins).
  const animIdx = STYLES.indexOf(animRule.fullMatch);
  const reducedMotionIdx = STYLES.indexOf("@media (prefers-reduced-motion: reduce)", animIdx);
  assert.ok(reducedMotionIdx > animIdx, "the reduced-motion override must come after the animating rule in styles.css so it wins the cascade tie-break");
});

await test("no top-level `body { ... }` rule (the normal page background, outside .auth-check-pending) carries an animation property -- the base page must be completely static", () => {
  const rule = extractRuleBlock(STYLES, "body");
  assert.ok(rule, "base body rule not found in styles.css");
  assert.ok(!/animation\s*:/.test(rule.block), `base body rule must never animate. Found:\n${rule.block}`);
  // A one-shot opacity transition (fade-in once auth-check-pending is removed) is expected and
  // fine -- only a persistent `animation` is the bug being guarded against here.
  assert.match(rule.block, /transition\s*:\s*opacity/, "expected the existing one-shot fade-in transition to remain in place");
});

await test("#eden-splash-mark keeps its OWN infinite pulse -- untouched by this fix, since a pulse on the temporary splash overlay while it's visible is explicitly the preferred behavior", () => {
  const rule = extractRuleBlock(STYLES, "#eden-splash-mark");
  assert.ok(rule, "#eden-splash-mark rule not found in styles.css");
  assert.match(rule.block, /animation\s*:\s*eden-auth-pulse\s+1\.6s\s+ease-in-out\s+infinite/, "expected #eden-splash-mark to keep its own infinite pulse while the splash itself is visible");
});

await test("#eden-splash-mark's own reduced-motion override still exists independently", () => {
  assert.match(STYLES, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*#eden-splash\s*\{[\s\S]{0,80}#eden-splash-mark\s*\{\s*animation:\s*none;/, "expected #eden-splash-mark's own prefers-reduced-motion override to remain intact");
});

await test("the print stylesheet still forces the html::before watermark fully off (defense-in-depth, unaffected by this fix)", () => {
  const idx = STYLES.indexOf("@media print");
  assert.ok(idx !== -1, "@media print block not found");
  const printRule = extractRuleBlock(STYLES.slice(idx), "html::before");
  assert.ok(printRule, "expected an html::before override inside @media print");
  assert.match(printRule.block, /display:\s*none\s*!important/);
  assert.match(printRule.block, /animation:\s*none\s*!important/);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("\nFailures:");
  failures.forEach(({ name, err }) => console.log(`  - ${name}: ${err.message}`));
  process.exitCode = 1;
}
