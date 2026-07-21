#!/usr/bin/env node
// EdenAtlas — build-time Deploy Preview origin snapshot for netlify/functions/anilist.js.
//
// Why this exists: netlify/functions/anilist.js's Origin/CORS check was rejecting every request
// from a Netlify Deploy Preview (403 origin_not_allowed) even though ALLOWED_ORIGIN correctly
// allowed production. The obvious fix — read DEPLOY_PRIME_URL/DEPLOY_URL from process.env inside
// the Function — does not work: verified against Netlify's own docs
// (https://docs.netlify.com/build/functions/environment-variables/), which state "only the
// following variables are available to serverless functions during runtime: URL, SITE_NAME,
// SITE_ID." DEPLOY_PRIME_URL and DEPLOY_URL are build-step-only variables — real in `npm run
// build`, undefined inside the deployed Function's process.env. This was confirmed against the
// docs rather than assumed, per this pass's own instruction not to guess.
//
// The fix: this script runs as part of `npm run build` (see package.json), which Netlify invokes
// BEFORE it bundles Functions with esbuild — so whatever this script writes to disk is already
// present when the bundler packages netlify/functions/anilist.js's dependency graph, and ships
// inside the deployed Function bundle. It captures the two build-time-only URLs' RAW string
// values exactly as the build saw them (no normalization here — see
// netlify/functions/anilist.js's normalizeExactOrigin(), which does `new URL(value).origin` and
// is unit-tested against malformed/forged values; keeping validation in one place, in the
// Function itself, is easier to test than duplicating it here).
//
// The output file is not a secret: an https deploy-preview URL is not sensitive information (same
// reasoning already documented for this repo's public Firebase Web config). It's gitignored and
// regenerated on every build anyway — same convention as tailwind.generated.css / site/ — never
// hand-edited, never committed.
//
// Run: `node scripts/generate-deploy-origin.js` (also what `npm run build` runs — see
// package.json's "build" script and netlify.toml's `[build] command`).

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const OUT_PATH = path.join(ROOT, "netlify", "functions", "lib", "deploy-origin.generated.json");

function rawOrNull(value) {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function generate() {
  const config = {
    // DEPLOY_PRIME_URL: the stable "friendly" URL for this deploy context — for a Deploy Preview,
    // e.g. https://deploy-preview-12--edenatlas.netlify.app (same value as URL in production).
    deployPrimeUrl: rawOrNull(process.env.DEPLOY_PRIME_URL),
    // DEPLOY_URL: the unique-per-build URL, e.g. https://<hash>--edenatlas.netlify.app — changes
    // on every new commit pushed to the same PR, unlike DEPLOY_PRIME_URL.
    deployUrl: rawOrNull(process.env.DEPLOY_URL),
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
  console.log(
    `generate-deploy-origin: wrote ${path.relative(ROOT, OUT_PATH)} ` +
    `(deployPrimeUrl=${config.deployPrimeUrl || "null"}, deployUrl=${config.deployUrl || "null"})`
  );
  return config;
}

if (require.main === module) {
  generate();
}

module.exports = { generate, OUT_PATH };
