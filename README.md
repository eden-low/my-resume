# EdenAtlas

*A personal digital atlas for memories, growth, career, and life.*

A 17-page **login-first**, **multi-tenant**, **bilingual (English/中文)** personal system built
around Low Fang Jun ("Jun"), styled as a dark glassmorphism product (near-black canvas,
translucent blurred cards, a single soft violet accent, Apple system fonts). The owner and any
number of approved "friends" each get their own private expenses/journal/photos/timeline/habits
space, isolated by Firebase Auth `uid`; anyone else who signs in is a read-only Viewer limited to
public content — including HR visitors reviewing the public **Career** page. Every page requires
Google sign-in via `login.html` before it renders — see [Login gate](#login-gate-auth-guardjs--loginhtml)
below. Built as static HTML/CSS with Tailwind CSS (a pinned local build, `tailwind.config.js` +
`npm run build:css` — see Tech stack below) — no framework, no bundler; the frontend JS itself
stays buildless. Installable as a PWA (`manifest.json` + `service-worker.js`, real
`images/icon-192.png`/`icon-512.png` app icons) with offline shell caching. Desktop uses a
permanent left [sidebar](#desktop-sidebar-jssidebarjs); mobile (below the `md` breakpoint) uses
a fixed top bar, slide-in drawer, bottom nav, and Quick Add sheet — see
[Mobile navigation](#mobile-navigation-jsmobile-navjs) below. See [design-system.md](design-system.md)
for the full visual language.

**v2.6** was a product-design pass, not a feature pass: the AI Assistant module was removed
entirely (it didn't fit "organize your life"); the horizontal top-nav was replaced by a
permanent desktop sidebar; Home, Career, and Profile were each calmed down (fewer cards, less
"portfolio" framing); empty states got warmer copy; Lucide was adopted as the icon standard for
newly-touched surfaces; and a handful of restrained animations (page fade-in, card hover lift,
loading skeletons) were added.

**v2.7 ("Collections & Atlas")** connects the existing record types instead of adding new ones:
records can now be grouped into **Collections** (life chapters like "Japan Trip") and carry a
**location**, both browsable from the new **Atlas** map; Memories/Journal/Finance/Journey items
(plus Career Projects) gained an edit-metadata affordance they never had before; and Profile +
Settings + Dashboard's personal-analytics half merged into one **Me** control center, with
Dashboard trimmed to just Search People (relabeled **Connections**). See `CLAUDE.md`'s version
history for the full breakdown.

**v2.8 ("Polish · Identity · Experience")** is a pure UX pass — no new pages, no database or
Firebase changes. `login.html` was rebuilt into a single centered card (EA mark, tagline,
"Continue with Google," a privacy line, a stacked footer) over an almost-invisible dark
gradient/orbit/dot texture, with a small EA-mark fade transition after sign-in instead of an
abrupt redirect. **Connections** (`dashboard.html`) grew from a bare search box into an Apple
Contacts-style page — Search, **Recommended Connections** (a small recently-joined strip), **Your
Connections** (everyone you can currently see), and a **Connection Requests** placeholder for a
future feature — with richer cards (bio, location, public Collections count). `profile.html`
gained **Career** and **Public Atlas** sections (a location-name summary linking out to Atlas,
not a re-embedded map). The language switcher was consolidated to exactly three places — Me →
Preferences, the desktop sidebar footer (new), and the mobile drawer footer — everywhere else was
already clean. A sitewide EA-mark loading state now shows during the auth check instead of a
blank flash, several empty states got warmer copy, and hover/press micro-interactions were
extended to the newly-touched surfaces.

**v2.9 ("Living Memories")** is an i18n-completion + emotional-features pass — no Firebase
architecture changes, no schema changes to existing collections. Full sitewide i18n: every
button, modal, form, placeholder, empty state, status message, and Chart.js label now switches
language, not just nav/titles — `js/i18n.js`'s `t()` gained `{placeholder}` interpolation and an
English-dict fallback chain, and every page-level script now listens for `eden:langchange` to
re-render its already-cached data instantly on a language switch. Two new always-private
features: **Time Capsule** ([time-capsule.html](time-capsule.html), a new `time_capsules`
collection) — write a message to your future self, sealed until a chosen date, with a calm
"ready" notice on Home; and **Daily Reflection** (a new `daily_reflections` collection, one
doc per day via a deterministic `${uid}_${dateKey}` ID) — a quick mood + one-sentence check-in
card on Home, no full journal entry required. **Reports** gained **Monthly Story** and **Year in
Review** — template-based (no AI) warm-prose recaps built from your own existing data, each with
a Markdown export. Both new collections are owner-uid-only in `firestore.rules`, never exposed
via `isMineOrPublic()`, and never surfaced on public profiles, Connections, or Collections.

**v3.2 ("Trusted Connections")** turns **Connections** from a role-based directory/placeholder
into a real, mutual-consent friend-request graph (`friend_requests`/`friendships`, entirely
separate from the Owner/Friend/Viewer role system below), and adds a third `visibility:
"connections"` tier — private/connections/public — to Memories/Journal/Journey/Collections
(never Finance/Time Capsule/Daily Reflection/Career, which stay exactly as private/owner-only as
before). The accept flow needs no transaction or Cloud Function: every write is scoped to the
caller's own uid, and each side's friendship-mirror doc self-heals lazily on next load. Connections
gained **Friend Requests** and **Sent Requests** sections alongside a **My Friends** list now
sourced from real acceptances (not just "everyone your role can see"); `profile.html` merges in
connections-tier content for accepted friends but deliberately stays single-scroll, not rebuilt
into tabs. Desktop/mobile navigation is now role-aware — non-owners get a shorter "Light EdenAtlas"
link set, with owner-only pages redirecting non-owners on direct access. See `CLAUDE.md`'s
"EdenAtlas v3.2" history section for the full design.

## Roles

- **Owner** (`jjun8647@gmail.com`) — full access everywhere, plus the only role that sees System Logs and Whitelist Management in Me → Connections/System Logs.
- **Friend** — anyone approved via Settings' Whitelist (a `friends/{email}` Firestore doc). Gets their own space for Memories/Journal/Journey/Habits/Atlas/Collections/Calendar, structurally identical to the owner's for those modules. As of v3.3, Finance/Time Capsule/Daily Reflection stay Owner-only regardless of Friend status.
- **Viewer** — anyone else who signs in with Google. Read-only: sees public content from the owner and any friend, can like/comment on public gallery posts, but can't create anything of their own.

Nobody is ever signed out or blocked at login — everyone gets in, access just scales with role.
This role system decides CRUD permissions and profile discoverability; it's independent of the
**friend graph** (v3.2) that separately decides whether `visibility: "connections"` content is
shown to a specific accepted friend once a profile is reachable at all — see the v3.2 paragraph
above.

## Pages

| Page | File | Content |
|---|---|---|
Nav labels below reflect the current EdenAtlas naming; file names are unchanged from the
original build to avoid a risky site-wide route rename (see the Brand & navigation section).

| Nav label | File | Content |
|---|---|---|
| (public root) | [index.html](index.html) | **Recruiter-facing public Portfolio (v3.5 content, promoted to the site root)** — the default GitHub Pages entry, no sign-in required. A calm one-page hero → snapshot → **Selected Work** (up to 3 featured projects) → **Experience** → **Leadership** → **Skills** → **Education** → **About** → **Contact**. Reads the Career CMS anonymously (public `career_projects`/`career_experiences`), falling back to curated verified content when the CMS is empty. Default English, EN/中文 toggle, its own clean shell (no private-app sidebar/nav), an "Enter EdenAtlas"/"Open EdenAtlas" CTA that adapts to auth state without ever redirecting a signed-in visitor away. Send the URL straight to recruiters |
| (none) | [login.html](login.html) | Reachable while signed out (and linked from the Portfolio's "Enter EdenAtlas") — "Sign in with Google," resolves the signer's role, then redirects into the app (to whatever `?redirect=` page sent you here, or `home.html` by default) |
| Home | [home.html](home.html) | The private Personal OS landing page (moved off `index.html` when the public Portfolio was promoted to the root — content otherwise unchanged): a daily-habit landing page, not a dashboard: a time-of-day greeting + live clock + weather, a **Today** strip (habits/spending/journal/photos/notifications), an "On This Day" **Memories** flashback, **Recent Memories** (latest photo/journal/timeline events), a **This Month** recap, and **Quick Actions** (add an expense/journal entry/photo without leaving the page) |
| Career | [resume.html](resume.html) | HR-ready resume following a standard resume formula: Header/Contact + Profile Summary → Education → Experience → Projects → Leadership & Events → Certificates → Awards → Skills & Languages. Profile/Education/Leadership/Skills sections are static markup; **Experience**, **Projects** (with Featured strip + detail modal + Reflection), **Certificates**, and **Awards** are Firestore-backed and owner-editable, everyone else sees public items read-only. See [Career CMS](#career-cms-careerjs) below |
| Memories | [gallery.html](gallery.html) | Instagram-style feed — your own photos (any visibility) plus everyone's public ones, organized into albums (Travel/Projects/Events/Daily Life) plus a cross-cutting Favorites star; likes, comments, and per-post view analytics visible only to that post's own creator; owner can edit a post's caption/album/collection/tags/location/visibility after the fact, and bulk-move several photos into a Collection at once |
| Atlas | [atlas.html](atlas.html) | A Leaflet.js + CARTO-tiles map of every place your Memories/Journal/Journey carry a location for — **My Atlas** (your own, any visibility) and **Connections** (lazy-loaded; public content, rounded coordinates, capped to 100 recent items, plus, as of v3.2, `visibility: "connections"` items from your real accepted friends — never expenses) segmented tabs; clicking a pin opens a location detail panel. Its "Collections" tab is the only nav entry point into `collections.html` |
| Journal | [journal.html](journal.html) | Daily journal — markdown entries with mood + tags, optional image, optional location; your own entries plus everyone's public ones; owner can edit an entry's metadata after the fact |
| Finance | [expenses.html](expenses.html) | Personal spend tracker — always private, never shared; daily-spending and by-category Chart.js charts; owner can edit amount/category/note/date/collection/tags after the fact |
| Journey | [timeline.html](timeline.html) | Life events grouped by year — your own events plus everyone's public ones; owner can edit an event's metadata (incl. location) after the fact. Reachable from the sidebar's secondary group now that Atlas is the larger location/chapter module |
| Habits | [habits.html](habits.html) | Habit tracker — daily check-ins, streaks, a 7-day weekly strip, and a monthly completion ring per habit |
| Calendar | [calendar.html](calendar.html) | Monthly 7-column grid of your own expenses/photos/journal entries, bucketed by day |
| Reports | [reports.html](reports.html) | Monthly recap of your own activity — total spend, top category, weekday-vs-weekend spending comparison, photo/journal counts |
| Connections | [dashboard.html](dashboard.html) | A real friend-request system as of v3.2: Search People (role-gated discovery, unchanged), **Friend Requests** (incoming, Accept/Decline), **My Friends** (real accepted friendships), and **Sent Requests** — richer cards (bio/location/public Collections count) link to `profile.html` — personal analytics/Goals/Achievements stay on **Me** (moved there in v2.7) |
| (search result only) | [profile.html](profile.html) | Read-only GitHub+Instagram-style profile (`?uid=`) opened from Connections — avatar/name/@username/bio/location/joined date, public stats (incl. habit completion %), **Career** (public items, v2.8), photo **Albums** (Travel/Projects/Events/Daily Life/Favorites), **Public Atlas** (a location-name summary linking to Atlas, v2.8), public Timeline/Journal lists, and public Achievement badges — public content plus, as of v3.2, `visibility: "connections"` content when you're an accepted friend of the profile owner; nothing editable. Not in the nav — only reachable via a search result, same as `login.html` |
| Inbox | [notifications.html](notifications.html) | Your own notification center — login/expense/journal/habit/gallery alerts, unread badge in the nav, mark-as-read |
| Contact | [contact.html](contact.html) | Email / phone / location, with a one-click "send message" CTA |
| (via Atlas) | [collections.html](collections.html) / [collection-detail.html](collection-detail.html) | **Collections** — life chapters (e.g. "Japan Trip") that group existing Memories/Journal/Finance/Journey/Career records via a `collectionId` reference, never a copy. List page: create/edit/delete (blocked while non-empty) with per-type item counts; detail page: cover/title/description/visibility header, one section per record type plus a Reflection/Notes field, and a synthetic "Uncategorized" view for anything with no collection |
| Me | [me.html](me.html) | Personal control center — merges the old Profile + Settings + Dashboard's personal analytics into one tabbed page: **Overview** (Goals/Time Capsule summary/Achievements/Gallery/Expense/Journal analytics), **Profile** (@username/bio/location/account dates), **Preferences** (theme/language/default city/default visibility), **Privacy** (role/visibility explainer), **Connections** (Whitelist Friend Management, owner-only), **Backup** (Export & Backup), **System Logs** (owner-only). `settings.html` now just redirects here |
| Time Capsule | [time-capsule.html](time-capsule.html) | Write a message to your future self — title/message/open date/optional attachment, sealed until that date. Three sections: Sealed / Ready to Open / Opened. Always private (`time_capsules` collection, owner-uid-only). A secondary sidebar/drawer item (v2.9), also reachable from Home's Quick Actions and Me's Overview tab |
| (compatibility redirect) | [portfolio.html](portfolio.html) | **No longer the Portfolio itself** — since the "Portfolio to root" routing change, this is a tiny redirect stub (preserves query string/hash, e.g. `portfolio.html#work` still lands on `index.html#work`) that forwards old bookmarks/shared links to the new root. The actual Portfolio content described below now lives at `index.html` |
| (public, from Portfolio) | [project.html](project.html) | **Reusable case-study renderer (v3.5)** — `project.html?slug=…`, opened from Selected Work. Eight sections (Overview / Problem / My Role / Investigation & Decisions / Solution / Result / What I Learned / Technology) with Previous/Next navigation. CMS project fields (by `slug`) merge over a curated fallback field-by-field; unknown slugs show a "not found" state |

## Running locally

No install or build required — just open [index.html](index.html) in a browser (the public Portfolio), or [home.html](home.html) directly if you're signing in to the private app — or serve the folder locally:

```powershell
npx serve .
```

## Deployment: Netlify

Production is [https://edenatlas.netlify.app/](https://edenatlas.netlify.app/) — `netlify.toml`
publishes a generated `site/` directory (never the repo root) built by
[scripts/build-site.js](scripts/build-site.js), a small dependency-free Node script that copies
an explicit **allowlist** of product files/directories (every real page, root-level script,
`js/`/`locales/`/`images/`, `styles.css`, `manifest.json`, `service-worker.js`) while preserving
every relative path exactly — still buildless in spirit (no bundler, no transpilation, byte-
identical copies), just not a bare repo-root publish. Internal docs (`CLAUDE.md`, `README.md`,
`design-system.md`, `brand-book.md`, `docs/*`), Firebase/Netlify config
(`firestore.rules`/`storage.rules`/`firebase.json`/`.firebaserc`/`.env*`), and the Netlify
Functions *source* tree (`netlify/`) are never in that allowlist, so they can't be served no
matter what — an earlier redirect-based blacklist approach was replaced after live testing found
it unreliable; see `scripts/build-site.js`'s and `netlify.toml`'s comments for the full story.
`functions = "netlify/functions"` reads Function source independently of `publish`, so
`/.netlify/functions/health` and `/.netlify/functions/assistant` (the Owner-only Atlas
Assistant, see below) work unaffected. Real secrets belong in Netlify's own Project
configuration → Environment variables — see `.env.example` for the documented variable names
(placeholders only, never committed values). `package.json` exists only for the one server-side
dependency a Function needs (`firebase-admin`) — the frontend itself installs nothing and stays
exactly as buildless as described above.

## Atlas Assistant: `assistant.html` + `netlify/functions/assistant.js`

An Owner-only, read-only AI assistant over the Owner's own Memories/Journal/Journey/Calendar,
powered by Qwen (Alibaba Cloud Model Studio's OpenAI-compatible Chat Completions API) through a
strict server-side tool allowlist — see [docs/ai-architecture.md](docs/ai-architecture.md) for
the full design and [CLAUDE.md](CLAUDE.md)'s history for the implementation notes. The browser
never talks to Qwen directly and never sees `DASHSCOPE_API_KEY`; every request is a Firebase
ID-token-authenticated call to `/.netlify/functions/assistant`, which re-verifies the token
server-side, confirms Owner role via two independent signals, and only then runs a bounded (max
3 rounds) tool-calling loop against six fixed, validated tools
(`netlify/functions/lib/tools.js`) — the model can never supply a raw collection name, document
path, uid, or query operator. No write path exists anywhere in this feature. Nothing is sent to
Qwen until the Owner explicitly accepts a bilingual consent notice; per-request data scopes
(Memories/Journal/Journey/Calendar) default off. Run
`node netlify/functions/__tests__/assistant.test.js` (or `npm run test:functions`) for the
deterministic, fully-mocked test suite (no real Firebase project or Qwen key needed).

## Discover (anime, Phase 1): `discover.html` + `netlify/functions/anilist.js`

An **Owner-only** personal anime tracker — not in the main nav table above (same treatment as
Atlas Assistant/Constellation: an Owner-scoped feature with its own dedicated section, not a row
in the primary-nav page table). Two views: **Discover** (This Season / Trending / Search, backed
live by [AniList](https://anilist.co)'s public GraphQL API) and **My List** (All / Plan to Watch /
Watching / Completed / Paused / Dropped), each card showing cover, preferred title, AniList's own
`averageScore`, format, airing status, available episode count, and next-airing info when
applicable. Every AniList request goes through `/.netlify/functions/anilist` — a fixed
operation allowlist (`browse`/`search`/`details`/`batch`, `netlify/functions/lib/
anilist-operations.js`) that constructs every GraphQL query server-side; the browser never
supplies a raw query, and `isAdult: false` is force-set into every request, never read from the
client. The Function reuses `assistant.js`'s exact Owner-authorization shape (a server-verified
Firebase ID token plus a `users/{uid}.role === "owner"` + email double-check) — a Friend or
Viewer's request is rejected with `403 owner_only` before any AniList call is ever made, and the
page itself is unreachable to them: `discover.html` carries `data-owner-only="true"` (the same
`auth-guard.js` backstop every other Owner-only page uses), and it appears in neither
`js/sidebar.js`'s nor `js/mobile-nav.js`'s Friend/Viewer ("Light EdenAtlas") link arrays. A short-
lived, bounded in-memory cache (`netlify/functions/lib/anilist-cache.js`, never a persistent
catalog store) and My List's batched `id_in` live-refresh (one Function call for the whole list,
never N+1) keep this from ever hoarding or bulk-copying the AniList catalog. Followed titles are
stored minimally in a new `followed_anime/{uid}_{anilistId}` collection — denormalized
title/cover/format/status only, never AniList's description/genres/score/airing schedule (those
are always fetched live on demand, never persisted) — gated Owner-only end to end by
`firestore.rules`. Run `node netlify/functions/__tests__/anilist.test.js` (or `npm run
test:functions`) for the deterministic, fully-mocked test suite. **Not part of Phase 1** (see
`CLAUDE.md`'s Discover history entry for the full scope): Qwen-personalized recommendations, a
"For You" feed, Web Push/scheduled episode-airing notifications, TV dramas, and any
streaming/external watch link beyond a single validated "View on AniList" link.

## Login gate: `auth-guard.js` + `login.html`

Every page except `login.html` is gated: a single `<script type="module" src="auth-guard.js"></script>` tag checks `onAuthStateChanged` and redirects to `login.html?redirect=<page>` if signed out, or reveals the page once a user is confirmed. `login.html` resolves the signer's role (Owner / Friend / Viewer, cached to `localStorage` as `lfj:userMode`), upserts a `users/{uid}` directory doc, writes a `login_logs` doc, and writes a "new login" notification — all before redirecting into the app. This gate is a UX convenience, not the security boundary — real access control is (and remains) enforced by `firestore.rules`/`storage.rules`.

On iPhone, an installed "Add to Home Screen" PWA can't reliably complete Google sign-in inside its own standalone window — `login.html` detects that (`isStandalone()`) and swaps the button for an "Open in Safari to Sign In" link instead, which hands off to real Safari where the normal popup flow works; the installed app picks up the resulting session on next launch.

## i18n: `js/i18n.js` + `locales/*.json`

A third shared module, loaded first (before `scripts.js`) on every protected page. English and
Simplified Chinese dictionaries live in [locales/en.json](locales/en.json) and
[locales/zh-CN.json](locales/zh-CN.json); any element with `data-i18n="nav.home"` (or
`data-i18n-placeholder="..."` for inputs) gets its text swapped in automatically. Language is
stored in `localStorage` (instant, no flash) and reconciled against `users/{uid}.lang` once auth
resolves (Firestore wins if it differs, so a choice made on one device follows you to another).
Switch it from Me → Preferences, the desktop sidebar footer, or the mobile drawer — all three
call the same `setLang()`, which re-applies translations immediately (no reload) and fires an
`eden:langchange` event. `career.js`, `collections.js`, and `collection-detail.js` listen for it
to re-render their bilingual **content** fields (`title_en`/`title_zh`, etc. — a separate
mechanism from `data-i18n` UI chrome, never auto-translated). As of v2.9, every page-level script
listens for the same event to re-render its cached dynamic content (list items, status text,
category/mood labels, chart labels) — full sitewide coverage, not just nav/titles. `t(key, vars)`
supports `{placeholder}` interpolation and falls back to the English dict (then the raw key) if a
translation is missing, with a `console.warn` on `localhost` only.

## Career CMS: `career.js`

`resume.html` (nav-labeled "Career") is no longer purely static — **Experience**, **Projects**,
**Certificates**, and **Awards** are backed by four new Firestore collections
(`career_experiences`, `career_projects`, `career_certificates`, `career_awards`), each doc
carrying `uid`/`visibility`/`createdAt`/`updatedAt` plus bilingual content fields. Unlike every
other collection in this app, Career is **not** per-user multi-tenant — the page has always been
about one person — so writes are Owner-only (`isOwner()`), not `canParticipate()`-gated; HR
visitors and Friends only ever read `visibility:"public"` items. Profile/Highlights/Education/
Leadership stay static prose (out of CMS scope); Projects adds a Featured strip, category
filter, a detail modal, and a Reflection field. **v3.5** adds optional, backward-compatible
public case-study fields on `career_projects` (`slug`, bilingual `role`/`challenge`/`actions`/
`outcome`) surfaced through an "Public Case Study (optional)" section in the project edit form —
these power [portfolio.html](portfolio.html)'s Selected Work and [project.html](project.html)'s
case-study pages; old projects missing them still render everywhere via safe fallbacks. Uploads go to
`career/{uid}/{public,private}/...` in Storage. A one-time, manually-run
[migrate-career.html](migrate-career.html) ports the old static Education/Work-Experience/
Achievements prose into the new collections — delete it after running once.

## Collections & Atlas (v2.7)

**Collections** ([collections.js](collections.js) / [collection-detail.js](collection-detail.js))
are containers, not a data migration — a Memory/Journal entry/Expense/Journey event/Career
project points at a collection via an optional `collectionId` field, and moving it between
collections (or back to "Uncategorized") is a one-field `updateDoc`, never a copy. The list page
shows mine+public collections plus a synthetic "Uncategorized" card, with per-type item counts;
delete is blocked (not just confirmed) while any item still references it. Cover images are a
plain URL string — either typed manually or copied from one of your own Memories — never a
Storage upload, so `storage.rules` needed no changes. Gallery also gained a **bulk move**
(a "Select" mode + floating action bar) to reassign several photos' `collectionId` at once.

**Atlas** ([atlas.js](atlas.js)) is a Leaflet.js map (CARTO dark/light tiles via CDN, no paid
API) of every `locationName`/`latitude`/`longitude` your Memories/Journal/Journey carry. **My
Atlas** (default) shows your own location-tagged records, any visibility, clustered by name and
plotted with exact coordinates. **Connections** (lazy-loaded only when that tab is opened) shows
public-only records from the owner + your approved friends, coordinates rounded to ~2 decimals,
capped to the 100 most recent, and — by construction of the query — never expenses. Clicking a
pin opens a detail panel: location name, per-type counts, linked Collections, a few recent
photos. Location input (`locationName` + optional lat/lng + a "Use current location" button
reusing `home.html`'s existing Geolocation pattern) was added to the Memories/Journal/Journey
create-and-edit forms; Finance/Career intentionally skip it.

## Desktop Sidebar: `js/sidebar.js`

A fifth shared module (v2.6), self-injecting like the others. The old horizontal top-nav
header is now permanently hidden on every breakpoint; on desktop, `js/sidebar.js` injects a
fixed left sidebar instead — as of v2.7: Home/Career/Memories/Atlas/Journal/Finance/Calendar/
Connections/Reports/Inbox as the primary list, Journey/Habits/**Time Capsule**(v2.9)/Contact as
a smaller secondary group (real pages that would otherwise have no nav entry — Journey moved here
now that Atlas is the larger location/chapter module), then **Me**/Logout/Collapse pinned to the
bottom (this row
used to say "Profile" and link to Settings; both were folded into Me). Collections has no sidebar
entry of its own — it's reached from inside Atlas. Collapses to an icon-only rail
(`localStorage`-persisted) via a `--sidebar-w` CSS variable that `body`'s `padding-left` reads,
so every page reflows without its own layout change.

## Mobile navigation: `js/mobile-nav.js`

A fourth shared module. Below the `md` breakpoint, the sidebar and the old desktop header both
stay hidden in favor of an injected fixed top bar (hamburger — brand — avatar, now linking to
Me), a slide-in drawer (full page list, including Atlas, + language switcher + logout), a fixed
bottom nav (Home / Memories / Quick Add / Connections / Me), and a **Quick Add** bottom sheet
(Add Expense / Write Journal / Upload Photo / Add Timeline Event / Add Habit / New Collection /
New Capsule (v2.9)) that deep-links to `{page}.html?new=1` — each target page's own script auto-opens its
existing "New X" modal when that param is present, rather than duplicating the form. All touch
targets are ≥44px.

## Global Search

[global-search.js](global-search.js) is a second shared module (alongside `auth-guard.js`) loaded on every protected page — it injects its own `Ctrl/Cmd-K` command palette into the header's nav rather than requiring per-page markup. Searches People/Gallery/Journal/Timeline/Habits/Expenses in one box, grouped results with a per-group count, each linking straight to the relevant page. Expenses are only ever searched against your own (never another uid — they stay strictly private by construction of the query itself).

## Memories, Goals & Achievements

- **Memories** ("On This Day," on the Home page) compares today's date against your own past photos/journal entries/timeline events from previous years and surfaces any matches as "N years ago" flashbacks.
- **Goals** (Me → Overview) — personal targets with a title, target/current amount, unit, and deadline; always private, same shape as Expenses.
- **Achievements** (Me → Overview, full set; Profile, public subset) are 100% computed from live Firestore counts — tiered badges for Photos Uploaded, Journal Entries, Expenses Recorded, and Longest Active Habit Streak. No hardcoded personal-history milestones. Profile only ever shows the badges derivable from *public* data (expenses are always private, so that badge never appears on anyone else's profile).
- **Daily Reflection** (v2.9, Home page) — a quick "How was today?" mood + one-sentence card, one entry per calendar day (`daily_reflections/{uid}_{dateKey}`, a `setDoc` merge so a same-day re-save overwrites instead of duplicating). Always private; Reports shows a monthly mood-count/most-common-mood/reflection-days summary built from the same collection.
- **Time Capsule** (v2.9) — see the Pages table above. Home shows a calm "A message from your past self is ready" card once any sealed capsule's open date has passed.

## Tech stack

- HTML5 + [Tailwind CSS](https://tailwindcss.com/) `3.4.19` (pinned exact `devDependency`; compiled locally via `npm run build:css`/`npm run watch:css` from root-level `tailwind.config.js` + `tailwind-input.css` into gitignored `tailwind.generated.css` — single shared config, no per-page CDN script or inline config block)
- [Chart.js](https://www.chartjs.org/) (loaded via CDN on `resume.html`, `expenses.html`, `dashboard.html`, and `reports.html`) for charts
- [marked.js](https://marked.js.org/) (loaded via CDN on `journal.html`) for lightweight markdown rendering
- [Font Awesome 6](https://fontawesome.com/) for icons
- System font stacks only — no webfont loading
- [Firebase](https://firebase.google.com/) (Auth, Firestore, Storage) via `firebase-init.js` and each page's own module, loaded as ES modules straight from `gstatic.com` — no npm install, no bundler
- [OpenWeatherMap](https://openweathermap.org/) Current Weather API for the homepage weather widget
- Shared custom styles in [styles.css](styles.css); shared behavior in [scripts.js](scripts.js) (scroll-reveal, service-worker registration)
- A PWA layer: [manifest.json](manifest.json) + [service-worker.js](service-worker.js) (network-first with cache fallback, bypassing Firebase/CDN/weather hosts)
- [Netlify](https://www.netlify.com/) for hosting (an allowlist-built `site/` publish directory, see [Deployment](#deployment-netlify) above) and [Netlify Functions](https://docs.netlify.com/functions/overview/) for server-side code — `netlify/functions/health.js` (dependency-free liveness check) and `netlify/functions/assistant.js` (the Owner-only Atlas Assistant, using [firebase-admin](https://www.npmjs.com/package/firebase-admin) for server-side auth — the one npm dependency in this repo, scoped to Functions only)
- [Qwen](https://www.alibabacloud.com/en/product/modelstudio) (Alibaba Cloud Model Studio, OpenAI-compatible Chat Completions API) powers the Atlas Assistant — see [Atlas Assistant](#atlas-assistant-assistanthtml--netlifyfunctionsassistantjs) above

## Design system

The site moved from a neon-cyber "hunter status" look to a dark glassmorphism dashboard: near-black background (`#0a0a0e`), translucent blurred cards (`.neon-border-purple`), a soft violet accent (`#a78bfa`) plus a cool blue secondary (`#6ea8fe`), system UI/monospace fonts. Every page reads its palette from the same token names in its inline `tailwind.config` — see CLAUDE.md for the exact values to keep in sync.

## The multi-tenant data model

Every content collection (`expenses`, `journals`, `photos`, `life_events`, `habits`) is scoped by a `uid` field identifying its creator. The core fetch pattern, used identically across Gallery/Journal/Timeline/Habits: two Firestore queries merged by doc ID — `where("uid","==",myUid)` (all of *my* docs, any visibility) plus `where("visibility","==","public")` (everyone's public docs). Expenses skip the public half entirely (always private, no visibility concept). Every "New X" button and write is gated by `canParticipate()` (Owner or Friend) rather than a global owner check, and every new doc is written with `uid: auth.currentUser.uid`.

`friends/{email}` (Me → Connections' Whitelist — Friend Management) grants Friend status; `users/{uid}` is a lightweight directory doc upserted on every login (now also carrying a public `role` field and an optional `username`), powering **Search People**. `usernames/{username}` is a one-doc-per-handle reservation collection (doc ID = the handle) that makes unique @usernames possible without a backend — Firestore's create-vs-update distinction means "claim if free" falls out of a plain `create` rule with no matching `update` rule. `collections/{id}` (v2.7) is a life-chapter container — same `isMineOrPublic` shape as `journals`/`life_events`/`habits` — that existing records reference via an optional `collectionId` field; `photos`/`journals`/`life_events`/`expenses`/`career_projects` also gained optional `tags`/`locationName`/`latitude`/`longitude` fields (expenses get `collectionId`/`tags` only — no location UI, no visibility, always private). `time_capsules` and `daily_reflections` (v2.9) are the two newest collections — always private, same owner-uid-only shape as `expenses`/`goals` (no `isMineOrPublic()`, ever): read/update/delete require `resource.data.uid == request.auth.uid`, create requires `canParticipate()`. [firestore.rules](firestore.rules) and [storage.rules](storage.rules) are the source of truth for all of this; after editing either, deploy with `npx firebase-tools deploy --only firestore:rules,storage` (see [firebase.json](firebase.json)/[.firebaserc](.firebaserc) — a dev-only CLI tool, the site itself stays buildless).

## Gallery: Instagram-style feed with social features

[gallery.js](gallery.js) renders a single reverse-chronological feed (your own posts + everyone's public ones), with a like button (`photos/{id}/likes/{uid}` — doc ID is the liker's uid, so "one like per user" is structural) and a comment thread open to any signed-in viewer who can read the post. Per-post view analytics (`photos/{id}/views`) — total views, unique visitors, recent visitor emails — are visible only to that specific post's own creator, not a site-wide owner. Uploads go to `gallery/{uid}/{public,private}/...` in Storage.

## Expenses, Journal, Timeline, Habits

All four follow the same shape: your own entries (any visibility) plus everyone's public ones, rendered from a client-side cache with category/mood/type filter tabs. Expenses ([expenses.js](expenses.js)) are the exception — always private, with two Chart.js charts (daily spending, by-category). Journal ([journal.js](journal.js)) entries are raw markdown rendered via marked.js on expand, with optional image upload to `journal/{uid}/{public,private}/...`. Timeline ([timeline.js](timeline.js)) groups `life_events` by year with a user-picked date. Habits ([habits.js](habits.js)) compute streaks, a 7-day strip, and a `conic-gradient` monthly completion ring client-side from a `completedDates` array.

## Calendar & Reports

[calendar.js](calendar.js) renders a monthly grid of your own expenses/photos/journal entries bucketed by day (fetched in full per collection, filtered client-side to the visible month — avoids needing a composite index for an equality-plus-date-range query). [insights.js](insights.js) computes a current-month recap: total spend, top category, a weekday-vs-weekend average-spend comparison with a warning banner, photo/journal counts, and a Daily Reflection summary (mood counts, most common mood, reflection days this month).

**Monthly Story** and **Year in Review** (v2.9, both in `reports.html`) turn the same data into a
warm, template-based paragraph — no AI, no external API — with a month/year picker (mirroring
`calendar.js`'s prev/next pattern) and a "Export as Markdown" button. Data sources: Memories,
Journal, Finance, Habits completion, Collections updated, Atlas locations visited, Career
projects (Owner only), Time Capsules, and Daily Reflections — always `where("uid","==",myUid)`
only, so neither section can ever surface another user's data, viewer or friend.

## Notifications

Each user sees only their own notifications ([notifications.js](notifications.js)). Every alert is self-written by whichever client observed the triggering condition — a login alert from `login.html`, a spending alert from `expenses.js` (RM1000/month threshold), a journal reminder from `journal.js` (3+ days quiet), a habit-streak alert from `habits.js` (30/60/90-day milestones), and a "someone liked your photo" alert from `gallery.js`. Deduped via `localStorage` checkpoints per condition. [auth-guard.js](auth-guard.js) lights up an unread badge next to the nav's Notifications link.

## Export & Backup

Available to any signed-in user from Settings ([export.js](export.js)) — downloads *your own* data: Expenses as CSV, Journal as a combined Markdown file, Timeline and Gallery metadata as JSON, and a "Full Backup" JSON bundling `{ profile, settings, expenses, journals, timeline, gallery_metadata, habits }`.

## Connections

[dashboard.js](dashboard.js) (nav-labeled "Connections" since v2.7, redesigned in v2.8, now backed by a real friend graph as of v3.2) fetches the `users` directory once, then role-filters it the same way it always has (a Viewer only finds the Owner; a Friend or the Owner finds the Owner and any Friend) for a live **Search** that takes over the page while typing, and a **Recommended Connections** strip (the four most recently joined people you can see) for discovery. Below that, four v3.2 sections run on a real `friend_requests`/`friendships` graph (entirely separate from the role system — see the Roles section above): **Friend Requests** (incoming pending, Accept/Decline), **My Friends** (real accepted friendships — replaces the old "everyone your role can see" list), and **Sent Requests** (pending requests you've sent, found by checking each candidate in the already-fetched directory — no new collection needed). Each card shows avatar/name/@username/bio/location/public-Collections-count and links to [profile.html](profile.html), a dedicated read-only profile page — never an inline summary, never email. Gallery/Expense/Journal analytics, Goals, and Achievements moved to [me.html](me.html)'s Overview tab in v2.7 (they used to live here).

## Me: personal control center

[me.js](me.js) merges what used to be three separate places — Settings, Dashboard's personal analytics, and (implicitly) a self-profile view — into one tabbed page: **Overview** (Gallery/Expense/Journal analytics, Goals, Achievements — all `uid==me`-only, unchanged logic from the old Dashboard), **Profile** (@username reservation flow, bio/location, read-only account dates — unchanged logic from the old Settings), **Preferences** (theme/language/default city/default post visibility), **Privacy** (a read-only explainer of the role/visibility model — deliberately minimal, no new toggles that nothing else reads), **Connections** (Whitelist Friend Management, owner-only), **Backup** (Export & Backup, wired to the unchanged [export.js](export.js)), and **System Logs** (last 20 `login_logs`, owner-only). [settings.html](settings.html) is now a one-line `<meta http-equiv="refresh">` redirect here, kept only for old bookmarks/links.

## Brand & navigation

Renamed sitewide from "Low Fang Jun / Personal OS" to **EdenAtlas** — nav labels changed
(Gallery→Memories, Timeline→Journey, Expenses→Finance, Notifications→Inbox, Resume→Career,
Dashboard→People, and as of v2.7, People→Connections, Settings→Me) but **file names were
deliberately left unchanged** to avoid the risk of a site-wide route rename (broken bookmarks,
PWA cache, internal links) for a purely cosmetic win — `dashboard.html` is "Connections" and
`settings.html` is now a redirect to the new `me.html`. Every page footer reads
`EdenAtlas · by Jun · Version 3.2` as of this pass (`login.html`'s footer is a stacked
EdenAtlas / Built by Jun / Version 3.2 layout instead, part of its v2.8 rebuild; every other
page kept its existing single-line layout and just had the version number bumped). Desktop/mobile
navigation (`js/sidebar.js`/`js/mobile-nav.js`) is role-aware as of v3.2 — non-owners see a
shorter "Light EdenAtlas" link set with Career/Finance/Reports/Time Capsule/Constellation removed;
those pages aren't deleted, just no longer linked, and redirect a non-owner away on direct access.

## Structure notes

Every page repeats the same header/nav and Tailwind theme config — there's no shared layout include, so changes to the nav or color palette need to be applied to each `.html` file individually (the old top-nav header itself is now permanently hidden everywhere, superseded by the sidebar/mobile nav below, but its markup was left in place rather than deleted). The six sanctioned exceptions are `js/splash.js` (the branded loading screen, loaded first), `js/i18n.js` (translations, loaded next), `auth-guard.js` (the login gate), `global-search.js` (the command palette), `js/mobile-nav.js` (mobile chrome), and `js/sidebar.js` (desktop chrome) — all self-contained modules that inject their own DOM. See [CLAUDE.md](CLAUDE.md), [design-system.md](design-system.md), and [brand-book.md](brand-book.md) for details if editing with Claude Code.
