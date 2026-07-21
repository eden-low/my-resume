// netlify/functions/lib/deploy-origin.js — reads the build-time Deploy Preview origin snapshot
// scripts/generate-deploy-origin.js wrote before Functions were bundled (see that file's header
// comment for why DEPLOY_PRIME_URL/DEPLOY_URL can't just be read from process.env here directly —
// confirmed against Netlify's own docs that they're build-step-only, not Function-runtime env).
//
// This is the one place netlify/functions/anilist.js reads that generated file. Degrades to
// {deployPrimeUrl: null, deployUrl: null} — never throws — if the file is missing (a fresh
// checkout before the first `npm run build`, or any environment that never ran the build step):
// Discover still works from the production origin and any ALLOWED_ORIGIN-configured origin, it
// just can't also allow a Deploy Preview origin until a real build has run.

const fs = require("fs");
const path = require("path");

const GENERATED_PATH = path.join(__dirname, "deploy-origin.generated.json");

function readGeneratedDeployOrigins() {
  try {
    const raw = fs.readFileSync(GENERATED_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return {
      deployPrimeUrl: typeof parsed.deployPrimeUrl === "string" ? parsed.deployPrimeUrl : null,
      deployUrl: typeof parsed.deployUrl === "string" ? parsed.deployUrl : null,
    };
  } catch {
    return { deployPrimeUrl: null, deployUrl: null };
  }
}

module.exports = { readGeneratedDeployOrigins };
