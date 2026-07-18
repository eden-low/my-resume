// EdenAtlas — browser-side timezone-aware date-key helper.
//
// A browser (ESM) counterpart to netlify/functions/lib/date-utils.js's localDateString(): that
// file is CommonJS and only ever runs server-side (Netlify Functions never import a browser ES
// module, and vice versa — see assistant.js's own header comment on this repo's per-runtime
// duplication convention). The underlying Intl-based algorithm is the same on purpose.
//
// Used by home.html's Daily Reflection card (via js/reflection.js): the reflection document ID
// and its `dateKey` field must land on the SAME calendar day regardless of the visitor's own
// device/OS timezone or whatever timezone the browser/Netlify edge happens to be running in —
// a same-day reflection must always resolve to one deterministic document (see firestore.rules'
// daily_reflections match block, and CLAUDE.md's Production Hardening history).

export const DEFAULT_TIME_ZONE = "Asia/Kuala_Lumpur";

function pad2(n) {
  return String(n).padStart(2, "0");
}

// { year, month (1-12), day } for `date` as seen in `timeZone` — the authoritative "local date"
// everything else here is built on. Handles the UTC-midnight-vs-local-date distinction: a
// `date` instant just after UTC midnight can already be the *next* calendar day in
// Asia/Kuala_Lumpur (UTC+8), and this always reflects the local one, not the UTC one.
export function localDateParts(date, timeZone = DEFAULT_TIME_ZONE) {
  const dtf = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = {};
  for (const { type, value } of dtf.formatToParts(date)) {
    if (type !== "literal") parts[type] = value;
  }
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

// "YYYY-MM-DD" for `date` as seen in `timeZone`.
export function localDateString(date, timeZone = DEFAULT_TIME_ZONE) {
  const { year, month, day } = localDateParts(date, timeZone);
  return `${year}-${pad2(month)}-${pad2(day)}`;
}
