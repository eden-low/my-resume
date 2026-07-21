// EdenAtlas Discover — the strict, server-side AniList GraphQL operation allowlist.
//
// The browser never supplies a GraphQL document, a field selection, or a raw `variables` object:
// it picks one of the fixed operation names below (browse/search/details/batch) and supplies
// validated leaf arguments only. Every operation's `buildRequest()` constructs a fixed,
// hand-written query string and a fully server-controlled variables object — mirroring
// netlify/functions/lib/tools.js's design for the Atlas Assistant's tool allowlist exactly.
//
// isAdult:false is baked into every buildRequest() unconditionally. No function in this file
// ever reads an `isAdult` value out of the caller-supplied `args` — there is nowhere for a
// client-supplied value to even flow in from.
//
// "Do not bulk-copy or hoard the AniList catalog" (product direction) shapes every limit below:
// small page/batch sizes, and a fixed, narrow field selection per operation. List operations
// (browse/search/batch) never request description; only `details` does, and even then only
// description(asHtml: false) — never externalLinks, streamingEpisodes, characters, staff, or full
// tags data, none of which this file's queries ever mention. `genres` IS now fetched by every
// operation (added below) — but solely as input to the excluded-genre content-filter check; it is
// never included in a list-item's sanitized OUTPUT (see sanitizeMediaListItem()), matching the
// pre-existing "list items never expose genres" shape exactly.
//
// ---- Content-filter policy: isAdult:false alone does not guarantee a general-audience catalogue.
// Live-verified against AniList's production API (2026-07-21): AniList id 178789 ("Mushoku Tensei
// III: Isekai Ittara Honki Dasu") is isAdult:false and still carries the "Ecchi" genre
// classification — reachable via Trending/Search/Details/Batch before this fix. EXCLUDED_GENRES
// is the small, explicit, server-only allowlist of mature-oriented genre classifications Discover
// excludes on top of isAdult:false. Enforced in TWO layers, per operation:
//   - Page.media-based operations (browse this_season/trending, search, batch): query-level
//     `genre_not_in` (a real, schema-verified AniList argument — confirmed via live GraphQL
//     introspection against https://graphql.anilist.co: `Page.media(genre_not_in: [String])`).
//     Live-tested: applying it never errors and never changes the HTTP status of a Page query,
//     even when it excludes every requested id (confirmed 200 with an empty `media: []`).
//   - Singular Media-based operation (details): query-level `genre_not_in` is deliberately NOT
//     used, even though the same argument exists on the `Media` field too — live-tested that
//     applying it to an id whose genres are excluded makes AniList itself respond with HTTP 404
//     (not a normal empty result), which would misroute through this Function's existing
//     `!res.ok` upstream-error handling (-> 502) instead of the clean, pre-existing
//     `{ok:true, result:null}` "not found" shape `details` already uses for a genuinely-missing
//     id. Relying on record-level filtering ALONE for `details` keeps that response shape exactly
//     consistent, at no cost to safety (see sanitizeMediaListItem()/sanitizeMediaDetail() below).
// Every operation ALSO re-validates every record it gets back, server-side, via
// sanitizeMediaListItem()'s hasExcludedGenre() check — defense-in-depth against any case
// query-level exclusion doesn't (or, for `details`, deliberately isn't asked to) cover, exactly
// mirroring how isAdult is already both a query-level filter AND a record-level check above.
const EXCLUDED_GENRES = ["Ecchi"];
// Normalized once at module load: trimmed + lowercased, for exact (never substring) case-
// insensitive comparison against AniList's own genre strings.
const EXCLUDED_GENRES_NORMALIZED = new Set(EXCLUDED_GENRES.map((g) => g.trim().toLowerCase()));

function hasExcludedGenre(genres) {
  if (!Array.isArray(genres)) return false;
  return genres.some((g) => typeof g === "string" && EXCLUDED_GENRES_NORMALIZED.has(g.trim().toLowerCase()));
}

// Bumped whenever EXCLUDED_GENRES (or the filtering logic itself) changes, and folded into the
// cache key (see anilist.js) so a response cached under an older content-filter policy can never
// be served once a newer policy is deployed — an explicit, self-documenting guarantee rather than
// relying on the (currently also-true, but not a code guarantee) fact that a Netlify Function
// cold-starts with a fresh, empty in-memory cache on every new deploy.
const CONTENT_FILTER_POLICY_VERSION = "genre-v1";

class AniListValidationError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const MAX_SEARCH_LEN = 100;
const MAX_PAGE = 100;
const MAX_PER_PAGE = 25;
const MAX_BATCH_IDS = 25;

function rejectUnknownKeys(args, allowedKeys) {
  const extra = Object.keys(args || {}).filter((k) => !allowedKeys.includes(k));
  if (extra.length) throw new AniListValidationError("unknown_field");
}

function clampInt(v, { min, max, fallback }) {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v)) throw new AniListValidationError("invalid_integer");
  if (v < min || v > max) throw new AniListValidationError("integer_out_of_range");
  return v;
}

function validatePositiveInt(v, code) {
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) throw new AniListValidationError(code || "invalid_id");
  return v;
}

function validatePaging(args) {
  return {
    page: clampInt(args.page, { min: 1, max: MAX_PAGE, fallback: 1 }),
    perPage: clampInt(args.perPage, { min: 1, max: MAX_PER_PAGE, fallback: 20 }),
  };
}

// ---- Season helper (pure, testable — always takes an explicit clock, never calls `new Date()`
// itself, matching netlify/functions/lib/date-utils.js's convention for the Assistant's tools). ----
const SEASONS = ["WINTER", "SPRING", "SUMMER", "FALL"];
function currentSeason(now) {
  const month = now.getUTCMonth() + 1; // 1-12
  const index = Math.floor((month - 1) / 3);
  return { season: SEASONS[index], seasonYear: now.getUTCFullYear() };
}

// ---- Fixed field selections — the actual allowlist. Every field named here is one of:
// id, title, coverImage, averageScore, format, status, episodes, season, seasonYear,
// nextAiringEpisode, genres, siteUrl (plus isAdult, read server-side only, stripped before the
// response ever reaches the client — see sanitize*() below). `genres` is fetched by every
// operation solely to enforce EXCLUDED_GENRES server-side (see sanitizeMediaListItem()) — it is
// deliberately NOT included in a list item's sanitized OUTPUT (only sanitizeMediaDetail() exposes
// it, unchanged from before). Never externalLinks/streamingEpisodes/characters/staff/full tags
// data. ----
const LIST_FIELDS = `
  id
  title { romaji english native }
  coverImage { large medium }
  averageScore
  format
  status
  episodes
  season
  seasonYear
  nextAiringEpisode { airingAt timeUntilAiring episode }
  siteUrl
  isAdult
  genres
`;

const DETAIL_FIELDS = `
  ${LIST_FIELDS}
  description(asHtml: false)
`;

const BROWSE_SEASON_QUERY = `
  query ($page: Int, $perPage: Int, $season: MediaSeason, $seasonYear: Int, $isAdult: Boolean, $genreNotIn: [String]) {
    Page(page: $page, perPage: $perPage) {
      media(type: ANIME, isAdult: $isAdult, season: $season, seasonYear: $seasonYear, genre_not_in: $genreNotIn, sort: POPULARITY_DESC) {
        ${LIST_FIELDS}
      }
    }
  }
`;

const BROWSE_TRENDING_QUERY = `
  query ($page: Int, $perPage: Int, $isAdult: Boolean, $genreNotIn: [String]) {
    Page(page: $page, perPage: $perPage) {
      media(type: ANIME, isAdult: $isAdult, genre_not_in: $genreNotIn, sort: TRENDING_DESC) {
        ${LIST_FIELDS}
      }
    }
  }
`;

const SEARCH_QUERY = `
  query ($search: String, $page: Int, $perPage: Int, $isAdult: Boolean, $genreNotIn: [String]) {
    Page(page: $page, perPage: $perPage) {
      media(type: ANIME, isAdult: $isAdult, search: $search, genre_not_in: $genreNotIn, sort: SEARCH_MATCH) {
        ${LIST_FIELDS}
      }
    }
  }
`;

// Deliberately no `genre_not_in` here — see the "Content-filter policy" header comment above for
// why the singular Media(id:...) lookup relies on record-level filtering alone (sanitizeMediaDetail
// -> sanitizeMediaListItem) rather than a query-level exclusion that would change AniList's own
// HTTP response status for an excluded id.
const DETAILS_QUERY = `
  query ($id: Int, $isAdult: Boolean) {
    Media(id: $id, type: ANIME, isAdult: $isAdult) {
      ${DETAIL_FIELDS}
    }
  }
`;

const BATCH_QUERY = `
  query ($ids: [Int], $perPage: Int, $isAdult: Boolean, $genreNotIn: [String]) {
    Page(perPage: $perPage) {
      media(type: ANIME, isAdult: $isAdult, id_in: $ids, genre_not_in: $genreNotIn) {
        ${LIST_FIELDS}
      }
    }
  }
`;

// ---- Response sanitizers — explicit allowlisted-key picks, never a spread of the raw upstream
// object. `isAdult` is read here (defense-in-depth: dropped/filtered even though every query
// above already sends isAdult:false) and then discarded — it never appears in what's returned. ----

function isAniListSiteUrl(url) {
  if (typeof url !== "string") return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "anilist.co" || u.hostname.endsWith(".anilist.co"));
  } catch {
    return false;
  }
}

function sanitizeMediaListItem(m) {
  // Defense-in-depth: even though every query already filters isAdult:false server-side, a
  // result whose own isAdult field isn't explicitly false is dropped outright rather than
  // trusted — an adult entry must never reach the client through this function, full stop.
  if (!m || m.isAdult !== false) return null;
  // Defense-in-depth (and, for `details`, the ONLY layer — see DETAILS_QUERY's comment): a result
  // carrying an EXCLUDED_GENRES classification is dropped outright too, the exact same early-
  // return shape as the isAdult check above. This is the one place the excluded-genre policy is
  // actually enforced — every operation funnels through here (list operations directly; `details`
  // via sanitizeMediaDetail()'s `base = sanitizeMediaListItem(m)` call below), so the policy only
  // needs to be implemented once.
  if (hasExcludedGenre(m.genres)) return null;
  return {
    id: m.id,
    title: {
      romaji: typeof m.title?.romaji === "string" ? m.title.romaji : null,
      english: typeof m.title?.english === "string" ? m.title.english : null,
      native: typeof m.title?.native === "string" ? m.title.native : null,
    },
    coverImage: {
      large: typeof m.coverImage?.large === "string" ? m.coverImage.large : null,
      medium: typeof m.coverImage?.medium === "string" ? m.coverImage.medium : null,
    },
    averageScore: Number.isFinite(m.averageScore) ? m.averageScore : null,
    format: typeof m.format === "string" ? m.format : null,
    status: typeof m.status === "string" ? m.status : null,
    episodes: Number.isFinite(m.episodes) ? m.episodes : null,
    season: typeof m.season === "string" ? m.season : null,
    seasonYear: Number.isFinite(m.seasonYear) ? m.seasonYear : null,
    nextAiringEpisode:
      m.nextAiringEpisode && Number.isFinite(m.nextAiringEpisode.airingAt)
        ? {
            airingAt: m.nextAiringEpisode.airingAt,
            timeUntilAiring: Number.isFinite(m.nextAiringEpisode.timeUntilAiring) ? m.nextAiringEpisode.timeUntilAiring : null,
            episode: Number.isFinite(m.nextAiringEpisode.episode) ? m.nextAiringEpisode.episode : null,
          }
        : null,
    siteUrl: isAniListSiteUrl(m.siteUrl) ? m.siteUrl : null,
  };
}

function sanitizeMediaDetail(m) {
  const base = sanitizeMediaListItem(m);
  if (!base) return null;
  return {
    ...base,
    description: typeof m.description === "string" ? m.description : null,
    genres: Array.isArray(m.genres) ? m.genres.filter((g) => typeof g === "string").slice(0, 20) : [],
  };
}

// ---- Operation registry ----

const OPERATIONS = {
  browse: {
    validate(args) {
      const a = args || {};
      rejectUnknownKeys(a, ["mode", "page", "perPage"]);
      if (a.mode !== "this_season" && a.mode !== "trending") throw new AniListValidationError("invalid_mode");
      return { mode: a.mode, ...validatePaging(a) };
    },
    buildRequest(v, ctx) {
      if (v.mode === "this_season") {
        const { season, seasonYear } = currentSeason(ctx.now);
        return { query: BROWSE_SEASON_QUERY, variables: { page: v.page, perPage: v.perPage, season, seasonYear, isAdult: false, genreNotIn: EXCLUDED_GENRES } };
      }
      return { query: BROWSE_TRENDING_QUERY, variables: { page: v.page, perPage: v.perPage, isAdult: false, genreNotIn: EXCLUDED_GENRES } };
    },
    sanitize(data) {
      const list = data && data.Page && Array.isArray(data.Page.media) ? data.Page.media : [];
      return { results: list.map(sanitizeMediaListItem).filter(Boolean) };
    },
  },

  search: {
    validate(args) {
      const a = args || {};
      rejectUnknownKeys(a, ["query", "page", "perPage"]);
      const q = typeof a.query === "string" ? a.query.trim() : "";
      if (!q) throw new AniListValidationError("query_required");
      if (q.length > MAX_SEARCH_LEN) throw new AniListValidationError("query_too_long");
      return { query: q, ...validatePaging(a) };
    },
    buildRequest(v) {
      return { query: SEARCH_QUERY, variables: { search: v.query, page: v.page, perPage: v.perPage, isAdult: false, genreNotIn: EXCLUDED_GENRES } };
    },
    sanitize(data) {
      const list = data && data.Page && Array.isArray(data.Page.media) ? data.Page.media : [];
      return { results: list.map(sanitizeMediaListItem).filter(Boolean) };
    },
  },

  details: {
    validate(args) {
      const a = args || {};
      rejectUnknownKeys(a, ["id"]);
      return { id: validatePositiveInt(a.id, "invalid_id") };
    },
    buildRequest(v) {
      return { query: DETAILS_QUERY, variables: { id: v.id, isAdult: false } };
    },
    sanitize(data) {
      return { result: sanitizeMediaDetail(data && data.Media) };
    },
  },

  batch: {
    validate(args) {
      const a = args || {};
      rejectUnknownKeys(a, ["ids"]);
      if (!Array.isArray(a.ids) || a.ids.length === 0) throw new AniListValidationError("ids_required");
      const deduped = [...new Set(a.ids)];
      if (deduped.length > MAX_BATCH_IDS) throw new AniListValidationError("too_many_ids");
      deduped.forEach((id) => validatePositiveInt(id, "invalid_id"));
      return { ids: deduped };
    },
    buildRequest(v) {
      return { query: BATCH_QUERY, variables: { ids: v.ids, perPage: v.ids.length, isAdult: false, genreNotIn: EXCLUDED_GENRES } };
    },
    sanitize(data) {
      const list = data && data.Page && Array.isArray(data.Page.media) ? data.Page.media : [];
      return { results: list.map(sanitizeMediaListItem).filter(Boolean) };
    },
  },
};

module.exports = {
  OPERATIONS,
  AniListValidationError,
  MAX_SEARCH_LEN,
  MAX_PAGE,
  MAX_PER_PAGE,
  MAX_BATCH_IDS,
  currentSeason,
  sanitizeMediaListItem,
  sanitizeMediaDetail,
  isAniListSiteUrl,
  EXCLUDED_GENRES,
  hasExcludedGenre,
  CONTENT_FILTER_POLICY_VERSION,
};
