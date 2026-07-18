// EdenAtlas — browser client for the authenticated weather Netlify Function (Production
// Hardening Phase 1, task C). A shared pure-helper module, same tier as js/location-search.js /
// js/identity.js (wires no DOM of its own) — used by home.html's inline module and me.js so the
// previously duplicated, browser-exposed OpenWeatherMap API key in both files has exactly one
// replacement call site shape instead of being reinvented per page.
import { auth } from "../firebase-init.js";

const ENDPOINT = "/.netlify/functions/weather";

// Same retry policy assistant.js's frontend already uses (see its withOneRetryOn401 comment): a
// 401 usually just means the cached ID token was stale, not that the session is invalid — retry
// exactly once with a forced refresh, never loop.
async function withOneRetryOn401(attempt) {
  let res = await attempt(false);
  if (res.status === 401) res = await attempt(true);
  return res;
}

// `coords` is optional ({lat, lon}) — omit (or pass null/undefined, or a non-finite pair) to let
// the Function fall back to its own fixed city query, matching this app's existing "no location
// permission" behavior. Returns { ok: true, tempC, description } or { ok: false, error }; never
// throws — callers decide what to show on failure.
export async function fetchWeather(coords) {
  const user = auth.currentUser;
  if (!user) return { ok: false, error: "not_signed_in" };
  const hasCoords = coords && Number.isFinite(coords.lat) && Number.isFinite(coords.lon);
  const body = hasCoords ? { lat: coords.lat, lon: coords.lon } : {};
  try {
    const res = await withOneRetryOn401(async (forceRefresh) =>
      fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${await user.getIdToken(forceRefresh)}` },
        body: JSON.stringify(body),
      })
    );
    return await interpretResponse(res);
  } catch {
    return { ok: false, error: "network_error" };
  }
}

async function interpretResponse(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) return { ok: false, error: data.error || `http_${res.status}` };
  return { ok: true, tempC: data.tempC, description: data.description, condition: data.condition };
}
