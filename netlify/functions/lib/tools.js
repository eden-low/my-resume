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

const MAX_TEXT_QUERY_LEN = 120;
const CAPTION_TRUNCATE = 200;
const JOURNAL_TRUNCATE = 300;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

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

function parseBoundedDate(v) {
  if (!isPlainString(v) || !DATE_RE.test(v)) return null;
  const d = new Date(v + "T00:00:00Z");
  return Number.isNaN(d.getTime()) ? null : d;
}

// Shared "resolve + bound a date range" logic for list_journey/list_calendar. Never trusts an
// unbounded range: always clamps to `maxDays`, and always produces a concrete [start, end] even
// when the caller gave nothing (defaults to the trailing `defaultDays` window ending today).
function resolveDateRange({ startDate, endDate }, { maxDays, defaultDays }) {
  const now = new Date();
  let end = endDate ? parseBoundedDate(endDate) : null;
  let start = startDate ? parseBoundedDate(startDate) : null;
  if (startDate && !start) throw new ToolValidationError("invalid_start_date");
  if (endDate && !end) throw new ToolValidationError("invalid_end_date");

  if (!end) end = start ? new Date(start.getTime() + defaultDays * MS_PER_DAY) : now;
  if (!start) start = new Date(end.getTime() - defaultDays * MS_PER_DAY);
  if (start > end) throw new ToolValidationError("start_date_after_end_date");

  const rangeDays = Math.ceil((end.getTime() - start.getTime()) / MS_PER_DAY);
  if (rangeDays > maxDays) throw new ToolValidationError(`date_range_exceeds_${maxDays}_days`);

  return { start, end };
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

// ---- Firestore reads. Every function below is the ONLY place its collection name appears —
// there is no generic "run this query" path the model could ever reach. ----

async function fetchOwnerActivePhotos(db, uid) {
  const snap = await db.collection("photos").where("uid", "==", uid).get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((doc) => !isDeletedMemory(doc));
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
        .map((p) => ({
          id: p.id,
          caption: truncate(p.caption || "", CAPTION_TRUNCATE),
          tags: Array.isArray(p.tags) ? p.tags.slice(0, 10) : [],
          locationName: p.locationName || null,
          hasConfirmedLocation: hasConfirmedCoords(p),
        }));
      matches.forEach((m) => ctx.registerRef("memory", m.id));
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
        .map((p) => ({ id: p.id, caption: truncate(p.caption || "", CAPTION_TRUNCATE), locationName: p.locationName || null }));
      missing.forEach((m) => ctx.registerRef("memory", m.id));
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
        .map((j) => ({
          id: j.id,
          title: truncate(j.title || "", 100),
          excerpt: truncate(j.content || "", JOURNAL_TRUNCATE),
          mood: j.mood || null,
          tags: Array.isArray(j.tags) ? j.tags.slice(0, 10) : [],
        }));
      matches.forEach((m) => ctx.registerRef("journal", m.id));
      return { count: matches.length, results: matches };
    },
  },

  list_journey: {
    scope: "journey",
    description: "List the Owner's own Journey (life) events within an optional bounded date range (max 366 days).",
    parameters: {
      type: "object",
      properties: {
        startDate: { type: "string", description: "YYYY-MM-DD, inclusive." },
        endDate: { type: "string", description: "YYYY-MM-DD, inclusive." },
        limit: { type: "integer", description: "Max results (1-20).", minimum: 1, maximum: 20 },
      },
      required: [],
      additionalProperties: false,
    },
    validate(args) {
      const range = resolveDateRange(args || {}, { maxDays: 366, defaultDays: 90 });
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
        .map((e) => ({
          id: e.id,
          title: truncate(e.title || "", 100),
          type: e.type || null,
          date: docMillis(e, "date") ? new Date(docMillis(e, "date")).toISOString().slice(0, 10) : null,
          locationName: e.locationName || null,
          tags: Array.isArray(e.tags) ? e.tags.slice(0, 10) : [],
        }));
      inRange.forEach((m) => ctx.registerRef("journey", m.id));
      return { count: inRange.length, results: inRange };
    },
  },

  list_calendar: {
    scope: "calendar",
    description: "Day-by-day activity summary (Memories + Journal only — never Finance) for the Owner within a required, tightly bounded date range (max 31 days).",
    parameters: {
      type: "object",
      properties: {
        startDate: { type: "string", description: "YYYY-MM-DD, inclusive." },
        endDate: { type: "string", description: "YYYY-MM-DD, inclusive." },
      },
      required: ["startDate", "endDate"],
      additionalProperties: false,
    },
    validate(args) {
      if (!(args && args.startDate && args.endDate)) throw new ToolValidationError("start_and_end_date_required");
      return resolveDateRange(args, { maxDays: 31, defaultDays: 7 });
    },
    async execute(args, ctx) {
      const [photos, journals] = await Promise.all([
        fetchOwnerActivePhotos(ctx.db, ctx.uid),
        fetchOwnerJournals(ctx.db, ctx.uid),
      ]);
      const byDay = new Map();
      const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
      const bump = (ms, type, id, title) => {
        if (ms < args.start.getTime() || ms > args.end.getTime()) return;
        const key = dayKey(ms);
        if (!byDay.has(key)) byDay.set(key, { date: key, memories: 0, journal: 0, samples: [] });
        const bucket = byDay.get(key);
        bucket[type === "memory" ? "memories" : "journal"] += 1;
        if (bucket.samples.length < 5) bucket.samples.push({ type, id, title: truncate(title || "", 60) });
      };
      photos.forEach((p) => { const ms = docMillis(p, "uploadedAt"); if (ms) { bump(ms, "memory", p.id, p.caption); ctx.registerRef("memory", p.id); } });
      journals.forEach((j) => { const ms = docMillis(j, "createdAt"); if (ms) { bump(ms, "journal", j.id, j.title); ctx.registerRef("journal", j.id); } });
      const days = Array.from(byDay.values()).sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 31);
      return { count: days.length, days };
    },
  },

  draft_reflection: {
    scope: null, // always available; never fetches new data
    description:
      "Draft (never saves) a short reflection using ONLY items already surfaced earlier in this same conversation by another tool call. Provide the memory/journal/journey ids to draw from.",
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
              id: { type: "string" },
            },
            required: ["type", "id"],
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
        if (!r || !["memory", "journal", "journey"].includes(r.type) || !isPlainString(r.id) || !r.id) {
          throw new ToolValidationError("invalid_sourceRef");
        }
        return { type: r.type, id: r.id };
      });
      const focus = args && args.focus ? truncate(String(args.focus), 200) : null;
      return { sourceRefs: clean, focus };
    },
    // Deliberately does NOT re-query Firestore: only allowed to reference ids this same
    // conversation turn already legitimately surfaced via ctx.registerRef(), closing off any
    // attempt to use this tool as a side-channel to probe arbitrary document ids.
    async execute(args, ctx) {
      const approved = args.sourceRefs.filter((r) => ctx.wasRefSeen(r.type, r.id));
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
    .filter(([, def]) => def.scope === null || enabled.has(def.scope))
    .map(([name, def]) => ({ type: "function", function: { name, description: def.description, parameters: def.parameters } }));
}

module.exports = { TOOLS, toolDefsForScopes, ToolValidationError, MAX_TEXT_QUERY_LEN };
