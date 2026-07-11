// EdenAtlas v3.4.2 — place search / geocoding for the Memories/Journal/Journey location
// forms. A shared pure-helper module (same tier as js/identity.js — it wires DOM the pages
// already declare, but injects nothing of its own): the provider call lives here once
// instead of being duplicated per page, so it can be swapped later in one place.
//
// Provider: OpenStreetMap Nominatim — free, no API key, CORS-open. Its usage policy wants
// low volume + attribution: search is button-triggered only (never per-keystroke), capped
// at 5 results, and the results list carries an OpenStreetMap credit line. The
// service worker never intercepts this (cross-origin requests are passed through).

import { t, getLang } from "./i18n.js";

export const MIN_QUERY_LENGTH = 3;
const ATTRIBUTION = "OpenStreetMap";

const provider = {
  source: "nominatim",
  async search(query, lang) {
    const url =
      "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5" +
      `&accept-language=${encodeURIComponent(lang === "zh-CN" ? "zh-CN" : "en")}` +
      `&q=${encodeURIComponent(query)}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`place search failed: ${res.status}`);
    const rows = await res.json();
    return rows
      .map((r) => {
        const latitude = Number(r.lat);
        const longitude = Number(r.lon);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
        const address = r.display_name || "";
        return {
          name: r.name || address.split(",")[0].trim() || query,
          address,
          latitude,
          longitude,
          source: provider.source,
        };
      })
      .filter(Boolean);
  },
};

// Returns [{ name, address, latitude, longitude, source }]; [] for a too-short query.
// Throws on network/provider failure — callers show a friendly status for that.
export async function searchPlaces(query) {
  const q = (query || "").trim();
  if (q.length < MIN_QUERY_LENGTH) return [];
  return provider.search(q, getLang());
}

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Wires one form's "Search place" button + results list against the location inputs that
// form already has (v3.4.1 ids: {prefix}-location-name/-location-address/-latitude/
// -longitude, plus v3.4.2's hidden {prefix}-location-precision-hint). Coordinates are only
// ever written when the user explicitly picks a result — typing alone never geocodes.
// Manually editing the name after picking a result drops the saved pin (safer default:
// back to place-only mode). `onCoordsChange` is the page's own status-chip sync function.
export function wirePlaceSearch(prefix, onCoordsChange) {
  const nameInput = document.getElementById(`${prefix}-location-name`);
  const addressInput = document.getElementById(`${prefix}-location-address`);
  const latInput = document.getElementById(`${prefix}-latitude`);
  const lonInput = document.getElementById(`${prefix}-longitude`);
  const hintInput = document.getElementById(`${prefix}-location-precision-hint`);
  const searchBtn = document.getElementById(`${prefix}-place-search-btn`);
  const statusEl = document.getElementById(`${prefix}-place-search-status`);
  const resultsEl = document.getElementById(`${prefix}-place-results`);

  function setStatus(text) {
    statusEl.textContent = text || "";
    statusEl.classList.toggle("hidden", !text);
  }
  function clearResults() {
    resultsEl.classList.add("hidden");
    resultsEl.replaceChildren();
  }

  searchBtn.addEventListener("click", async () => {
    clearResults();
    const q = nameInput.value.trim();
    if (q.length < MIN_QUERY_LENGTH) {
      setStatus(t("common.search_min_chars"));
      return;
    }
    setStatus(t("common.loading"));
    searchBtn.disabled = true;
    let results;
    try {
      results = await searchPlaces(q);
    } catch (err) {
      console.error("[place-search] lookup failed:", err);
      searchBtn.disabled = false;
      setStatus(t("common.could_not_search_places"));
      return;
    }
    searchBtn.disabled = false;
    if (!results.length) {
      setStatus(t("common.no_places_found"));
      return;
    }
    setStatus("");
    const attribution = document.createElement("p");
    attribution.className = "text-[9px] font-code text-textGray/60 text-right pt-0.5";
    attribution.textContent = `${t("common.place_search")} · ${ATTRIBUTION}`;
    resultsEl.replaceChildren(
      ...results.map((r) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.title = t("common.select_this_place");
        btn.className = "w-full text-left px-3 py-2 rounded-lg border border-borderNeon bg-darkBg/60 hover:border-neonPurple/60 hover:bg-neonPurple/10 transition-colors";
        btn.innerHTML = `<span class="block text-xs text-white">${esc(r.name)}</span><span class="block text-[10px] font-code text-textGray truncate">${esc(r.address)}</span>`;
        btn.addEventListener("click", () => {
          nameInput.value = r.name;
          addressInput.value = r.address;
          latInput.value = r.latitude;
          lonInput.value = r.longitude;
          hintInput.value = "place_resolved";
          clearResults();
          setStatus("");
          onCoordsChange();
        });
        return btn;
      }),
      attribution
    );
    resultsEl.classList.remove("hidden");
  });

  // Safer fallback (Task 5): a manual rename after selecting a result un-links the saved
  // coordinates — the text may no longer describe that pin. Programmatic .value writes
  // (result selection, edit-modal prefill) don't fire "input", so they're unaffected.
  nameInput.addEventListener("input", () => {
    if (hintInput.value !== "place_resolved") return;
    hintInput.value = "";
    latInput.value = "";
    lonInput.value = "";
    setStatus(t("common.saved_as_place_only"));
    onCoordsChange();
  });
}
