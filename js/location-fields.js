// EdenAtlas — canonical location normalizer/serializer shared by every save path that can
// attach a place to a Memory/Journal/Journey entry (manual text, Nominatim search-select, and
// the device "Use exact location" GPS button — see js/location-search.js for the search
// provider and CLAUDE.md's "v3.4.1"/"v3.4.2" history for why the schema looks like this).
// This module was split out of three near-identical copies that used to live independently in
// gallery.js/journal.js/timeline.js (still duplicated per this repo's per-page convention for
// page-specific rendering, but the actual save/validate logic drifting out of sync across three
// files was a real risk — see the root-cause notes in the accompanying fix report). Every page
// that writes locationName/locationAddress/latitude/longitude/locationPrecision onto
// photos/journals/life_events must go through readLocationFields()/normalizeLocation() below,
// never re-derive the payload by hand.
//
// Schema (unchanged from v3.4.1, not renamed): locationName, locationAddress, latitude,
// longitude (numbers or null), locationPrecision: "exact" | "place_resolved" | "place" | "none".
// "place_resolved" = coordinates came from a user-selected Nominatim result; "exact" = captured
// from navigator.geolocation. Atlas treats both identically — they're both valid map pins; the
// distinction only drives which status-chip copy a form shows.

export const LAT_MIN = -90;
export const LAT_MAX = 90;
export const LON_MIN = -180;
export const LON_MAX = 180;

// Converts a numeric or numeric-string value at the trust boundary. Rejects "", null,
// undefined, and non-finite results (NaN/Infinity) — never coerces a bad value to 0.
export function parseCoordinate(raw) {
  if (raw == null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

// Returns { latitude, longitude } only when BOTH parse and both fall inside a valid
// lat/lon range; otherwise null. Deliberately never falls back to {0, 0} — a missing or
// invalid pair must read as "no coordinates", not "coordinates at Null Island".
export function validateCoords(latRaw, lonRaw) {
  const lat = parseCoordinate(latRaw);
  const lon = parseCoordinate(lonRaw);
  if (lat == null || lon == null) return null;
  if (lat < LAT_MIN || lat > LAT_MAX || lon < LON_MIN || lon > LON_MAX) return null;
  return { latitude: lat, longitude: lon };
}

// The one canonical save shape. `precisionHint` is the raw "place_resolved" | "exact" | ""
// signal a form's hidden input carries; it only matters when coordinates are actually valid —
// an invalid/missing pair always collapses to "place" (text only) or "none", regardless of
// what the hint claimed, so a stale/tampered hint can never present unconfirmed text as
// map-ready.
export function normalizeLocation({ locationName, locationAddress, latitude, longitude, precisionHint } = {}) {
  const name = (locationName ?? "").toString().trim() || null;
  const address = (locationAddress ?? "").toString().trim() || null;
  const coords = validateCoords(latitude, longitude);
  return {
    locationName: name,
    locationAddress: address,
    latitude: coords ? coords.latitude : null,
    longitude: coords ? coords.longitude : null,
    locationPrecision: coords
      ? (precisionHint === "place_resolved" ? "place_resolved" : "exact")
      : (name || address ? "place" : "none"),
  };
}

// Reads one form's location inputs (v3.4.1/v3.4.2 ids: {prefix}-location-name/-location-
// address/-latitude/-longitude/-location-precision-hint) and returns the normalized payload
// to spread straight into an addDoc/updateDoc call. Called at submit time in every page, so it
// always reflects whatever is currently confirmed in the DOM, not a cached earlier selection.
export function readLocationFields(prefix) {
  return normalizeLocation({
    locationName: document.getElementById(`${prefix}-location-name`).value,
    locationAddress: document.getElementById(`${prefix}-location-address`).value,
    latitude: document.getElementById(`${prefix}-latitude`).value,
    longitude: document.getElementById(`${prefix}-longitude`).value,
    precisionHint: document.getElementById(`${prefix}-location-precision-hint`).value,
  });
}

// Wraps the callback-based Geolocation API in a promise that never rejects — a denial/timeout
// just resolves null, same pattern index.html's weather widget uses.
function getBrowserLocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      () => resolve(null),
      { timeout: 8000, maximumAge: 0 }
    );
  });
}

// v3.4.1: exact coordinates are an explicit, optional add-on — the button only fills the
// hidden lat/lng inputs (never the visible name field, which used to get raw coordinates baked
// into locationName, leaking them to anyone the item was visible to). A small status chip +
// clear button reflect/undo the stored coordinates; syncing also runs on form reset.
// `i18nT` is injected (rather than imported) so this module has no hard dependency on a
// particular i18n import path/timing beyond what each page already sets up.
export function wireExactLocationControls(prefix, i18nT) {
  const btn = document.getElementById(`${prefix}-use-location-btn`);
  const status = document.getElementById(`${prefix}-location-status`);
  const clearBtn = document.getElementById(`${prefix}-clear-location-btn`);
  const nameInput = document.getElementById(`${prefix}-location-name`);
  const latInput = document.getElementById(`${prefix}-latitude`);
  const lonInput = document.getElementById(`${prefix}-longitude`);
  const hintInput = document.getElementById(`${prefix}-location-precision-hint`);
  // Phase 4 UX: the status chip distinguishes "confirmed" (valid coords, named — shows the
  // place name so it's unambiguous *which* place got pinned) from the older bare
  // "coordinates saved"/"map pin enabled" copy (valid coords, no name typed — rare, since the
  // search flow always fills the name, but the GPS button alone doesn't require one).
  const sync = () => {
    const coords = validateCoords(latInput.value, lonInput.value);
    if (!coords) hintInput.value = "";
    const name = nameInput.value.trim();
    status.textContent = coords
      ? (name
          ? i18nT("common.location_confirmed", { name })
          : i18nT(hintInput.value === "place_resolved" ? "common.map_pin_enabled" : "common.coordinates_saved"))
      : "";
    status.title = coords ? i18nT("common.place_pin_hint") : "";
    status.classList.toggle("hidden", !coords);
    clearBtn.classList.toggle("hidden", !coords);
    clearBtn.title = i18nT("common.clear_selected_place");
  };
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = i18nT("common.locating");
    const loc = await getBrowserLocation();
    btn.disabled = false;
    btn.textContent = original;
    if (!loc) return;
    latInput.value = loc.lat;
    lonInput.value = loc.lon;
    hintInput.value = "exact";
    sync();
  });
  clearBtn.addEventListener("click", () => {
    latInput.value = "";
    lonInput.value = "";
    hintInput.value = "";
    sync();
  });
  // reset event fires before the default reset action, so re-sync a tick later
  btn.closest("form")?.addEventListener("reset", () => setTimeout(sync, 0));
  return sync;
}
