// EdenAtlas Atlas Assistant — the strict, read-only server-side tool allowlist.
//
// The model (Qwen) never sees a Firestore collection name, a document path, a uid, or a raw
// query operator: it can only choose one of the fixed `name`s exported in TOOLS below and
// supply arguments matching that tool's own hand-rolled `validate()` — never a generic/dynamic
// query builder. Every executor takes `ctx.uid` from the caller (the already-verified Owner
// uid — see assistant.js's auth flow, never anything the model or the request body supplied)
// and hardcodes its own collection name and `where("uid","==",ctx.uid)` shape, mirroring the
// exact per-collection ownership pattern firestore.rules already expresses for client reads —
// re-implemented here in code because Firebase Admin bypasses Security Rules entirely (see
// docs/ai-architecture.md).
//
// Every field this module returns to the model has been explicitly chosen. Never returned,
// anywhere, by construction (not by best-effort filtering): image bytes, Storage paths/
// download URLs, download tokens, exact latitude/longitude, Finance/expenses data, other
// users' content, or trashed/deleted Memories.
//
// Two invariants added by the "date-correctness, calendar-semantics, safe-output and
// source-navigation" pass, both load-bearing enough to call out here rather than only at their
// call sites:
//   1. Raw Firestore document IDs never appear in anything a tool returns to the model. Every
//      item a tool surfaces is registered via `ctx.registerRef(type, id, label)`, which returns
//      an opaque, per-request `handle` string — that handle (never the id) is what goes into the
//      JSON a tool hands back for the model to read. `draft_reflection` — the only tool that
//      lets the model reference an item it saw earlier — only ever accepts that same opaque
//      handle back, resolved against a registry that exists solely for the current verified
//      request (see qwen.js's runAgentLoop, which creates a fresh registry every call). The
//      model can never supply an arbitrary Firestore ID and have it accepted.
//   2. `ctx.registerRef` must only ever be called for an item that is ACTUALLY included in what
//      the tool is about to tell the model — never for every document a query happened to fetch.
//      (list_calendar had exactly this bug: it called registerRef for every fetched photo/
//      journal regardless of whether the item fell inside the requested date range.)

const { resolveRelativePeriod, DEFAULT_TIME_ZONE, MS_PER_DAY, localMidnightUtc, localDateString } = require("./date-utils");

const MAX_TEXT_QUERY_LEN = 120;
const CAPTION_TRUNCATE = 200;
const JOURNAL_TRUNCATE = 300;

class ToolValidationError extends Error {}

// ---- small, dependency-free helpers (deliberately duplicated rather than importing the
// browser ESM modules under js/ — see the header comment in netlify/functions/assistant.js for
// why this Function tree can't `require()` those files) ----

function isDeletedMemory(doc) {
  return !!(doc && doc.deletedAt);
}

function hasConfirmedCoords(doc) {
  return (
    doc &&
    typeof doc.latitude === "number" &&
    typeof doc.longitude === "number" &&
    Number.isFinite(doc.latitude) &&
    Number.isFinite(doc.longitude)
  );
}

function truncate(str, max) {
  if (typeof str !== "string") return "";
  return str.length > max ? str.slice(0, max).trimEnd() + "…" : str;
}

function isPlainString(v) {
  return typeof v === "string";
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDateOnlyParts(v) {
  if (!isPlainString(v) || !DATE_RE.test(v)) return null;
  const [year, month, day] = v.split("-").map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

// An explicit "YYYY-MM-DD" from the model means that LOCAL calendar day in `timeZone` — task B:
// "Handle Malaysia-local day/month boundaries before converting to Firestore timestamps." Naive
// `new Date(v + "T00:00:00Z")` (the previous behavior) anchors to UTC midnight instead, which in
// Asia/Kuala_Lumpur (UTC+8) is already 08:00 local — an explicit endDate would then silently cut
// off the last 8 local hours of that day. `edge: "start"` = local midnight of that day;
// `edge: "end"` = one millisecond before the next day's local midnight.
function localDayBoundaryUtc(v, timeZone, edge) {
  const parts = parseDateOnlyParts(v);
  if (!parts) return null;
  const start = localMidnightUtc(parts.year, parts.month, parts.day, timeZone);
  return edge === "end" ? new Date(start.getTime() + MS_PER_DAY - 1) : start;
}

function clampInt(v, { min, max, fallback }) {
  if (v == null) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new ToolValidationError("limit_must_be_integer");
  if (n < min || n > max) throw new ToolValidationError(`limit_out_of_range_${min}_${max}`);
  return n;
}

function requireQuery(v) {
  if (!isPlainString(v) || !v.trim()) throw new ToolValidationError("query_required");
  const q = v.trim();
  if (q.length > MAX_TEXT_QUERY_LEN) throw new ToolValidationError("query_too_long");
  return q;
}

function textMatches(haystackParts, needle) {
  const n = needle.toLowerCase();
  return haystackParts.some((part) => typeof part === "string" && part.toLowerCase().includes(n));
}

// Resolves a tool's date-range arguments in one consistent priority order (task A: "explicit
// dates supplied by the user always win"): explicit startDate/endDate first, then a server-
// resolved `relativePeriod` (see date-utils.js — this is where "this month"/"June"/etc turn into
// real dates, deterministically, from `ctx.now`/`ctx.timeZone` — never the model's own guess),
// then (only where the caller allows it) a trailing default window ending at `ctx.now`. Never
// calls `new Date()` itself — `ctx.now` is always the single authoritative clock reading for
// this whole request (see assistant.js, which reads it once and threads it through).
function resolveRangeFromArgs(args, ctx, { maxDays, defaultDays, allowDefault, relativeEnumName }) {
  const hasExplicitStart = !!(args && args.startDate);
  const hasExplicitEnd = !!(args && args.endDate);

  if (hasExplicitStart || hasExplicitEnd) {
    if (!hasExplicitStart || !hasExplicitEnd) throw new ToolValidationError("start_and_end_date_required");
    const start = localDayBoundaryUtc(args.startDate, ctx.timeZone, "start");
    const end = localDayBoundaryUtc(args.endDate, ctx.timeZone, "end");
    if (!start) throw new ToolValidationError("invalid_start_date");
    if (!end) throw new ToolValidationError("invalid_end_date");
    if (start > end) throw new ToolValidationError("start_date_after_end_date");
    const rangeDays = Math.ceil((end.getTime() - start.getTime()) / MS_PER_DAY);
    if (rangeDays > maxDays) throw new ToolValidationError(`date_range_exceeds_${maxDays}_days`);
    // Echoes the caller's own YYYY-MM-DD text back verbatim — never re-derived from the `start`/
    // `end` Date objects via toISOString(), which would silently reintroduce the exact UTC-vs-
    // local mismatch this whole pass exists to fix (an earlier draft of this function did this).
    return { start, end, startDate: args.startDate, endDate: args.endDate, timeZone: ctx.timeZone, resolvedFrom: "explicit" };
  }

  if (args && args.relativePeriod) {
    const resolved = resolveRelativePeriod(args.relativePeriod, {
      now: ctx.now,
      timeZone: ctx.timeZone,
      direction: args.direction,
    });
    if (!resolved) throw new ToolValidationError(`unrecognized_${relativeEnumName || "relativePeriod"}`);
    const rangeDays = Math.ceil((resolved.end.getTime() - resolved.start.getTime()) / MS_PER_DAY);
    if (rangeDays > maxDays) throw new ToolValidationError(`date_range_exceeds_${maxDays}_days`);
    return {
      start: resolved.start,
      end: resolved.end,
      startDate: resolved.startDate,
      endDate: resolved.endDate,
      timeZone: ctx.timeZone,
      resolvedFrom: "relative",
    };
  }

  if (!allowDefault) throw new ToolValidationError("start_and_end_date_required");
  const end = ctx.now;
  const start = new Date(end.getTime() - defaultDays * MS_PER_DAY);
  return {
    start,
    end,
    startDate: localDateString(start, ctx.timeZone),
    endDate: localDateString(end, ctx.timeZone),
    timeZone: ctx.timeZone,
    resolvedFrom: "default",
  };
}

// ---- Firestore reads. Every function below is the ONLY place its collection name appears —
// there is no generic "run this query" path the model could ever reach. ----

// Merges two queries — `uid` (the current field every write path uses) and the legacy
// `uploadedBy` field older Memories may still carry — deduped by document ID, exactly mirroring
// gallery.js's own `fetchOwnPosts(uid)` (see CLAUDE.md's "Trash privacy + ownership-merge fix"
// history entry). Without this, a Memory written before the `uid` field existed would silently
// never be visible to the Assistant even though it's genuinely the Owner's own content.
async function fetchOwnerActivePhotos(db, uid) {
  const [byUid, byUploadedBy] = await Promise.all([
    db.collection("photos").where("uid", "==", uid).get(),
    db.collection("photos").where("uploadedBy", "==", uid).get(),
  ]);
  const merged = new Map();
  byUid.docs.forEach((d) => merged.set(d.id, { id: d.id, ...d.data() }));
  byUploadedBy.docs.forEach((d) => merged.set(d.id, { id: d.id, ...d.data() }));
  return [...merged.values()].filter((doc) => !isDeletedMemory(doc));
}

async function fetchOwnerJournals(db, uid) {
  const snap = await db.collection("journals").where("uid", "==", uid).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function fetchOwnerLifeEvents(db, uid) {
  const snap = await db.collection("life_events").where("uid", "==", uid).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

function docMillis(doc, field) {
  const v = doc && doc[field];
  if (!v) return 0;
  if (typeof v.toMillis === "function") return v.toMillis();
  if (v instanceof Date) return v.getTime();
  return 0;
}

// ---- Tool definitions ----
// `scope` says which consent scope (see assistant.html's scope selector) must be enabled before
// this tool is even offered to the model. `draft_reflection` has no data scope of its own — it
// only ever synthesizes from refs the model already legitimately received this turn.

const MONTH_ENUM = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];
const CALENDAR_RELATIVE_ENUM = ["this_month", "last_month", "next_month", ...MONTH_ENUM];
const JOURNEY_RELATIVE_ENUM = ["this_month", "last_month", "next_month", "this_year", "last_year", ...MONTH_ENUM];

const RELATIVE_PERIOD_DESCRIPTION =
  "Optional alternative to startDate/endDate for a relative phrase the user used (e.g. \"this month,\" \"June\"). " +
  "Resolved server-side against the authoritative currentLocalDate given in your instructions — never guess a year yourself. " +
  "A bare month name with no year means the most recent occurrence not after currentLocalDate, UNLESS the user's wording " +
  "clearly means upcoming/next, in which case also set direction=\"forward\". Ignored if startDate/endDate are also given " +
  "(explicit dates always win).";

const TOOLS = {
  search_memories: {
    scope: "memories",
    description:
      "Search the Owner's own active (non-trashed) Memories by caption, tags, or place name. Never returns image bytes, Storage paths/URLs, or exact coordinates.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search text, e.g. a place or topic.", maxLength: MAX_TEXT_QUERY_LEN },
        limit: { type: "integer", description: "Max results (1-10).", minimum: 1, maximum: 10 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    validate(args) {
      return { query: requireQuery(args && args.query), limit: clampInt(args && args.limit, { min: 1, max: 10, fallback: 5 }) };
    },
    async execute(args, ctx) {
      const photos = await fetchOwnerActivePhotos(ctx.db, ctx.uid);
      const matches = photos
        .filter((p) => textMatches([p.caption, p.locationName, p.locationAddress, ...(Array.isArray(p.tags) ? p.tags : [])], args.query))
        .sort((a, b) => docMillis(b, "uploadedAt") - docMillis(a, "uploadedAt"))
        .slice(0, args.limit)
        .map((p) => {
          const caption = truncate(p.caption || "", CAPTION_TRUNCATE);
          const handle = ctx.registerRef("memory", p.id, p.caption || "Untitled memory");
          return {
            handle,
            caption,
            tags: Array.isArray(p.tags) ? p.tags.slice(0, 10) : [],
            locationName: p.locationName || null,
            hasConfirmedLocation: hasConfirmedCoords(p),
            recordedAt: docMillis(p, "uploadedAt") ? localDateString(new Date(docMillis(p, "uploadedAt")), ctx.timeZone) : null,
          };
        });
      return { count: matches.length, results: matches };
    },
  },

  find_memories_missing_location: {
    scope: "memories",
    description: "List the Owner's active Memories that don't yet have a confirmed map location.",
    parameters: {
      type: "object",
      properties: { limit: { type: "integer", description: "Max results (1-20).", minimum: 1, maximum: 20 } },
      required: [],
      additionalProperties: false,
    },
    validate(args) {
      return { limit: clampInt(args && args.limit, { min: 1, max: 20, fallback: 10 }) };
    },
    async execute(args, ctx) {
      const photos = await fetchOwnerActivePhotos(ctx.db, ctx.uid);
      const missing = photos
        .filter((p) => !hasConfirmedCoords(p))
        .sort((a, b) => docMillis(b, "uploadedAt") - docMillis(a, "uploadedAt"))
        .slice(0, args.limit)
        .map((p) => {
          const handle = ctx.registerRef("memory", p.id, p.caption || "Untitled memory");
          return { handle, caption: truncate(p.caption || "", CAPTION_TRUNCATE), locationName: p.locationName || null };
        });
      return { count: missing.length, results: missing };
    },
  },

  search_journals: {
    scope: "journal",
    description: "Search the Owner's own Journal entries by title, body text, or tags. Returns short excerpts only, never the full entry, image, or exact coordinates.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search text.", maxLength: MAX_TEXT_QUERY_LEN },
        limit: { type: "integer", description: "Max results (1-8).", minimum: 1, maximum: 8 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    validate(args) {
      return { query: requireQuery(args && args.query), limit: clampInt(args && args.limit, { min: 1, max: 8, fallback: 5 }) };
    },
    async execute(args, ctx) {
      const journals = await fetchOwnerJournals(ctx.db, ctx.uid);
      const matches = journals
        .filter((j) => textMatches([j.title, j.content, ...(Array.isArray(j.tags) ? j.tags : [])], args.query))
        .sort((a, b) => docMillis(b, "createdAt") - docMillis(a, "createdAt"))
        .slice(0, args.limit)
        .map((j) => {
          const handle = ctx.registerRef("journal", j.id, j.title || "Untitled entry");
          return {
            handle,
            title: truncate(j.title || "", 100),
            excerpt: truncate(j.content || "", JOURNAL_TRUNCATE),
            mood: j.mood || null,
            tags: Array.isArray(j.tags) ? j.tags.slice(0, 10) : [],
            recordedAt: docMillis(j, "createdAt") ? localDateString(new Date(docMillis(j, "createdAt")), ctx.timeZone) : null,
          };
        });
      return { count: matches.length, results: matches };
    },
  },

  list_journey: {
    scope: "journey",
    description: "List the Owner's own Journey (life) events within a bounded date range (max 366 days, default trailing 90 days). Accepts either explicit startDate/endDate or a relativePeriod.",
    parameters: {
      type: "object",
      properties: {
        startDate: { type: "string", description: "YYYY-MM-DD, inclusive." },
        endDate: { type: "string", description: "YYYY-MM-DD, inclusive." },
        relativePeriod: { type: "string", enum: JOURNEY_RELATIVE_ENUM, description: RELATIVE_PERIOD_DESCRIPTION },
        direction: { type: "string", enum: ["forward"], description: "Only with a bare month name: resolve to the next upcoming occurrence instead of the most recent past one." },
        limit: { type: "integer", description: "Max results (1-20).", minimum: 1, maximum: 20 },
      },
      required: [],
      additionalProperties: false,
    },
    validate(args, ctx) {
      const range = resolveRangeFromArgs(args, ctx, { maxDays: 366, defaultDays: 90, allowDefault: true, relativeEnumName: "relativePeriod" });
      return { ...range, limit: clampInt(args && args.limit, { min: 1, max: 20, fallback: 10 }) };
    },
    async execute(args, ctx) {
      const events = await fetchOwnerLifeEvents(ctx.db, ctx.uid);
      const inRange = events
        .filter((e) => {
          const ms = docMillis(e, "date");
          return ms >= args.start.getTime() && ms <= args.end.getTime();
        })
        .sort((a, b) => docMillis(b, "date") - docMillis(a, "date"))
        .slice(0, args.limit)
        .map((e) => {
          const handle = ctx.registerRef("journey", e.id, e.title || "Untitled event");
          return {
            handle,
            title: truncate(e.title || "", 100),
            type: e.type || null,
            date: docMillis(e, "date") ? localDateString(new Date(docMillis(e, "date")), ctx.timeZone) : null,
            locationName: e.locationName || null,
            tags: Array.isArray(e.tags) ? e.tags.slice(0, 10) : [],
          };
        });
      return {
        count: inRange.length,
        resolvedRange: { startDate: args.startDate, endDate: args.endDate, timeZone: args.timeZone },
        results: inRange,
      };
    },
  },

  list_calendar: {
    scope: "calendar",
    // Hardening follow-up: Calendar being *offered* used to depend only on `scope` ("calendar"
    // enabled) — nothing stopped Qwen from being handed this tool's definition (and therefore
    // being able to call it) with Calendar+Journey selected and neither Memories nor Journal
    // enabled, even though it could never produce anything but a validation error. `toolDefsForScopes()`
    // below now also requires at least one of `dependsOnAny` to be enabled before this tool is
    // even included in what's sent to the model — Calendar+Journey now offers list_journey but
    // never list_calendar, matching "Calendar is a capability, never a data grant of its own."
    // The execute()-level guard further down stays as defense-in-depth for any direct caller
    // that bypasses toolDefsForScopes (e.g. a unit test, or a future code path).
    dependsOnAny: ["memories", "journal"],
    description:
      "Activity calendar summary — day-by-day counts of when the Owner recorded/uploaded Memories and/or Journal entries (NOT a scheduling system; Finance is never included). " +
      "Calendar is a date-organizing CAPABILITY, not a data permission of its own: this tool only ever reads the collections behind the Owner's OTHER, separately-selected data scopes " +
      "(Memories -> photos, Journal -> journals) for the current request — never both automatically, and never a collection whose own scope isn't also enabled this turn. " +
      "If neither Memories nor Journal is enabled alongside Calendar, this tool performs no data read at all and returns a validation notice asking the Owner to also enable Memories and/or Journal. " +
      "Accepts either explicit startDate/endDate or a relativePeriod (e.g. \"this month\"). Range is bounded to 31 days.",
    parameters: {
      type: "object",
      properties: {
        startDate: { type: "string", description: "YYYY-MM-DD, inclusive." },
        endDate: { type: "string", description: "YYYY-MM-DD, inclusive." },
        relativePeriod: { type: "string", enum: CALENDAR_RELATIVE_ENUM, description: RELATIVE_PERIOD_DESCRIPTION },
        direction: { type: "string", enum: ["forward"], description: "Only with a bare month name: resolve to the next upcoming occurrence instead of the most recent past one." },
      },
      required: [],
      additionalProperties: false,
    },
    validate(args, ctx) {
      return resolveRangeFromArgs(args, ctx, { maxDays: 31, defaultDays: 7, allowDefault: false, relativeEnumName: "relativePeriod" });
    },
    // Strict collection-scope consent (production gap fixed by this pass): Calendar is a
    // date-organizing CAPABILITY, never a data permission by itself — it must only ever read the
    // collection(s) backing the Owner's OTHER, independently-selected scopes (memories -> photos,
    // journal -> journals), taking the intersection with whatever is actually enabled on THIS
    // verified request (ctx.scopes — never anything the model supplies; see qwen.js's
    // runAgentLoop, which sets ctx.scopes from the server-validated request body only).
    // Deliberately checked BEFORE any Firestore call, not filtered out of the results afterward —
    // a disallowed collection must never even be queried, per this pass's own requirement.
    async execute(args, ctx) {
      const enabledScopes = new Set(ctx.scopes || []);
      const includeMemories = enabledScopes.has("memories");
      const includeJournal = enabledScopes.has("journal");
      if (!includeMemories && !includeJournal) {
        // No Firestore call of any kind happens above this line for this branch.
        throw new ToolValidationError("calendar_requires_memories_or_journal_scope");
      }
      const [photos, journals] = await Promise.all([
        includeMemories ? fetchOwnerActivePhotos(ctx.db, ctx.uid) : Promise.resolve([]),
        includeJournal ? fetchOwnerJournals(ctx.db, ctx.uid) : Promise.resolve([]),
      ]);
      const byDay = new Map();
      // Bucketed by LOCAL calendar day (task B) — an item uploaded at, say, 2026-07-14T20:00Z is
      // already 2026-07-15 04:00 in Asia/Kuala_Lumpur (UTC+8) and must land in the 15th's bucket,
      // not the 14th's. A UTC-based bucket key would silently misfile anything uploaded in the
      // local evening (UTC daytime), which is exactly the class of bug this whole pass targets.
      const dayKey = (ms) => localDateString(new Date(ms), ctx.timeZone);
      // Returns the handle if the item was actually included, or null if it fell outside the
      // requested range — the caller must only treat a non-null return as "surfaced" (task D).
      //
      // Trust/provenance pass fix: registerRef() used to be called unconditionally for every
      // in-range item, even ones beyond the 5-per-day `samples` cap below — so an item that was
      // NEVER actually included in what this tool tells the model could still end up registered
      // and, via qwen.js's dedupeSources(), surfaced to the frontend as a clickable source chip.
      // That's a provenance inconsistency in the other direction from the "missing chip" bug this
      // whole pass audits: a chip implying "the model used this" for something the model was
      // literally never shown. Fixed by only ever calling registerRef() for an item that actually
      // gets pushed into `samples` — mirroring this file's own header invariant #2 exactly.
      const bump = (ms, type, id, labelText) => {
        if (ms < args.start.getTime() || ms > args.end.getTime()) return null;
        const key = dayKey(ms);
        if (!byDay.has(key)) byDay.set(key, { date: key, memories: 0, journal: 0, samples: [] });
        const bucket = byDay.get(key);
        bucket[type === "memory" ? "memories" : "journal"] += 1;
        if (bucket.samples.length >= 5) return null;
        const handle = ctx.registerRef(type, id, labelText);
        bucket.samples.push({ type, handle, title: truncate(labelText || "", 60) });
        return handle;
      };
      photos.forEach((p) => { const ms = docMillis(p, "uploadedAt"); if (ms) bump(ms, "memory", p.id, p.caption); });
      journals.forEach((j) => { const ms = docMillis(j, "createdAt"); if (ms) bump(ms, "journal", j.id, j.title); });

      const days = Array.from(byDay.values()).sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 31);
      const totalItems = days.reduce((sum, d) => sum + d.memories + d.journal, 0);

      // `includedSources` is built from what was ACTUALLY queried this call (includeMemories/
      // includeJournal above), never a fixed assumption — this is the field
      // createProvenanceTracker.recordSuccess() in lib/qwen.js reads to build the frontend's
      // evidence row, so it must always be an exact, request-scoped subset of ctx.scopes (never
      // "memories" when the Memories scope wasn't enabled this turn, even though Calendar itself
      // was). Uses the singular group names ("memories"/"journal") shared with every other tool
      // and with assistant.js's SOURCE_GROUP_LABEL_KEY — not the collection name ("journals").
      const includedSources = [];
      if (includeMemories) includedSources.push("memories");
      if (includeJournal) includedSources.push("journal");
      const timestampMeaning = {};
      if (includeMemories) timestampMeaning.memories = "uploadedAt";
      if (includeJournal) timestampMeaning.journals = "createdAt";

      return {
        resolvedRange: { startDate: args.startDate, endDate: args.endDate, timeZone: args.timeZone },
        includedSources,
        timestampMeaning,
        excludedSources: ["finance"],
        // `activeDayCount` (days with at least one item) is deliberately separate from
        // `totalItems` (every item across the whole range, even beyond the 5-per-day sample cap)
        // — task C explicitly calls out that conflating the two produced misleading answers.
        activeDayCount: days.length,
        totalItems,
        days,
      };
    },
  },

  draft_reflection: {
    scope: null, // always available; never fetches new data
    description:
      "Draft (never saves) a short reflection using ONLY items already surfaced earlier in this same conversation by another tool call. Provide the opaque handle(s) from those earlier tool results — never invent an id.",
    parameters: {
      type: "object",
      properties: {
        sourceRefs: {
          type: "array",
          maxItems: 10,
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["memory", "journal", "journey"] },
              handle: { type: "string", description: "The opaque handle string from an earlier tool result — never a document ID." },
            },
            required: ["type", "handle"],
            additionalProperties: false,
          },
        },
        focus: { type: "string", description: "Optional short note on what to emphasize.", maxLength: 200 },
      },
      required: ["sourceRefs"],
      additionalProperties: false,
    },
    validate(args) {
      const refs = Array.isArray(args && args.sourceRefs) ? args.sourceRefs : [];
      if (!refs.length) throw new ToolValidationError("sourceRefs_required");
      if (refs.length > 10) throw new ToolValidationError("too_many_sourceRefs");
      const clean = refs.map((r) => {
        if (!r || !["memory", "journal", "journey"].includes(r.type) || !isPlainString(r.handle) || !r.handle) {
          throw new ToolValidationError("invalid_sourceRef");
        }
        return { type: r.type, handle: r.handle };
      });
      const focus = args && args.focus ? truncate(String(args.focus), 200) : null;
      return { sourceRefs: clean, focus };
    },
    // Deliberately does NOT re-query Firestore and NEVER accepts a raw Firestore ID — only a
    // handle this exact request already issued via ctx.registerRef() can resolve to anything,
    // closing off any attempt to use this tool as a side-channel to probe arbitrary document ids
    // (task E). ctx.resolveHandle() only ever knows about handles from the CURRENT request (a
    // fresh registry is created per call to runAgentLoop — see qwen.js) — resolution can never
    // succeed against a handle from a previous, different request.
    async execute(args, ctx) {
      const approved = args.sourceRefs.filter((r) => {
        const resolved = ctx.resolveHandle(r.handle);
        return resolved && resolved.type === r.type;
      });
      const rejected = args.sourceRefs.length - approved.length;
      return {
        note: "This is a draft only — nothing was saved. Review and save it yourself from the relevant page if you'd like to keep it.",
        focus: args.focus,
        approvedSourceCount: approved.length,
        rejectedSourceCount: rejected,
      };
    },
  },
};

function toolDefsForScopes(scopes) {
  const enabled = new Set(scopes || []);
  return Object.entries(TOOLS)
    .filter(([, def]) => {
      if (def.scope !== null && !enabled.has(def.scope)) return false;
      // A tool may declare `dependsOnAny` — other scopes at least one of which must ALSO be
      // enabled before this tool is offered, even though its own `scope` is satisfied. Today
      // only list_calendar uses this (Calendar alone is a capability with nothing to summarize).
      if (def.dependsOnAny && !def.dependsOnAny.some((s) => enabled.has(s))) return false;
      return true;
    })
    .map(([name, def]) => ({ type: "function", function: { name, description: def.description, parameters: def.parameters } }));
}

module.exports = {
  TOOLS,
  toolDefsForScopes,
  ToolValidationError,
  MAX_TEXT_QUERY_LEN,
  DEFAULT_TIME_ZONE,
  fetchOwnerActivePhotos, // exported for direct ownership-merge/trash-exclusion tests
};
