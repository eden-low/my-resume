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

// Six-state classification for a location form's live status display — distinct from
// normalizeLocation()'s save-time canonicalization, which only ever needs "valid coords or
// not." Accepts either a Firestore doc's stored fields (used once to initialize a form, e.g.
// opening the Edit Memory modal for a legacy record) or a form's current raw input values
// (used continuously by wireExactLocationControls' sync() below) — both are the same shape.
//  - "none": no location text and no coordinates at all.
//  - "invalid": raw latitude/longitude are present but fail validation (out of range,
//    non-finite, or corrupted legacy data) — distinct from "none" so a broken legacy record
//    visibly asks to be fixed instead of silently looking untouched. normalizeLocation()
//    already refuses to ever save these values, so this state can only ever be "read stale
//    data, not yet fixed" — never a save-time risk.
//  - "needs_confirmation": place text exists but there are no valid coordinates yet — covers
//    both a legacy name-only record (never had a pin) and a place whose text was edited after
//    being confirmed (the rename-guard in wirePlaceSearch already clears coordinates then).
//    Both cases have the identical remedy (search-and-select, or use exact location), so they
//    deliberately share one status rather than needing separate copy.
//  - "confirmed_search": valid coordinates from a selected search result.
//  - "confirmed_exact": valid coordinates captured from the device GPS button.
export function classifyLocation({ locationName, locationAddress, latitude, longitude, precisionHint }) {
  const hasText = !!((locationName ?? "").toString().trim() || (locationAddress ?? "").toString().trim());
  const hasRawCoords = latitude != null && latitude !== "" && longitude != null && longitude !== "";
  const coords = hasRawCoords ? validateCoords(latitude, longitude) : null;
  if (hasRawCoords && !coords) return "invalid";
  if (!coords) return hasText ? "needs_confirmation" : "none";
  return precisionHint === "place_resolved" ? "confirmed_search" : "confirmed_exact";
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
const STATUS_COLOR_CLASSES = ["text-neonPurple", "text-amber-400", "text-rose-400"];

export function wireExactLocationControls(prefix, i18nT) {
  const btn = document.getElementById(`${prefix}-use-location-btn`);
  const status = document.getElementById(`${prefix}-location-status`);
  const clearBtn = document.getElementById(`${prefix}-clear-location-btn`);
  const removeBtn = document.getElementById(`${prefix}-remove-location-btn`);
  const nameInput = document.getElementById(`${prefix}-location-name`);
  const addressInput = document.getElementById(`${prefix}-location-address`);
  const latInput = document.getElementById(`${prefix}-latitude`);
  const lonInput = document.getElementById(`${prefix}-longitude`);
  const hintInput = document.getElementById(`${prefix}-location-precision-hint`);
  // The status chip renders one of classifyLocation()'s five states: "needs_confirmation" and
  // "invalid" get their own warning/error copy+color; "confirmed_*" shows the place name when
  // one exists ("Confirmed: {name}") or a generic coords-saved line otherwise (the GPS button
  // alone doesn't require a name); "none" hides the chip entirely.
  const sync = () => {
    const state = classifyLocation({
      locationName: nameInput.value,
      locationAddress: addressInput.value,
      latitude: latInput.value,
      longitude: lonInput.value,
      precisionHint: hintInput.value,
    });
    // A confirmed hint only ever means something once coordinates are actually valid — for
    // "invalid"/"needs_confirmation"/"none" it's stale and must not survive into a save.
    if (state !== "confirmed_search" && state !== "confirmed_exact") hintInput.value = "";
    const name = nameInput.value.trim();
    let text = "";
    let colorClass = "text-neonPurple";
    if (state === "invalid") {
      text = i18nT("common.location_invalid");
      colorClass = "text-rose-400";
    } else if (state === "needs_confirmation") {
      text = i18nT("common.location_needs_confirmation");
      colorClass = "text-amber-400";
    } else if (state === "confirmed_search" || state === "confirmed_exact") {
      text = name
        ? i18nT("common.location_confirmed", { name })
        : i18nT(state === "confirmed_search" ? "common.map_pin_enabled" : "common.coordinates_saved");
    }
    status.textContent = text;
    status.title = state === "confirmed_search" || state === "confirmed_exact" ? i18nT("common.place_pin_hint") : "";
    status.classList.remove(...STATUS_COLOR_CLASSES);
    status.classList.add(colorClass);
    status.classList.toggle("hidden", state === "none");
    // The "x" only ever clears coordinates (keeping typed text intact, e.g. to re-search under
    // a corrected name) — show it whenever there's a raw lat/lng to clear, valid or not, so an
    // "invalid" legacy pin can be cleared this way too, not just via "Remove location".
    const hasRawCoords = latInput.value !== "" && lonInput.value !== "";
    clearBtn.classList.toggle("hidden", !hasRawCoords);
    clearBtn.title = i18nT("common.clear_selected_place");
    // "Remove location" (wireRemoveLocation, if this page opted into it) clears name+address+
    // coords together — only worth offering once there's anything at all to remove. Folded in
    // here rather than a separate listener so it stays correct after every trigger this sync()
    // already runs from (GPS click, "x" click, search-select, edit-modal prefill, form reset).
    if (removeBtn) removeBtn.classList.toggle("hidden", state === "none");
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

// Adds a "Remove location" control — distinct from wireExactLocationControls' per-field "x"
// (which only ever clears coordinates, keeping typed name/address text intact so the user can
// re-search under a corrected name): this clears name + address + coordinates + hint together,
// the only action that fully removes a Memory/Journal/Journey's location. Its visibility is
// owned by wireExactLocationControls' sync() (hidden once there's nothing left to remove);
// this function only owns the click behavior. Requires a second click on the same button
// within a short window as its confirmation (never a bare window.confirm()) — a fresh click
// after the window elapses, or typing in the location fields, cancels the pending confirmation
// rather than leaving a stale "are you sure?" label around. No-ops when the
// ${prefix}-remove-location-btn element doesn't exist on a given page, so pages that don't
// opt into this control are unaffected. `sync` is wireExactLocationControls' returned
// function — called after clearing so the status chip and this button's own visibility update
// immediately.
export function wireRemoveLocation(prefix, i18nT, sync) {
  const btn = document.getElementById(`${prefix}-remove-location-btn`);
  if (!btn) return;
  const nameInput = document.getElementById(`${prefix}-location-name`);
  const addressInput = document.getElementById(`${prefix}-location-address`);
  const latInput = document.getElementById(`${prefix}-latitude`);
  const lonInput = document.getElementById(`${prefix}-longitude`);
  const hintInput = document.getElementById(`${prefix}-location-precision-hint`);
  let armed = false;
  let timer = null;
  let originalLabel = btn.textContent;

  function reset() {
    if (!armed) return;
    armed = false;
    clearTimeout(timer);
    btn.textContent = originalLabel;
    btn.classList.remove("text-rose-400", "border-rose-400/60");
  }
  btn.addEventListener("click", () => {
    if (!armed) {
      originalLabel = btn.textContent; // captured fresh so it reflects the current language
      armed = true;
      btn.textContent = i18nT("common.confirm_remove_location");
      btn.classList.add("text-rose-400", "border-rose-400/60");
      timer = setTimeout(reset, 4000);
      return;
    }
    reset();
    nameInput.value = "";
    addressInput.value = "";
    latInput.value = "";
    lonInput.value = "";
    hintInput.value = "";
    sync();
  });
  [nameInput, addressInput].forEach((el) => el.addEventListener("input", reset));
}
