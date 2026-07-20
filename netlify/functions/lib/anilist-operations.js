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
// (browse/search/batch) never request description/genres; only `details` does, and even then
// only description(asHtml: false) — never externalLinks, streamingEpisodes, characters, staff,
// or full tags data, none of which this file's queries ever mention.

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
// nextAiringEpisode, description, genres, siteUrl (plus isAdult, read server-side only, stripped
// before the response ever reaches the client — see sanitize*() below). Never
// externalLinks/streamingEpisodes/characters/staff/tags. ----
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
`;

const DETAIL_FIELDS = `
  ${LIST_FIELDS}
  description(asHtml: false)
  genres
`;

const BROWSE_SEASON_QUERY = `
  query ($page: Int, $perPage: Int, $season: MediaSeason, $seasonYear: Int, $isAdult: Boolean) {
    Page(page: $page, perPage: $perPage) {
      media(type: ANIME, isAdult: $isAdult, season: $season, seasonYear: $seasonYear, sort: POPULARITY_DESC) {
        ${LIST_FIELDS}
      }
    }
  }
`;

const BROWSE_TRENDING_QUERY = `
  query ($page: Int, $perPage: Int, $isAdult: Boolean) {
    Page(page: $page, perPage: $perPage) {
      media(type: ANIME, isAdult: $isAdult, sort: TRENDING_DESC) {
        ${LIST_FIELDS}
      }
    }
  }
`;

const SEARCH_QUERY = `
  query ($search: String, $page: Int, $perPage: Int, $isAdult: Boolean) {
    Page(page: $page, perPage: $perPage) {
      media(type: ANIME, isAdult: $isAdult, search: $search, sort: SEARCH_MATCH) {
        ${LIST_FIELDS}
      }
    }
  }
`;

const DETAILS_QUERY = `
  query ($id: Int, $isAdult: Boolean) {
    Media(id: $id, type: ANIME, isAdult: $isAdult) {
      ${DETAIL_FIELDS}
    }
  }
`;

const BATCH_QUERY = `
  query ($ids: [Int], $perPage: Int, $isAdult: Boolean) {
    Page(perPage: $perPage) {
      media(type: ANIME, isAdult: $isAdult, id_in: $ids) {
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
        return { query: BROWSE_SEASON_QUERY, variables: { page: v.page, perPage: v.perPage, season, seasonYear, isAdult: false } };
      }
      return { query: BROWSE_TRENDING_QUERY, variables: { page: v.page, perPage: v.perPage, isAdult: false } };
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
      return { query: SEARCH_QUERY, variables: { search: v.query, page: v.page, perPage: v.perPage, isAdult: false } };
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
      return { query: BATCH_QUERY, variables: { ids: v.ids, perPage: v.ids.length, isAdult: false } };
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
};
