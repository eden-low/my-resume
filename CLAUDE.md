# CLAUDE.md

Guidance for Claude Code when working in this repo. See [README.md](README.md) for the project overview.

## What this is

A static, 20-page HTML personal system — rebranded **EdenAtlas** in v2.5 ("a personal digital atlas for memories, growth, career, and life"), originally built for Low Fang Jun ("Jun," who remains the site's one Owner and sole personal identity — see the Career CMS bullet below) — now a genuine **multi-tenant** app: the owner and any number of approved "friends" each get their own private expenses/journal/photos/timeline/habits space, isolated by Firebase Auth `uid`. Styled as a dark glassmorphism "system dashboard" (near-black canvas, translucent blurred cards, one soft violet accent, Apple system fonts). No build tools, no JS framework, no package.json — just plain HTML/CSS files opened directly in a browser or served statically. The whole site is **login-first**: every page requires Google sign-in via `login.html` before it renders (see Architecture below) — there is no public, unauthenticated page. Firebase (Auth/Firestore, and Storage for gallery/journal) is loaded via ES module imports straight from `gstatic.com`, and the homepage additionally calls the OpenWeatherMap REST API and the browser Geolocation API — still buildless: no npm, no bundler. The site is installable as a PWA (`manifest.json` + `service-worker.js`, real `images/icon-192.png`/`icon-512.png` app icons).

**Design history**: the site went through two earlier looks — first a neon-purple "Solo Leveling hunter status" theme, then a copy-only cleanup that reworded RPG terms into professional ones (`resume.html`'s section `id`s still carry the old short names). A later pass replaced the *visual* language too: neon glow → glass blur, hot magenta → soft violet, Orbitron/Fira Code webfonts → system UI/monospace, grid-paper background → soft ambient radial glow. The site was then converted from a public portfolio into a login-first personal system (auth gate, `login.html`, `settings.html`, login-history logging, light-mode toggle, PWA scaffolding). "Personal OS v1.2" layered on real PWA icons, Export & Backup, a Habit Tracker, gallery social features (likes/comments/view analytics), and a Notification Center — at that point still single-owner-writes-everything, with viewers granted read access to the owner's private content via an `allowedUsers` whitelist.

**"Personal OS v2.0/v2.1"** rebuilt the write model from the ground up: every content collection is now `uid`-scoped and multi-tenant rather than owner-only, a role system (Owner / Friend / Viewer) replaced the old binary allowed/not-allowed model, `allowedUsers` was renamed to `friends`, and two new pages (`calendar.html`, `reports.html`) were added.

**"Personal OS v3.0"** added [ai.html](ai.html) / [ai-agent.js](ai-agent.js) — a chat interface backed by Google's Gemini API (`@google/genai`, loaded via jsDelivr's `+esm` ESM CDN build) with native function calling: the model can call an `addExpense` tool that writes straight into the same `expenses` collection every other page uses. See the Architecture bullets below for specifics — this section intentionally doesn't re-describe every prior version's details once superseded.

**"Personal OS v3.1"** reworked Dashboard's **Search People**: clicking a result used to expand an inline stats-and-recent-activity card on `dashboard.html` itself, which read as "you just jumped into someone else's home/gallery" — it now navigates to a dedicated read-only page, [profile.html](profile.html) / [profile.js](profile.js) (`?uid=...`), an IG-style profile with a public photo grid you can like/comment on but never edit. This also added the piece Search People was missing to be usable at all: an optional, unique **@username** (set in Settings → Profile) so people can be found by handle instead of relying on email or a possibly-duplicate display name, backed by a new `usernames/{username}` reservation collection. Alongside it, `users/{uid}` gained a public `role` field (owner/friend/viewer, refreshed on every login) so Search People and `profile.html` can enforce the asymmetric visibility the owner wanted: a Viewer's search only ever surfaces the Owner, while a Friend's (or the Owner's) also surfaces every Friend. Expenses stayed exactly as they were — always private, no visibility field — that part of the architecture was deliberately left alone.

**"Personal OS v4.0"** (most recent) is a product-feel pass — "a collection of tools" → "a digital life platform" — with **no new nav pages**. [index.html](index.html) went from a dashboard layout to a daily-habit landing page: greeting/live-clock/weather, a **Today** strip (habits/spending/journal/photos/notifications), an **On This Day** Memories flashback (own past photos/journal/timeline entries matching today's month+day in a prior year), **Recent Memories**, a **This Month** recap, and **Quick Actions** that write straight into `expenses`/`journals`/`photos` via inline modals (not new pages, not the full per-page forms). [profile.html](profile.html)/[profile.js](profile.js) gained GitHub+Instagram-style depth: **bio**/**location**/**joined date** on the header, a **habit completion %** stat, public photo **Albums**, public **Achievement** badges, a public **Timeline**/**Journal** list, and a **Recent Activity** feed — still public-content-only, still no edit affordance anywhere. A new shared module, [global-search.js](global-search.js), adds a site-wide `Ctrl/Cmd-K` **Search Everything** command palette (People/Gallery/Journal/Timeline/Habits/Expenses, grouped results, each linking to the relevant existing page) — the second sanctioned exception to "no shared files besides `scripts.js`," following `auth-guard.js`'s precedent of self-injecting its own DOM (trigger button + modal) rather than requiring per-page markup. Gallery's `category` field was relabeled into **Albums** (`travel`/`projects`/`events`/`dailylife`, displayed as Travel/Projects/Events/Daily Life), with a new independent `featured` boolean making **Favorites** a 5th, cross-cutting album rather than a 5th mutually-exclusive category — existing photos' old category values (`personal`/`event`/`work`/`project`) are aliased into the new taxonomy client-side via `LEGACY_CATEGORY_ALIAS`, never migrated in Firestore. Dashboard gained **Goals** (title/target/current/unit/deadline, a new `goals/{goalId}` collection, always private and shaped exactly like `expenses`) and **Achievements** (tiered badges for Photos Uploaded/Journal Entries/Expenses Recorded/Longest Active Habit Streak, 100% computed from live counts — no hardcoded personal-history milestones, since nothing in the app tracks structured life-event dates to derive them from); Profile shows only the achievement badges derivable from public data (the expenses-based badge never appears on anyone else's profile, since expenses are always private). `users/{uid}` gained `bio`/`location` (editable from Settings, same merge pattern as `username`) and a `createdAt` set only on first login (so "joined" date is stable). Finally, a sitewide copy/icon pass removed the remaining RPG/cyberpunk residue: the "DEVELOPER MODE: ACTIVE" pill is gone, `fa-shield-halved` → `fa-circle-user`, "SYSTEM PROFILE" → "PERSONAL OS".

**"EdenAtlas v2.5 Professional Edition"** — bilingual i18n, an HR-friendly Career
CMS, mobile-first navigation, a documented design system, and a full rebrand, with **no new nav
pages and no file renames** (only user-facing labels changed, to avoid a risky site-wide route
rename). Four things, in order of how deep they cut:
1. **i18n** — [js/i18n.js](js/i18n.js) is a **third** sanctioned shared module (after
   `auth-guard.js`/`global-search.js`), loaded first on every page. [locales/en.json](locales/en.json)/[locales/zh-CN.json](locales/zh-CN.json)
   hold `data-i18n`-keyed UI strings; `users/{uid}` gained an optional public `lang` field
   (same merge-write pattern as `bio`/`username`), reconciled against `localStorage["eden:lang"]`
   once auth resolves. Career's bilingual **content** fields (`title_en`/`title_zh`, etc.) are a
   separate mechanism — `career.js` re-renders on an `eden:langchange` event `i18n.js` dispatches,
   rather than going through `data-i18n`.
2. **Career CMS** — `resume.html` (nav-labeled "Career") gained four new Firestore collections
   (`career_experiences`, `career_projects`, `career_certificates`, `career_awards`), each
   `{uid, visibility, createdAt, updatedAt, ...bilingual fields}`. Unlike every other collection,
   Career is **Owner-only to write** (`isOwner()`, not `canParticipate()`) — the page has always
   been about one person, not a per-uid space — so Friends/Viewers/HR only ever read public
   items. `career.js` reuses the mine+public merge pattern (the "mine" half only ever returns
   anything for the Owner). Profile/Highlights(renamed from Matrix)/Education/Leadership stayed
   static prose (out of CMS scope); Work Experience → **Experience**, the old achievement cards
   → **Certificates**/**Awards**, and **Projects** is wholly new (Featured strip, category
   filter, detail modal, a Reflection field). [migrate-career.html](migrate-career.html) is a
   one-time, manually-run, unlinked/unguarded page that ports the old static content into the
   new collections — delete it after running once.
3. **Mobile navigation** — [js/mobile-nav.js](js/mobile-nav.js), a **fourth** shared module.
   Every page's `<header>` gained `hidden md:block`; below `md`, this module injects a fixed top
   bar, a slide-in drawer, a fixed bottom nav, and a Quick Add bottom sheet that deep-links to
   `{page}.html?new=1` — `expenses.js`/`journal.js`/`gallery.js`/`timeline.js`/`habits.js` each
   got a small `maybeAutoOpenFromQuickAdd()` addition that auto-opens their existing "New X"
   modal when that param is present and `canParticipate()` is true (never a duplicated form).
4. **Brand & nav cleanup** — "LOW FANG JUN / PERSONAL OS" → "EdenAtlas" (title tags,
   `manifest.json`, footer `EdenAtlas · by Jun · Version 2.5`) and nav *labels* only (file names
   untouched): Gallery→Memories, Timeline→Journey, Expenses→Finance, Notifications→Inbox,
   Resume→Career, Dashboard→People. See [design-system.md](design-system.md) for the full visual
   language, including the "don't reintroduce this vocabulary" list.

**"EdenAtlas v2.6" (most recent)** is a Product Design Phase — no new features, no database
changes, no broken auth — aimed purely at making the product feel calmer and more premium:
1. **AI removed entirely.** [ai.html](ai.html)/`ai-agent.js` are deleted; the nav-link line was
   stripped from every remaining page via the usual scripted sitewide pass; `service-worker.js`'s
   `PRECACHE`/`BYPASS_HOSTS` and the AI-related README/CLAUDE.md sections were cleaned up too
   (the v3.0/v3.1 history paragraphs above are left as an accurate historical record, per this
   file's own convention — only *current-state* descriptions were removed).
2. **Desktop sidebar** — [js/sidebar.js](js/sidebar.js), a **fifth** sanctioned shared module.
   The old horizontal top-nav `<header>` is now `class="hidden"` on every breakpoint everywhere
   (sitewide scripted pass, markup left in place rather than deleted — same low-risk "hide, don't
   restructure" approach used for the header in v2.5). In its place, `sidebar.js` injects a fixed
   left `<aside>` (desktop-only, `hidden md:flex`) with the primary nav list, a smaller secondary
   group (Habits/Contact — pages the brief's sidebar list didn't mention but which still need a
   way to be reached, mirroring how `mobile-nav.js`'s drawer already omits them from its primary
   set), and a bottom-pinned Profile/Logout/Collapse block. Collapse state
   (`localStorage["eden:sidebarCollapsed"]`) toggles a `--sidebar-w` CSS custom property that
   `body`'s `padding-left` reads (`styles.css`), so every page reflows without a per-page layout
   change — the same trick `mobile-nav.js` already used for its own top/bottom padding.
3. **Home recomposed, not just reordered** — `index.html`'s five separate "Today" mini-cards
   collapsed into one **Today's Overview** card with internal rows; a new **Continue Working**
   section lists today's not-yet-checked-off habits (derived from data already fetched, no new
   collection); **Quick Actions** went from three cards to one row of pills. The existing "On
   This Day" Memories flashback and Recent Memories sections were kept (the brief's requested
   order didn't mention them, but nothing asked for their removal either).
4. **Career de-portfolio'd** — the `#matrix` Highlights section (leadership radar/donut charts)
   is deleted outright, including its Chart.js `<canvas>`/init script and the `chart.js` CDN
   `<script>` tag (no longer used anywhere on the page). Education is folded into a slimmed
   Profile header (photo/bio/contact/degree, no progress bars or percentages); Leadership &
   Events survives as a compact icon+title+date list, not per-item paragraphs. `career.js`'s
   `projectCard()` gained a cover image (first `project.images` entry, or a placeholder icon) and
   an explicit "View Details" affordance; the detail modal was reorganized into labeled
   Overview/Gallery/Documents/Reflection/Links sections (each hidden if empty). A **Download CV**
   button calls `window.print()`, paired with an `@media print` rule in `styles.css` that hides
   all chrome and prints the page's own content — no new file, no stored PDF asset.
5. **Icons: Lucide added, not swapped in.** Every page's `<head>` now also loads Lucide's CDN
   script alongside Font Awesome. Rather than risk an unverifiable full swap of ~327 existing
   Font Awesome references (several generated dynamically, each needing its own
   `lucide.createIcons()` re-render call), Lucide is used only on this pass's redesigned surfaces
   (sidebar, Home, Career, Profile) — see `design-system.md`'s icon-rules section for the exact
   "static vs. dynamically-rendered" re-render caveat.
6. **Empty states rewritten** with warmer copy in both locale files (Journal/Memories/Career/
   Habits per the brief, extended to Finance/Journey/Inbox for consistency) — the static HTML
   fallback text was updated to match, not just the `data-i18n` translation.
7. **Restrained animation**: a body-level fade-in tied to the existing `auth-check-pending`
   class removal (no HTML changes — `auth-guard.js` already toggles that class); an opt-in
   `.card-lift` class (not baked into `.neon-border-purple` itself, which is also used on
   non-card surfaces like the sticky sub-nav and modal panels, where a hover lift would look like
   a glitch); a generic `.fixed.inset-0.z-50 > .relative` fade+pop entrance that covers every
   modal in the app with zero per-modal HTML changes; and a `.skeleton` shimmer utility applied
   to Profile's header and Career's Experience list while their initial fetch is in flight.

**"EdenAtlas v2.7" (most recent)** is "Collections & Atlas" — the first pass that connects
existing record types instead of adding a new type of record. No new nav pages besides Atlas and
the Me merge; Collections deliberately has no sidebar/drawer entry of its own.
1. **Collections** — a new `collections/{id}` Firestore collection (`{uid, title_en/zh,
   description_en/zh, coverImageUrl, icon, color, notes, visibility, createdAt, updatedAt}`,
   same `isMineOrPublic` rule shape as `journals`/`life_events`/`habits`) plus an optional
   `collectionId` field on `photos`/`journals`/`life_events`/`expenses`/`career_projects` —
   containers/filters, never a data migration: old docs simply read as `collectionId: null`.
   [collections.html](collections.html)/[collections.js](collections.js) lists mine+public
   collections plus a synthetic "Uncategorized" card (per-type item counts computed by fetching
   each type's mine+public/mine-only arrays once and filtering client-side, never a
   `where("collectionId","==",id)` query alone — this codebase's index/rules-avoidance
   convention, see the query-pattern bullet below); delete is **blocked** (not just confirmed)
   while any item still references it. Cover images are a plain URL string, either typed or
   copied from one of the user's own Memories — never a Storage upload, so `storage.rules`
   needed no changes at all. [collection-detail.html](collection-detail.html)/
   [collection-detail.js](collection-detail.js) (`?id=` or the virtual `?id=uncategorized`)
   renders one section per record type (Finance only for the collection's own owner, regardless
   of the collection's visibility) plus an owner-editable Reflection/Notes field, with warm
   per-section empty-state copy.
2. **Edit-metadata** — gallery/journal/expenses/timeline/career.js each gained an edit modal
   following `career.js`'s pre-existing `open*Form(id)` + id-branching-submit +
   `wireOwnerControls` pattern (the only prior art for this in the codebase), gated by
   `item.uid === auth.currentUser.uid` instead of `isOwner()` since these are participant-owned
   records, not the Owner-only Career CMS. Every edit sets `updatedAt: serverTimestamp()`,
   never touches the original `createdAt`/`uploadedAt`. Gallery also gained **bulk move**: a
   "Select" mode toggling a checkbox overlay on the signed-in user's own post cards, plus a
   floating action bar that reassigns every selected post's `collectionId` in one `Promise.all`.
3. **Atlas** — [atlas.html](atlas.html)/[atlas.js](atlas.js), a Leaflet.js map (CARTO
   dark/light-tiles CDN, no paid API, no marker-icon asset — pins are `L.divIcon` colored dots
   to sidestep Leaflet's default-icon path issue on a CDN-only setup) of every
   `locationName`/`latitude`/`longitude` a Memory/Journal entry/Journey event carries (Finance
   and Career intentionally never get a location UI). Two segmented tabs: **My Atlas** (default,
   own data only, any visibility, exact coordinates — same personal-only shape as
   Calendar/Reports) and **Connections** (lazy-fetched only the first time that tab opens;
   public-only records from the owner + approved friends via the same role gate as Search
   People/`profile.js`; capped to the 100 most recent; coordinates rounded to ~2 decimals; never
   queries `expenses`, ever, by construction). Clicking a pin/list item opens a detail panel
   (location name, per-type counts, linked Collections, a few recent photos). A "Collections"
   tab at the top of Atlas is a plain link to `collections.html` — the only nav entry point into
   Collections anywhere in the app. The Memories/Journal/Journey create-and-edit forms gained a
   location input (`locationName` text + optional lat/lng + a "Use current location" button that
   copies `index.html`'s existing promise-wrapped Geolocation pattern verbatim).
4. **Me** — [me.html](me.html)/[me.js](me.js) merges Profile-viewing-yourself + Settings +
   Dashboard's personal-analytics half into one tabbed page (Overview/Profile/Preferences/
   Privacy/Connections/Backup/System Logs), reusing every underlying function unchanged (just
   relocated) rather than reimplementing any of it. `dashboard.html`/`dashboard.js` (nav-labeled
   **Connections**, was People) is trimmed to just Search People. `settings.html` is now a
   one-line `<meta http-equiv="refresh" content="0;url=me.html">` redirect, kept only so old
   bookmarks/links don't 404. Privacy is deliberately minimal (an explainer + a read-only echo of
   the existing default-visibility preference) rather than inventing new profile-visibility
   toggles nothing else in the app would read.
5. **Nav** — `sidebar.js`'s `PRIMARY_LINKS` becomes Home/Career/Memories/**Atlas**/Journal/
   Finance/Calendar/**Connections**(relabel)/Reports/Inbox; Journey moves into `SECONDARY_LINKS`
   (Atlas is now the larger location/chapter module); the bottom "Profile→Settings" row becomes
   "**Me**→me.html". `mobile-nav.js` mirrors this (`DRAWER_LINKS` gains Atlas, its `settings.html`
   entries become `me.html`) and gets one new Quick Add item, "New Collection" →
   `collections.html?new=1`. i18n keys: `nav.atlas`/`nav.me`/`nav.collections`, new `atlas.*`/
   `collections.*`/`me.*` namespaces, `common.tags`/`location`/`collection`/`uncategorized`/
   `edit_metadata`/`move_to_collection`/`use_current_location`, and `nav.people`/
   `mobilenav.people`'s English *value* changed to "Connections" (Chinese "人脉" already read that
   way, so it was left as-is) — labels only, no key renames, no file renames.

**"EdenAtlas v2.8" — "Polish · Identity · Experience"** is a UX-only pass: no new
pages, no Firestore/Storage schema changes, no rules changes. Four surfaces were touched:
1. **Login** — `login.html` was rebuilt around one centered card (EA mark, "EdenAtlas," a
   tagline, a rounded-full "Continue with Google" button, a small privacy line) over a new
   `.login-bg`/`.login-dot-grid`/`.login-orbit-ring` texture (`styles.css`) — a dark gradient
   plus an almost-invisible dot grid and a few hairline concentric rings, deliberately far short
   of the old build's neon-glow register. A stacked footer (`EdenAtlas` / `Built by Jun` /
   `Version 2.8`) replaced the single-line footer, on this page only — see the Brand &
   navigation bullet below for why the version bump didn't go sitewide. Post-sign-in, both the
   session-restore and fresh-sign-in paths now call a `transitionToApp()` helper that fades the
   card out, fades a small pulsing EA mark in, and only then navigates — replacing an instant
   `location.href` jump. New i18n keys: `login.tagline`/`login.continue_google`/`login.privacy`.
2. **Connections redesign** — `dashboard.html`/`dashboard.js` (nav-labeled "Connections") grew
   from a bare live-search box into an Apple Contacts-style page: a **Search** box that swaps the
   page into a "Search Results" view while non-empty; a default **Recommended Connections**
   strip (the four most-recently-joined people the viewer's role can see, by `users/{uid}.
   createdAt`); **Your Connections** (everyone else that role can see, alphabetical); and a
   static **Connection Requests** placeholder card with no backing data — there is no
   follow/request graph in Firestore, and the brief explicitly called this a future placeholder.
   All three lists share one `personCard()` renderer (avatar/name/@username/bio/location, plus a
   lazily-fetched, cached **public Collections count** — `where("uid","==",p.uid),
   where("visibility","==","public")` against `collections`, the same equality-only query shape
   used everywhere else in this app) ending in an explicit "Open Profile" affordance rather than
   an inline expansion. Skeleton placeholders (`.skeleton`) show in both list containers until
   the `users` directory fetch resolves. New i18n keys under `people.*`
   (`search_results`/`no_search_results`/`recommended`/`recommended_subtitle`/
   `no_recommendations`/`your_connections`/`no_connections`/`requests`/`requests_placeholder`/
   `open_profile`/`subtitle`).
3. **Profile gained Career + Public Atlas** — `profile.js` now also fetches public
   `career_experiences`/`career_projects` for the viewed `uid` (same `fetchPublicFor()` shape as
   every other section; in practice usually only non-empty on the Owner's own profile, since
   Career stays Owner-only to write) and renders a compact, date-sorted **Career** section
   (`#career-section`, hidden if empty). **Public Atlas** (`#atlas-section`) is a tag list of
   distinct `locationName` values pulled from the profile's already-fetched public
   photos/journals/life_events, each with an occurrence count, plus a "View on Atlas" link to
   `atlas.html` — a deliberate choice *not* to re-embed Leaflet on every profile view (Atlas
   itself remains the one page that owns the map). `profile-content`'s section order was
   reshuffled to roughly follow the brief's Profile → Career → Public Memories → Public Atlas →
   Journey → Achievements sequence (Recent Activity and Public Journal, not named in the brief,
   were kept and placed after).
4. **Language consolidated, not changed** — auditing every page confirmed the language switcher
   already lived in exactly the two places the brief allows on mobile/Me (Me → Preferences'
   `.lang-choice-btn` row, the mobile drawer's `.drawer-lang-btn` footer row) and nowhere else;
   the one gap was the desktop sidebar, which had no language control at all. `js/sidebar.js`
   gained an `.eden-sidebar-lang-row` (EN/中文 pills) in its bottom-pinned footer block, wired to
   the same `getLang()`/`setLang()`/`eden:langchange` triad every other switcher uses — still one
   global language state, now genuinely three (not more) surfaces. The row is hidden via CSS
   when the sidebar is collapsed, matching how `.eden-sidebar-label` text already disappears in
   that state.
5. **Loading & empty states** — a new sitewide `html::before` rule in `styles.css` paints a
   small pulsing EA mark behind every page, invisible in normal use (the opaque `body` covers it)
   but visible through `body.auth-check-pending`'s `opacity:0` during the brief window before
   `auth-guard.js` resolves — since CSS opacity collapses an element's entire subtree as one
   composited group, a *descendant* of body could never un-hide itself this way, so the mark had
   to be painted on `html` instead, behind body rather than inside it. Warmer empty-state copy
   landed in `locales/*.json` (+ each page's static HTML fallback) for Connections
   (`people.no_connections`), Career Projects (`career.no_projects`), Collections
   (`collections.no_collections`), and Atlas (`atlas.no_locations`), per the brief's exact
   wording. `atlas.js`'s one remaining raw `"Loading..."` string was normalized to the
   `"Loading…"` convention used everywhere else.
6. **Brand & navigation**: no nav changes (Connections already existed, no new page was added).
   Every page footer was bumped from `Version 2.5` to `Version 2.8` (a straight string swap —
   `login.html`'s footer had already been rebuilt with the new stacked layout earlier in this
   same pass, so this just brought the other 19 pages' single-line footers up to the same
   version number; the `footer.line` locale key, though currently unused by any page's markup,
   was updated to match). No `brand-book.md` exists in this repo — `design-system.md` remained
   the single source of truth for tokens/spacing/motion throughout this pass.

**"EdenAtlas v2.9" — "Living Memories"** finishes sitewide i18n and adds two
always-private emotional-checkpoint features. No AI, no Firebase architecture changes, no schema
changes to any pre-existing collection.
1. **Full i18n completion.** The gap this pass closed: `js/i18n.js`'s `applyTranslations()` was
   only ever called from `init()`/`setLanguage()` (global, whole-`document` passes) — no
   page-level script called it or `t()` at all, so anything rendered by JS after page load
   (list items, modals, status text, empty states, Chart.js labels, category/mood label maps)
   was permanently English regardless of the selected language. Fixed by generalizing the one
   existing precedent, `career.js`'s `bi()` helper + `eden:langchange` listener (previously
   scoped only to Career's bilingual Firestore *content* fields), into a sitewide pattern: every
   page-level script now does `import { t } from "./js/i18n.js"`, wraps UI-chrome strings in
   `t("namespace.key")` *at render time*, and adds a `document.addEventListener("eden:langchange",
   ...)` that re-runs its existing render function(s) against already-cached data — no refetch.
   `collections.js`/`collection-detail.js` already had their own `bi()`/`curLang()` for bilingual
   `title_en`/`title_zh` content but were missing the `eden:langchange` listener (titles never
   updated on a live language switch) and read the pre-fix legacy `localStorage["eden:lang"]`
   key instead of `getLang()` — both fixed. `js/i18n.js` itself gained `t(key, vars)`
   `{placeholder}` interpolation (e.g. `t("time_capsule.locked_notice", { date })`), a fallback
   chain (current language → English dict → raw key), and a `console.warn` on missing keys,
   gated to `localhost`/`127.0.0.1` only. User-generated content (a person's own journal text,
   photo captions, expense notes, etc.) is never passed through `t()` — only UI chrome, category/
   mood label config objects, and static markup already covered by `data-i18n`.
2. **Time Capsule** — [time-capsule.html](time-capsule.html)/[time-capsule.js](time-capsule.js),
   a new page (closest template: `habits.html`/`habits.js`, the simplest single-collection CRUD
   page) backed by a new `time_capsules/{id}` collection: `{uid, title, message, openAt,
   createdAt, updatedAt, status: "sealed"|"opened", visibility: "private", attachmentUrl,
   attachmentType}`. Always private — same owner-uid-only rules shape as `goals`/`expenses`, never
   `isMineOrPublic()`. Three sections (Sealed / Ready to Open / Opened) are a client-side split of
   one `where("uid","==",myUid)` query (this repo's index-avoidance convention): `status===
   "opened"` → Opened; `status==="sealed" && openAt<=now` → Ready to Open; otherwise → Sealed.
   Opening does `updateDoc(..., { status: "opened", updatedAt: serverTimestamp() })`. Optional
   attachment uploads to a new Storage path `capsules/{uid}/...` (always-private, no `/public`
   split — mirrors `career/{uid}/private`'s shape but scoped to the uploader instead of
   Owner-only). Home shows a calm ready-notice card (`#capsule-ready-section`, same hidden-by-
   default pattern as `#memories-section`) once any capsule is due; a best-effort
   `checkCapsuleReadyNotifications()` (copied from `habits.js`'s streak-notification shape,
   deduped via `localStorage`) writes a `notifications` doc (`capsule_ready`, added to
   `notifications.js`'s `TYPE_META`). Nav: a secondary item in `js/sidebar.js`/
   `js/mobile-nav.js` (not primary — the brief explicitly said not to crowd the main sidebar),
   a `mobilenav.new_capsule` Quick Add entry deep-linking `time-capsule.html?new=1` (auto-opens
   the create modal, same `maybeAutoOpenFromQuickAdd()` convention as every other Quick Add
   target), a Home Quick Actions pill, and a compact sealed/ready-count summary card in Me →
   Overview (not a duplicate CRUD UI — just a link out to the real page).
3. **Daily Reflection** — no new page; lives entirely as a card on `index.html` next to Today's
   Overview. New `daily_reflections/{id}` collection, doc ID = `${uid}_${dateKey}` (the app's
   established "deterministic ID for structural uniqueness" trick, same idea as
   `usernames/{username}`) so a same-day re-save is a `setDoc(..., {merge:true})` overwrite, never
   a duplicate, with no query needed to check "does today's entry already exist." Six moods
   (happy/neutral/tired/sad/excited/grateful), one text input, always private — same owner-uid-
   only rules shape as Time Capsule. Reports gained a small summary block (mood count this month,
   most common mood, reflection days) from one `fetchMine("daily_reflections")` call.
4. **Monthly Story & Year in Review** — two new `reports.html` sections, rendered by new
   functions in `insights.js`. Month/year picker copies `calendar.js`'s `viewDate` +
   prev/next-button pattern. Template-based prose only (no AI, no external API) — a fixed
   sentence skeleton per language with an opening qualifier chosen from a small deterministic
   pool based on total activity volume, and clauses that only appear when their stat is > 0 (so
   the paragraph never reads "0 capsules opened this month"). Data sources: `photos`, `journals`,
   `expenses`, `habits`, `collections`, `career_projects` (Owner-only-populated, same as
   elsewhere), `time_capsules`, `daily_reflections` — every query is `where("uid","==",myUid)`
   only, the same personal-only shape as the rest of Reports/Calendar/Me-Overview, so neither
   section can structurally expose another user's data to a Viewer or Friend. Export as Markdown
   reuses `export.js`'s `downloadFile()` shape, duplicated locally in `insights.js` rather than
   imported — importing `export.js` directly was tried first and reverted, since `export.js`'s
   top-level code unconditionally wires click listeners onto Backup-tab buttons (`#export-
   expenses-btn` etc.) that don't exist on `reports.html`, throwing on load; per this repo's
   per-page-duplication convention, the small `downloadFile()` utility now lives in both files
   independently instead of being a shared import with side effects.
5. **Brand & navigation**: every page footer bumped from `Version 2.8` to `Version 2.9`
   (including `login.html`'s stacked-footer variant). No nav *label* changes — Time Capsule is
   the only new nav entry, added as a secondary item per the brief.

**"EdenAtlas v3.0" (most recent) — "Identity & Motion"** is a brand/experience pass — no AI, no
backend, no Firebase architecture or schema changes, no rules changes, no new nav pages. Four
things:
1. **Splash screen** — [js/splash.js](js/splash.js), a sixth sanctioned shared module (after
   `i18n.js`/`auth-guard.js`/`global-search.js`/`mobile-nav.js`/`sidebar.js`), loaded before
   `js/i18n.js` on every protected page (and on `login.html`). While `body.auth-check-pending`
   is present it shows a full-viewport overlay (mark + "EdenAtlas" wordmark + a
   `data-i18n="splash.message"` tagline) appended to `<html>` directly — a sibling of `<body>`,
   not a descendant, for the same reason `styles.css`'s pre-existing `html::before` pulse mark
   (which still fires from the very first paint, zero JS, as an instant fallback) is painted
   there rather than inside body. A `MutationObserver` (not a fixed timer) fades it out the
   moment `auth-check-pending` is removed, with a 6s hard fallback for paths that navigate away
   without ever clearing that class (`login.html`'s session-restore redirect); skips mounting
   entirely if auth already resolved by the time the script runs, so a fast session never gets
   artificially delayed. New i18n keys: `splash.message` ("Opening your atlas…" /
   "正在打开你的数字地图…").
2. **Branded loading states** — a new `common.loading_atlas` i18n key ("Loading your atlas…" /
   "正在整理你的数字地图…") for the rare inline case a skeleton doesn't fit; everywhere else,
   `.skeleton` placeholder blocks (Career's Experience list already had these) were added
   directly into a container's *static* HTML on Memories' feed, Collections' grid, and Time
   Capsule's three sections — shaped roughly like the real content, on screen immediately, wiped
   for free the moment that page's existing `replaceChildren(...)` render call runs. No fetch/
   render logic touched on any page.
3. **Brand motion** — one new `styles.css` rule gives every element already using the sitewide
   `hover:scale-105` button convention a matching `:active { transform: scale(0.97) }` press-
   down (an attribute-substring selector reading the Tailwind utility name out of the class
   attribute, the same trick `html[data-theme="light"]`'s overrides use), so new buttons get
   press feedback for free without a markup change. Everything else the brief asked for
   (page fade-in, card lift, sidebar hover, modal pop, reduced-motion handling) already existed
   from v2.6/v2.8 and needed no change.
4. **Identity docs** — [brand-book.md](brand-book.md) is new: a short, high-level identity doc
   (tagline, voice, logo do's/don'ts, first-impression principles) separate from
   `design-system.md`'s component-level detail, superseding the earlier "no brand-book.md exists"
   note from v2.8. `design-system.md` gained Logo system / Splash screen / Loading states
   sections and a button-press-feedback bullet. The logo itself needed no file changes — audited
   every reference (`login.html`, `js/splash.js`, `js/sidebar.js`, `js/mobile-nav.js`) and all of
   them already pointed at the one canonical `images/logo-mark.png`, just at different sizes per
   context (now tabulated in `design-system.md`); per the brief, PNG was kept as-is rather than
   converted to SVG.
5. **Favicon** — every page gained `<link rel="icon" type="image/png" sizes="192x192"
   href="images/icon-192.png">` next to its existing `apple-touch-icon` tag; there was
   previously no favicon link at all sitewide (browsers fell back to a generic/broken tab icon).
   `manifest.json` and `theme-color` were already correct and needed no change.
6. **Brand & navigation**: every page footer bumped from `Version 2.9` (or `2.9.1` on
   `time-capsule.html`, `2.8` on the handful of pages an earlier pass's footer-i18n sweep had
   missed) to `Version 3.0` — the missing `data-i18n="footer.line"` attribute was added to those
   pages at the same time, closing a real i18n gap (their footer previously never translated).
   Login's tagline changed from "Your digital home." to "Your life, beautifully organized." /
   "把生活、回忆与成长，安静地整理在一起。", matching `design-system.md`'s pre-existing "Homepage line."
   Memory Constellation (the brief's optional Task 9) was deliberately skipped given the size of
   the rest of this pass — recommended as a v3.1 candidate rather than risking this one.

**"EdenAtlas v3.2" (most recent) — "Trusted Connections"** turns Connections from a
role-based directory/placeholder into a real, mutual-consent friend graph, and adds a third
`connections` visibility tier alongside private/public. No AI, no backend/Cloud Functions, no
npm — the accept flow is deliberately transaction-free (see below).
1. **Friend graph** — two new top-level collections, `friend_requests/{toUid}/incoming/{fromUid}`
   (`{fromUid, toUid, status: pending|accepted|declined|cancelled, fromDisplayName, fromUsername,
   fromPhotoURL, createdAt, updatedAt}`) and `friendships/{uid}/friends/{friendUid}` — entirely
   separate from the pre-existing owner/friend/viewer `friends/{email}` whitelist role system,
   which is unchanged and still governs `canParticipate()`/CRUD gating. The accept flow needs no
   transaction or cross-uid write: the acceptor writes only their own `friend_requests` doc and
   their own `friendships` mirror; the *other* side's mirror is created lazily by that side's own
   client the next time it loads Connections (`dashboard.js`'s `loadSentRequestsAndHeal()`), and a
   removed friendship is similarly self-pruned by the removed side (`pruneStaleFriendships()`) —
   every write is scoped to the caller's own uid path segment, so `firestore.rules` never needs a
   cross-user write beyond one narrow exception (below). `firestore.rules` gained
   `isAcceptedFriend(ownerUid)` (named differently from the obvious `isFriend(ownerUid)` to avoid
   shadowing the pre-existing whitelist-role `isFriend()`) and `match` blocks for both
   collections enforcing: create-by-`fromUid` only, read-by-either-side, accept/decline only by
   `toUid`, cancel only by `fromUid`, and a friendship doc creatable only when a matching
   `friend_requests` doc is already `accepted` (checked in either direction) — structurally
   preventing anyone from self-adding a friendship. The `notifications` create rule gained one
   narrow cross-uid exception: a sender may write a `friend_request`/`friend_accepted` doc
   directly into the recipient's inbox (self-attested via `fromUid == request.auth.uid`), the only
   type of notification in the app that isn't self-written.
2. **`connections` visibility tier** — `isMineOrPublic()`/`isPhotoMineOrPublic()` gained an OR
   clause, `data.visibility == 'connections' && isAcceptedFriend(data.uid)`, turning this on for
   `journals`/`life_events`/`photos`/`collections` with no other rule changes. Reachable only via
   a two-equality query pinning both `uid` and `visibility` (the same shape as this app's
   pre-existing `fetchPublicFor()`/mine+public pattern) — a bare `visibility=='connections'` query
   with no `uid` filter is rejected by Firestore's query-rule provability check, since
   `isAcceptedFriend(data.uid)` can't be proven for an unconstrained `uid`. This is why
   connections-tier content is only ever fetched per-target-uid (Friend Profile View, one query)
   or per-friend-in-a-loop (Atlas's Connections tab), never as one broad query across all users.
   A third radio option (`value="connections"`, alongside the existing public/private pair) was
   added to every create/edit visibility picker on Memories/Journal/Journey/Collections (+
   `index.html`'s Quick Add journal/photo modals) — **Habits is deliberately excluded**, matching
   the brief's applicability list. `storage.rules` gained matching `gallery/{uid}/connections/`
   and `journal/{uid}/connections/` path rules (uploads already bake `visibility` into the storage
   path, so the third value just needed a third path match) — readable by the owner or anyone in
   their `friendships` subcollection. Finance/Time Capsule/Daily Reflection/Career/System Logs
   stay exactly as private/owner-only as before — never touched.
3. **Connections page redesign** (`dashboard.html`/`dashboard.js`, nav-labeled Connections) — four
   sections: Search People (unchanged discovery, still role-gated by `users/{uid}.role` the same
   way it always was — a Viewer only finds the Owner, a Friend/Owner find each other; that role
   gate is orthogonal to the new friend graph), Friend Requests (real incoming pending requests,
   Accept/Decline), My Friends (renamed from "Your Connections" — now sourced from real accepted
   friendships instead of the whole role-visible directory), and Sent Requests (pending requests
   I've sent — computed by looping the already-fetched `users` directory and doing one cached
   `getDoc` per candidate against their `friend_requests/{them}/incoming/{me}`, the same
   personal-app-scale lazy-per-card pattern `publicCollectionsCount()` already used — no new
   collection or collection-group query needed). The old static "Connection Requests" placeholder
   card is gone. Person cards never render email, matching the pre-existing
   `publicDisplayName()`/`formatHandle()` convention.
4. **Notifications reach every user, not just the owner** — `notifications.js`'s
   `fetchNotifications()` and `auth-guard.js`'s unread badge both used to gate on `isOwner(user)`,
   a pre-existing gap (not a v3.2 decision) that predates this pass: `firestore.rules` and
   `login.html`'s own comments already treated notifications as per-user, but the client never
   caught up. Both gates now simply require "signed in," since friend-request notifications must
   reach non-owner recipients. `TYPE_META` gained `friend_request`/`friend_accepted`, and
   `notifCard()` links those two types to `dashboard.html`.
5. **Friend Profile View** — `profile.js`'s `fetchPublicFor()` became `fetchVisibleFor()`, which
   also runs the connections-tier query (scoped to the target uid) when a new
   `isAcceptedFriendOfTarget()` check (one `getDoc` on the target's own `friendships` subcollection
   — readable by either side per the rule above) is true, merged with public by doc id. Applies to
   Memories/Journal/Journey; Habits stays public-only (unchanged); Career/Achievements/Recent
   Activity/Atlas-places sections are untouched code-wise and just inherit the richer merged
   arrays. **`profile.html` deliberately stays single-scroll**, not rebuilt into the brief's
   suggested 4-tab layout — a scope decision made with the user up front to avoid a much larger,
   riskier rewrite of a page that already works; only the data shown changed. Atlas's Connections
   tab (`atlas.js`) keeps its existing role-based public aggregation unchanged and layers on a
   second pass: one connections-tier query per uid in the viewer's real friendships set, merged
   into the same cluster set.
6. **Friend-mode navigation** — `js/sidebar.js` and `js/mobile-nav.js` now render a shorter,
   flattened link set (Home/Memories/Atlas/Journal/Calendar/Connections/Inbox/Habits) for any
   non-owner (Friend or Viewer alike), dropping Career/Finance/Reports/Time Capsule/Constellation
   from nav entirely — those pages aren't deleted, just no longer linked, and mobile's Quick Add
   sheet drops the Add Expense/New Capsule entries the same way. `auth-guard.js` gained a second
   responsibility as the direct-URL backstop: any page opting in via `<body data-owner-only="true">`
   (`expenses.html`, `reports.html`, `time-capsule.html`, `constellation.html` — **not**
   `resume.html`, which dropped this attribute in v3.2.2, see below)
   redirects a non-owner to `index.html?notice=private_space`, which shows a small dismissible
   "This space is private." notice and strips the query param via `history.replaceState`.
7. **i18n**: new keys under `people.*` (`add_friend`, `friend`, `friends`, `friend_requests`,
   `incoming_requests`, `sent_requests`, `remove_friend`, `pending`, `request_sent`,
   `request_accepted`, plus `my_friends` replacing `your_connections`) and `common.*` (`accept`,
   `decline`, `connections` — the third visibility label, "好友可见" in Chinese per the brief —
   and `this_space_is_private`). Friend-request/accepted notification title/message text is
   written in plain English at write time, matching the pre-existing `login.html` "New login
   detected" convention (notifications were never localized at write time anywhere in this app,
   not a new gap introduced here).
8. **Brand & navigation**: every page footer bumped to `Version 3.2`.

**"EdenAtlas v3.2.2" (most recent) — "Public Career Profile / Resume Access"** fixes a real bug
(`resume.html` carried `data-owner-only="true"`, so `auth-guard.js` bounced every Friend/Viewer
away from Career before they could see anything — public/connections-tier career items were
structurally unreachable by anyone but the Owner) and, on top of that fix, opens a genuine
unauthenticated HR path. No new nav pages, no chat/feed/comments/likes, no change to Trusted
Connections, no mobile-shell changes.
1. **Root-cause fix** — `resume.html`'s `<body>` dropped `data-owner-only="true"` for
   `data-public-optional="true"` (a new, opt-in `auth-guard.js` attribute: on sign-out, instead of
   redirecting to `login.html`, it just reveals the page — the page itself is responsible for only
   rendering what its own read rules allow an anonymous request to see). This alone restores
   Friend/Viewer access to Career, which had regressed to Owner-only-reachable despite the
   underlying `isMineOrPublic()` read rule always having supported public/connections items.
2. **Page-level `careerVisibility`** — `users/{uid}` gained an optional `careerVisibility`
   (`"private"|"connections"|"public"`, missing == `"private"`), editable only by the Owner from
   a new "Public Resume Link" card at the top of `resume.html` (`career.js`), merge-written to
   both `users/{uid}` and the new `public_profiles/{uid}` mirror (below). This is a **client-side,
   UI-level gate** — the same tier as `profile.html`'s pre-existing `canViewProfile()` — deciding
   whether `resume.html` bothers rendering anything for this viewer at all; it does not change
   what firestore.rules itself allows a direct query to return (see next point). The very first
   time the Owner loads their own resume with this field never set, it's auto-upgraded to
   `"public"` once (mirrors `login.html`'s "only write `createdAt` on first login" pattern) — the
   app historically treated Career as a public portfolio, so this restores that default without
   changing the rules-level default (which stays the safer `"private"`).
3. **Unauthenticated public reads** — `firestore.rules`' `career_experiences`/`career_projects`/
   `career_certificates`/`career_awards` read rule became `isCareerReadable(data)`:
   `data.visibility == 'public' || isMineOrPublic(data)` — a `visibility: "public"` item is now
   readable with **no** `request.auth` requirement at all, unlike every other collection's
   `isMineOrPublic()`, which always requires it. This is the actual security boundary; the
   page-level `careerVisibility` above is a courtesy, not a hard gate — a determined client could
   still query a specific public career item directly even when `careerVisibility` is `"private"`,
   an accepted tradeoff already documented for `profile.html`'s identical pattern. Each of the 4
   Career CMS forms gained a third **Trusted Connections** visibility radio (alongside the
   existing Public/Private), reusing `isMineOrPublic()`'s pre-existing (and previously unused by
   Career) connections-tier clause — no rules change needed for that part. `storage.rules` gained
   a matching `career/{uid}/connections/` path.
4. **`public_profiles/{uid}`** — a new, world-readable (`allow read: if true`) collection: a
   denormalized `{uid, displayName, username, photoURL, role, careerVisibility}` mirror of
   `users/{uid}` with **`email` deliberately excluded** (kept in `users/{uid}` only, which stays
   auth-required) — see the "Do not make users/{uid} fully public" guardrail this was built to
   satisfy. Written alongside every existing flow that already writes the source field on
   `users/{uid}` (`login.html`'s upsert, `me.js`'s Display Name/username save, `career.js`'s
   Resume Visibility control). Also used for the unauthenticated "no `?u=`/`?uid=` param" default
   — `resolveOwnerUidFallback()` queries `public_profiles` `where role == "owner"` — since
   `users` itself can't be queried without auth. `usernames/{username}` (already holding nothing
   but `{uid, createdAt}`) had its read rule opened from auth-required to `if true` for the same
   reason: an anonymous `resume.html?u=...` visitor needs to resolve a handle to a uid.
5. **`resume.html` routing + viewer mode** — supports `?u=username` (preferred) / `?uid=userUid`,
   resolved the same way `profile.html` resolves its own `?u=`/`?uid=` (username via
   `usernames/{username}`, falling back to the Owner via `public_profiles` when no param is
   given). `career.js`'s fetches are now scoped to the resolved target uid (previously: a single
   global "every public item across the whole collection, plus mine" merge — functionally
   equivalent in practice since Career has only ever had one writer, but not correct as a
   per-profile viewer). Edit affordances (Add/Edit/Delete buttons, the visibility card) now key
   off `canEdit` (`isOwner(user) && user.uid === targetUid`) instead of a bare `isOwner(user)`
   check, so viewing someone else's resume while signed in as the Owner never shows edit controls
   for content that isn't actually the Owner's own uid. `#career-subnav`/`#career-main` are hidden
   and `#career-access-notice` shown (private / connections-required / not-found, per
   `careerVisibility`) when this viewer isn't allowed to see the resume at all. The static
   Profile/Education/Leadership prose (out of Career CMS scope since v2.6) is unchanged and still
   describes the Owner specifically — it hides along with everything else under
   `#career-main` for a denied viewer, and is not (yet) re-derived per-target-uid, a known
   limitation given Career has no other multi-tenant writer today.
6. **`profile.html` "View Resume" CTA** — a new `#resume-cta` link, shown when: the viewer is
   looking at their own profile, the viewer is the app Owner, the target's `careerVisibility` is
   `"public"`, or it's `"connections"` and the viewer is an accepted friend of the target (reusing
   `profile.js`'s existing `isAcceptedFriendOfTarget()`) — links to `resume.html?u=<username>` or
   the `?uid=` fallback. Does not duplicate any Career UI; the existing inline `#career-section`
   preview list on `profile.html` is unchanged.
7. **Resume PDF upload** (brief's "Resume PDF if uploaded") was **not implemented** — scoped out
   to keep this pass to the actual reported bug (visibility/access) plus the explicitly-requested
   routing/unauth pieces; see the deliverable notes for the reasoning. `download-cv-btn`'s
   `window.print()` behavior (v2.6) is unchanged and still the only "export your resume" path.
8. **i18n**: new `career.*` keys (`public_resume_link`, `visibility_hint`,
   `visibility_connections_label`, `visibility_public_label`, `visibility_saved`,
   `resume_private_notice`, `resume_connections_notice`, `resume_not_found`) and `profile.*` keys
   (`view_resume`, `view_career_profile` — the CTA button uses `view_resume`). Reuses the
   pre-existing `common.private`/`common.public` for the Public/Private radio labels.
9. **Brand & navigation**: no nav changes (no new page — `resume.html`'s route is parameterized,
   not a new file). Footer version not bumped sitewide for this pass (a narrower, single-page-area
   fix rather than a full versioned release pass like v3.2's).

**"EdenAtlas v3.2.3" (most recent) — resume viewer-mode shell fix.** v3.2.2 fixed *access* to a
shared resume link but left the surrounding app shell untouched — a friend/connection/public HR
visitor opening `resume.html?u=username` still saw the full private-app desktop sidebar/mobile
nav (Finance, Inbox, Time Capsule, Me, etc.), and a non-owner viewer's sidebar was missing Career
entirely (it's an owner-heavy-module link, dropped from `js/sidebar.js`'s `LIGHT_LINKS`/
`js/mobile-nav.js`'s drawer for any non-owner regardless of what page they're actually on). Fixed
purely at the shell layer, no access-control change:
- `career.js` gained `applyViewerModeClass()`, toggling `resume-viewer-mode`/`resume-owner-mode`
  on `<body>`. Viewer mode is `!canEdit && (hasTargetParam || !auth.currentUser)` — deliberately
  *not* a bare `!canEdit`, so a non-owner who opens bare `resume.html` directly (no `?u=`/`?uid=`,
  e.g. a stale bookmark) keeps their normal role-based nav instead of losing all navigation with
  no way back. `canEdit` is now also reset to `false` at the top of `initCareerAccess()` (a
  latent staleness bug: it was previously only ever reassigned mid-function, so an early-return
  notice path after a prior call had granted edit access could theoretically leave a stale `true`
  across an auth change).
- `styles.css` gained a `body.resume-viewer-mode` block hiding `#eden-sidebar`/`#mobile-topbar`/
  `#mobile-bottomnav`/`#mobile-drawer`/`#mobile-drawer-backdrop`/`#quickadd-sheet-overlay` (the
  same selector list already used by the existing `@media print` rule, just gated by class
  instead of print context) and zeroing the sidebar/mobile-nav body padding — no `sidebar.js`/
  `mobile-nav.js` changes, so mobile shell behavior elsewhere in the app is untouched. This is
  Option 1 from the fix brief (hide the shell entirely) rather than a minimal public sidebar,
  since resume.html's own sticky `#career-subnav` already gives in-page navigation and a
  `download-cv-btn`/Profile link already exists for wayfinding.
- No `Public Resume Link` card, edit/upload controls, or Firestore/Storage rules changes were
  needed — those were already correctly gated by `canEdit` from v3.2.2, only the sidebar/mobile
  nav chrome was the gap.
- Added a `TODO` comment above `resume.html`'s static Contact block (email/phone are hardcoded
  markup, not read from `users/{uid}` or Auth, so this isn't a data-exposure regression) noting
  that per-viewer contact visibility controls are a future improvement, not yet built.

## Architecture

### Roles and the multi-tenant data model

- **Three roles, decided once at login and cached in `localStorage`** (`lfj:userMode` = `OWNER`/`FRIEND`/`VIEWER`, see [firebase-init.js](firebase-init.js)'s `getUserMode()`/`canParticipate()`): **Owner** (`jjun8647@gmail.com`, hardcoded) has full access everywhere and is the only role that sees admin UI (System Logs, Whitelist Management — now in Me's Connections/System Logs tabs, v2.7). **Friend** (an entry in `friends/{email}`, see below) gets their own private expenses/journal/photos/timeline/habits space — structurally identical to the owner's, just their own `uid`. **Viewer** (anyone else who signs in with Google) is read-only: sees public content from the owner and any friend, can like/comment on public gallery posts, but cannot create anything of their own (`canParticipate()` is false, so every "New X" button stays hidden and the Firestore rules would reject the write anyway). Nobody is ever signed out or blocked at login — this deliberately diverges from an earlier draft spec that wanted to bounce non-whitelisted users; the actual product decision is "let anyone in, public-only until promoted." **This role system is entirely separate from v3.2's peer-to-peer friend graph** (`friend_requests`/`friendships`, below) — role decides CRUD permissions and which profiles are even discoverable at all; the friend graph decides, independently, whether `visibility: "connections"` content is shown once a profile *is* reachable. `js/sidebar.js`/`js/mobile-nav.js` (v3.2) also read this same role to decide Owner-vs-Light navigation — see the Pages/Conventions bullets below.
- **The core query pattern, used identically across `gallery.js`, `journal.js`, `timeline.js`, `habits.js`**: two Firestore queries merged by doc ID — `where("uid","==",myUid)` (all of *my own* docs, any visibility) plus `where("visibility","==","public")` (everyone's public docs) — deduped into a `Map` keyed by `doc.id` so a doc that's both mine and public isn't double-counted. This replaced the old v1.2 "public query + private query" pattern, which relied on a blanket `where("visibility","==","private")` query that the new per-uid rules would reject outright (the rules engine can't confirm an unfiltered "give me all private docs" query only returns the caller's own — Firestore requires the query itself to be provably scoped). **`expenses` is the one exception**: it has no public/private concept at all anymore (financial data, always private), so `expenses.js`/`dashboard.js`/`export.js`/`calendar.js`/`insights.js` all just do a single `where("uid","==",myUid)` query with no public half.
- **Every write is gated by `canParticipate()`** (owner or friend) instead of the old `isOwner(user)` — `gallery.js`'s "New Post", `expenses.js`'s "Add Expense", `journal.js`'s "New Entry", `timeline.js`'s "New Event", and `habits.js`'s "New Habit" all switched from owner-only to participant-only. Every new doc is written with `uid: auth.currentUser.uid` (not a hardcoded owner reference), and per-post/per-item "is this mine" checks (e.g. gallery's Analytics-panel visibility, habits' check-in button) compare against `item.uid === auth.currentUser.uid`, not a global `isOwner()` call — ownership is now per-document, not site-wide.
- **[firestore.rules](firestore.rules)** defines the shared helpers `isOwner()`, `isFriend()` (checks `exists(friends/{email})` — the legacy whitelist-role check), `canParticipate()` (owner or friend — who may `create` in a participatory collection), and `isMineOrPublic(data)` (the read condition shared by `journals`/`life_events`/`habits`/`photos`/`collections`: `data.uid == request.auth.uid || data.visibility == 'public' || (data.visibility == 'connections' && isAcceptedFriend(data.uid))`, the last clause added in v3.2). `expenses`/`goals`/`time_capsules`/`daily_reflections` skip `isMineOrPublic` and just check `resource.data.uid == request.auth.uid` for read **and** write, full stop — never touched by the `connections` tier. `photos/{id}/likes`, `/comments`, `/views` reuse a `canReadPost(photoId)` helper (subcollection rules never inherit from the parent `match` block, so these need their own explicit blocks) — likes/comments are open to any signed-in user who can read the post (liking isn't "participating" in the personal-data sense), views stay create-only for the viewer and read-only for the post's own `uid`. `usernames/{username}` (new in v3.1) is a `create`-only, no-`update` collection — Firestore's create-vs-update distinction (a `create` rule only fires when no doc with that ID exists) makes "first writer claims the handle" fall out for free, no transaction or Cloud Function needed; its `read` rule is world-open (`if true`, since v3.2.2 — was auth-required), as is the new `public_profiles/{uid}` collection's, since neither ever holds anything sensitive (`public_profiles` is a denormalized `users/{uid}` mirror with `email` deliberately excluded) — both exist to let an unauthenticated `resume.html?u=...` visitor resolve a handle/owner-lookup without needing to read the auth-required, email-bearing `users/{uid}`. `career_experiences`/`career_projects`/`career_certificates`/`career_awards`' read rule is `isCareerReadable(data)` (v3.2.2): `data.visibility == 'public' || isMineOrPublic(data)` — the one place in this app where a `public` doc is readable with **no** `request.auth` requirement at all, since Career is the one collection meant to support an unauthenticated HR visitor. **`friend_requests/{toUid}/incoming/{fromUid}` and `friendships/{uid}/friends/{friendUid}`** (v3.2) back the mutual-consent friend graph — see the "EdenAtlas v3.2" history bullet above for the full rule shapes and why the accept flow needs no transaction; `isAcceptedFriend(ownerUid)` is the helper `isMineOrPublic()` calls, deliberately named apart from `isFriend()` to avoid shadowing the whitelist check. `notifications`' create rule has one narrow cross-uid exception for `friend_request`/`friend_accepted` types only (self-attested via `fromUid`).
- **[storage.rules](storage.rules)** mirrors this: paths are now `gallery/{uid}/{public,private,connections}/...` and `journal/{uid}/{public,private,connections}/...` (previously flat `gallery/{public,private}/...` with no per-user segment, and no `connections` tier before v3.2) so Storage can check `request.auth.uid == uid` directly from the path instead of needing a global owner check. A `canParticipate(email)` function cross-checks `firestore.exists(friends/{email})` (Storage rules can call into Firestore via the `firestore.*` namespace, as already used for the old `allowedUsers` check); the `connections` path's read rule additionally cross-checks `firestore.exists(friendships/{uid}/friends/{caller})`.
- **`friends/{email}`** (renamed from `allowedUsers`, doc ID = lowercase email — kept email-keyed rather than uid-keyed specifically so the owner can promote someone *before* they've ever signed in, when only their email is known) is managed from Me's Connections tab — Friend Management section (`me.js`'s `loadWhitelistManagement()`, moved from `settings.js` unchanged in v2.7), owner-only read/write, presence = approved (no separate `status` field; there's no self-serve request flow, so a `pending` state nothing else could ever set would be pointless).
- **`users/{uid}`** is a lightweight directory doc `{ uid, email, displayName, photoURL, role, username?, bio?, location?, createdAt }` upserted by `login.html` (with `{ merge: true }` — important, since a plain overwrite would blow away a `username`/`bio`/`location` set later from Me's Profile tab) on every successful sign-in, including session-restores (so a promotion/demotion shows up in `role` without needing a fresh interactive sign-in). Readable by any signed-in user, writable only by its own `uid`. `role` is `"owner"`/`"friend"`/`"viewer"` (lowercased from `getUserMode()`) — deliberately public, unlike the `friends` whitelist itself, so that any client can pre-filter Search People results without needing owner-only read access. `username` is optional, set from Me's Profile tab (`settings.js`'s original save flow, moved into `me.js` unchanged in v2.7), and uniqueness is enforced via a companion `usernames/{username}` reservation collection (doc ID = the handle, lowercase; the save flow does a `setDoc` create there first — which firestore.rules only allows when no doc with that ID exists yet — then deletes the old reservation and updates `users/{uid}`, so "claim if free" needs no backend). `bio`/`location` (added in v4.0) are free-text, also editable from Me's Profile tab, no uniqueness concern. `createdAt` (also v4.0) is a `serverTimestamp()` written **only the first time** `login.html`'s upsert sees no existing doc (checked via a `getDoc` first) — every later login's `merge: true` write omits it entirely, so it never resets; this is what `profile.html` formats as "Joined {month year}". This directory doc is what powers **dashboard.js's "Search People"**, **global-search.js**, and **profile.html** — see the Pages bullets below for all three. `careerVisibility` (v3.2.2, `"private"|"connections"|"public"`, missing == `"private"`) is the Owner-only page-level gate for `resume.html`'s public/friend viewer mode, set from a "Public Resume Link" control on `resume.html` itself (not Me) — see the "EdenAtlas v3.2.2" history bullet. Every field here except `email` is mirrored into the new, world-readable `public_profiles/{uid}` (below) so an unauthenticated resume visitor can resolve who they're looking at.
- **New collection `goals/{goalId}`** (v4.0): `{ uid, title, target, current, unit, deadline, createdAt }`. Always private — no `visibility` field, same read/write shape as `expenses` (owner-only read/update/delete, `canParticipate()` create) since personal targets have no public story. Managed entirely from Me's Overview tab (v2.7, moved from Dashboard unchanged), never a public/friend-visible collection.
- **New collection `collections/{id}`** (v2.7): `{ uid, title_en, title_zh, description_en, description_zh, coverImageUrl, icon, color, notes, visibility, createdAt, updatedAt }` — a life-chapter container, same `isMineOrPublic` read/write shape as `journals`/`life_events`/`habits`. Existing records reference it via an optional `collectionId` field (`null` on old, unmigrated docs) rather than being copied or moved; `photos`/`journals`/`life_events`/`expenses`/`career_projects` also gained optional `tags`/`locationName`/`latitude`/`longitude` fields (expenses: `collectionId`/`tags` only, no location, no visibility — still always-private). None of this needed a `firestore.rules`/`storage.rules` change beyond the one new `collections` match block, since this ruleset never restricts field sets via `hasOnly()`/`keys()`.

### Pages

- **No shared layout/include system.** Every page (`index.html`, `resume.html`, `gallery.html`, `atlas.html`, `journal.html`, `expenses.html`, `timeline.html`, `habits.html`, `calendar.html`, `reports.html`, `dashboard.html`, `notifications.html`, `contact.html`, `collections.html`, `collection-detail.html`, `me.html`, `settings.html`, `profile.html`, `time-capsule.html`) is a fully standalone HTML file that repeats the same `<head>` (Tailwind CDN, Font Awesome, `styles.css`, PWA manifest/theme-color/apple-touch-icon tags, a theme-preload inline `<script>` — see Light mode below) and the same header/nav markup (15 links plus an unread-notification badge next to "Notifications"). `login.html` is the one page that intentionally does **not** follow the shared nav/auth-guard pattern; `profile.html` follows it fully (auth-guard, full nav) but — like `login.html` — is deliberately *not* one of the linked pages, since it only makes sense with a `?uid=` param and is reached exclusively from a Search People result.
- **Site-wide login gate.** [auth-guard.js](auth-guard.js) is a shared ES module — every protected page loads it via a single `<script type="module" src="auth-guard.js"></script>` tag (right after `scripts.js`). It calls `onAuthStateChanged`; redirects to `login.html?redirect=<currentPage>` if signed out, otherwise removes the `auth-check-pending` body class to reveal the page. Forces a reload on a bfcache `pageshow` so Back-navigation re-checks auth. UX convenience only — real access control is `firestore.rules`/`storage.rules`. It also owns the one cross-page UI concern: if the signed-in user `isOwner` and the page's nav has a `#notif-badge` element, it queries `notifications` for `uid == owner && read == false` and lights up the badge.
- **Site-wide command palette.** [global-search.js](global-search.js) (v4.0) is the second shared ES module, loaded via `<script type="module" src="global-search.js"></script>` right after `auth-guard.js` on every protected page. Like `auth-guard.js`, it's self-contained — on `onAuthStateChanged`, it appends its own trigger button to `header nav` and its own modal to `document.body` rather than requiring any per-page markup, so wiring it up sitewide was a one-line-per-file addition. Opens on click or `Ctrl/Cmd-K`; queries `users` (role-gated like `dashboard.js`'s `searchableUsers()`), `photos`/`journals`/`life_events`/`habits` (mine+public merge), and `expenses` (mine-only, so other users' expenses are unreachable by construction of the query, not just by rules) and renders matches grouped by type with per-group counts.
- **[login.html](login.html)** is the one page every visitor can reach while signed out. On a successful `signInWithPopup`, it: (1) resolves the user's role via `resolveUserMode()` (owner check, then `getDoc(friends/{email})`) and caches it to `localStorage` as `lfj:userMode`; (2) upserts the `users/{uid}` directory doc; (3) writes a `login_logs` doc; (4) writes a `notifications` doc for *whoever just signed in* (no longer owner-only — everyone has their own notifications now). A `signingIn` flag guards against `onAuthStateChanged`'s own redirect firing mid-click and tearing down the page before these writes finish. On a session-restore (not a fresh click), `onAuthStateChanged` still refreshes the cached role before redirecting, in case whitelist status changed since the last visit. The `?redirect=` param is validated against `^[a-zA-Z0-9_-]+\.html$` to prevent an open-redirect vector. On iPhone, an installed "Add to Home Screen" PWA can't reliably complete Google sign-in in its own standalone window (tried both `signInWithPopup` and `signInWithRedirect` — both strand the user on Google's page with no way back, most likely because the transient state Firebase Auth needs mid-flow doesn't survive the round trip through Google's origin inside a standalone WKWebView). The fix: `isStandalone()` (checks `matchMedia("(display-mode: standalone)")` / `navigator.standalone`) swaps the sign-in button for an "Open in Safari to Sign In" link (`target="_blank"`, which forces iOS to hand off to real Safari even from a standalone window); the user signs in there normally, then reopens the installed app, which picks up the persisted session via `browserLocalPersistence` without repeating sign-in.
- **index.html** (rebuilt in v4.0) is a daily-habit landing page, not a dashboard — one inline `<script type="module">` block, still following this codebase's per-page duplication convention rather than importing other pages' `.js` files. Sections top to bottom: **Greeting** (time-of-day text + live clock + inline compact weather, reusing the old weather-widget fetch); **Today** (habits checklist, today's expense sum, did-I-journal-today, did-I-upload-today, unread notification count — all `where("uid","==",myUid)` only, no public merge, since this is a strictly personal landing page); **Memories** ("On This Day" — own photos/journals/life_events whose date matches today's month+day in a *different* year, grouped as "N years ago," hidden entirely if empty); **Recent Memories** (latest own photo/journal + 2 latest timeline events); **This Month** (expense total, habit completion %, journal count, photos uploaded); **Quick Actions** (canParticipate()-gated; three buttons open inline modals that `addDoc`/`uploadBytes` straight into `expenses`/`journals`/`photos` — not the full per-page forms, just the essential fields, then re-run the same data fetch to refresh Today/This Month/Memories immediately); and a slim single-row link list to every other page at the bottom (replacing the old 12-tile quick-link grid).
- **resume.html** combines 6 former pages into one — see section `id`s (`quests`, `events`, `experience`, `inventory`) which still carry old short names; don't rename without updating the sticky sub-nav anchors.
- **[gallery.js](gallery.js)** — Instagram-style feed. `fetchVisiblePosts()` uses the mine+public pattern (capturing `{ id: doc.id, ...doc.data() }` — a v1.2 bug fix, previously plain `doc.data()` with no id). "New Post" is `canParticipate()`-gated, writes `uid: user.uid` and uploads to `gallery/{uid}/{visibility}/{category}/...`. Likes (`photos/{id}/likes/{uid}`, doc ID = liker's uid so "one like per user" is structural) and comments are open to any signed-in viewer who can read the post. The "Analytics" panel (total views / unique visitors / recent visitor emails) only renders on a post where `post.uid === auth.currentUser.uid` — per-post ownership, not a site-wide owner check. Views are recorded once per session for any viewer who isn't that post's own `uid`. The "someone liked your photo" notification (`checkLikeNotifications`) now fires per-post for whichever signed-in user owns that specific post, comparing against a `localStorage`-cached like count. **Albums (v4.0)**: `category` is now album taxonomy — `travel`/`projects`/`events`/`dailylife`, chosen from a select at upload time — plus an independent `featured: boolean` toggled per-post by its own owner (a heart/star control, just an `updateDoc` on the existing `photos/{id}` doc — already covered by the pre-existing owner-only update rule, no rules change). `albumOf(post)` maps a post's stored `category` through `LEGACY_CATEGORY_ALIAS` (`{personal: dailylife, event: events, work: projects, project: projects}`) so photos uploaded before this relabel still bucket correctly — existing Firestore data was never migrated, only the display/filter mapping changed. `profile.js` duplicates this same `CATEGORY_META`/`LEGACY_CATEGORY_ALIAS`/`albumOf` (per-page duplication convention, kept in sync manually).
- **[expenses.js](expenses.js)** — always-private, no visibility toggle in the UI or schema anymore. `fetchMyExpenses()` is a single `where("uid","==",myUid)` query (no public half). `checkExpenseAlert()` fires for *any* participant whose own month total crosses RM1000, deduped via `localStorage` per calendar month.
- **[journal.js](journal.js)** / **[timeline.js](timeline.js)** / **[habits.js](habits.js)** — all three use the mine+public pattern and `canParticipate()` write-gating described above. `journal.js`'s `checkJournalReminder()` and `habits.js`'s `checkStreakNotification()`/check-in button are scoped to the current user's own entries/habits (`entry.uid === user.uid` / `habit.uid === user.uid`), not a global owner check.
- **[dashboard.js](dashboard.js)** (nav-labeled **Connections** since v2.7, was People) — **Search People** (role-gated discovery, unchanged since v2.7: `loadUserDirectory()` fetches the `users` collection once; `searchableUsers()` role-filters it — a Viewer only ever sees `role === "owner"`, a Friend or the Owner sees `role === "owner" || "friend"` — before the free-text match against `displayName`/`username` runs, never `email`), plus, as of **v3.2**, the real friend graph: **Friend Requests** (incoming pending, Accept/Decline), **My Friends** (real accepted friendships, replacing the old "every role-visible person" list), and **Sent Requests** (pending requests I've sent, discovered by looping the cached `users` directory with one lazy `getDoc` per candidate — see the "EdenAtlas v3.2" history bullet for why this needs no new collection or collection-group query). `relationshipState(person)` picks one action per card (Add Friend / Pending / Accept+Decline / Friend badge + Remove Friend). `reconcileFriendships()`/`pruneStaleFriendships()`/`loadSentRequestsAndHeal()` self-heal both directions of the friendship mirror on every load, since the accept flow never does a cross-uid write (see below). The Gallery/Expense/Journal analytics, Goals, and Achievements that used to live here (v4.0) all moved to [me.js](me.js)'s Overview tab, unchanged, not duplicated.
- **[me.html](me.html) / [me.js](me.js)** (v2.7, replaces Settings + folds in Dashboard's personal-analytics half) — the personal control center, tabbed: **Overview** (Goals — a `#goals-section` hidden unless `canParticipate()`, progress bar/update/delete/"New Goal" modal, moved from `dashboard.js` unchanged; Achievements — `renderAchievements()`, tiered badges from live counts, same `ACHIEVEMENTS` defs and duplicated `computeStreak()` as before; Gallery/Expense/Journal analytics, Chart.js charts, all `fetchMyCollection(name)` = `where("uid","==",myUid)` only, no public merge); **Profile** (username reservation flow + bio/location, moved from `settings.js` unchanged); **Preferences** (theme/language/default city/default post visibility, moved from `settings.js` unchanged); **Privacy** (new, deliberately minimal — a role/visibility explainer plus a read-only echo of the Preferences default-visibility choice, no new toggles); **Connections** (Whitelist Friend Management, moved from `settings.js` unchanged, owner-only reveal); **Backup** (Export & Backup, unchanged `export.js` wiring); **System Logs** (last 20 `login_logs`, moved from `settings.js` unchanged, owner-only reveal). Tab switching is plain `classList.toggle("hidden")` on `.me-panel` divs, no routing.
- **[collections.html](collections.html) / [collections.js](collections.js)** and **[collection-detail.html](collection-detail.html) / [collection-detail.js](collection-detail.js)** (v2.7) — see the "EdenAtlas v2.7" history bullet above for the full design; reached only via a link inside `atlas.html`, no sidebar/drawer entry of its own.
- **[atlas.html](atlas.html) / [atlas.js](atlas.js)** (v2.7) — see the "EdenAtlas v2.7" history bullet above; the one page in the app that loads a non-Firebase third-party library (Leaflet.js + CARTO tiles, both CDN, no paid API).
- **[profile.html](profile.html) / [profile.js](profile.js)** — the read-only profile page Search People links to. `canViewProfile(targetRole)` re-derives the same Viewer-sees-only-Owner / Friend-and-Owner-see-each-other rule from `getUserMode()` + the target's `users/{uid}.role`, and is a **UI-level gate, not a firestore.rules change**: the underlying `isMineOrPublic`/`isPhotoMineOrPublic` read rules deliberately stay open to any signed-in user (that's what the main Gallery/Journal/Timeline/Habits feeds rely on to show everyone's public posts), so a determined client could still query a Friend's public docs directly — this page and Search People's list are the only things actually restricting discovery. If the gate fails, the page still renders the target's name/avatar/@username (fetched from the always-public `users/{uid}` doc) but shows a "This profile is private" notice instead of fetching any content. Otherwise it fetches public photos/journals/life_events/habits and renders (all v4.0, GitHub+Instagram-style): a header with **bio**/**location**/**joined date** (from `users/{uid}.createdAt`); a stat row including **habit completion %** (`habitCompletionPct()` — average, across the target's public habits, of `completedDates.length / daysSinceCreated`, clamped 0–100); a public **Achievements** row (`PUBLIC_ACHIEVEMENTS` — only Photos/Journal Entries/Longest Streak, deliberately *never* an expenses-based badge, since expenses are always private and unreadable for any uid but your own); a **Recent Activity** feed (public photos+journals+events merged and sorted by date); **Albums** (`album-tiles`, same `albumOf()`/`featured` taxonomy as `gallery.js`) that client-side-filter the existing photo grid (no extra query) with a "Back to all" reset; and compact **Public Timeline**/**Public Journal** lists. Clicking a grid thumbnail opens a modal that lazy-fetches that one photo's likes/comments and lets you like/comment on it (reusing `photos/{id}/likes|comments`, unchanged rules) — but there's no edit/delete affordance anywhere on the page, since this is someone else's content. **v3.2**: `fetchPublicFor()` became `fetchVisibleFor()` — still public-only for Habits, but for photos/journals/life_events it also merges in `visibility: "connections"` items (scoped `uid==target`) when a new `isAcceptedFriendOfTarget()` check (one `getDoc` on the target's own `friendships` subcollection) is true. `profile.html` deliberately **stays single-scroll** rather than being rebuilt into a tabbed Friend Profile View — only the data merge changed, not the page structure, a scope decision made explicitly to avoid a much larger rewrite.
- **[calendar.html](calendar.html) / [calendar.js](calendar.js)** (new in v2.0) — a 7-column month grid of the signed-in user's own expenses/photos/journal entries, bucketed by day. Fetches all of "my" docs per collection (no server-side date-range filter — an equality-plus-range query needs a composite index, so date bucketing happens client-side, consistent with this app's index-avoidance convention) and re-fetches on every month navigation via `Promise.all`.
- **[reports.html](reports.html) / [insights.js](insights.js)** (new in v2.0) — current-month stat cards (total spend, top category, photo/journal counts) plus two Chart.js charts (category doughnut, weekday-vs-weekend average bar) for the signed-in user's own data. The weekend-spending warning banner compares *average spend per elapsed day* in each bucket (not raw totals — a month always has more weekdays than weekend days, so raw totals would almost always favor weekdays).
- **[notifications.html](notifications.html) / [notifications.js](notifications.js)** — each user sees only *their own* notifications (`where("uid","==",user.uid)`, no `orderBy` — sorted client-side to avoid a composite index). Almost every notification is still self-written by whichever client observed the triggering condition (opening a general "write on someone else's behalf" surface wasn't worth it for a best-effort, non-realtime feature with no backend to push things instantly anyway) — **the one exception, added in v3.2, is `friend_request`/`friend_accepted`**, where the sender writes directly into the recipient's inbox (see `firestore.rules`' notifications create rule). `fetchNotifications()` and `auth-guard.js`'s badge query both used to gate on `isOwner(user)` — a pre-existing gap that predated v3.2 (the rules and `login.html`'s upsert already treated notifications as per-user) — v3.2 dropped that gate so non-owner recipients actually see their friend-request notifications.
- **[settings.html](settings.html)** — as of v2.7, a one-line `<meta http-equiv="refresh" content="0;url=me.html">` compatibility redirect (added right after the charset meta, rest of the file left as-is) — everything it used to own (Profile, Preferences, Export & Backup, System Logs, Whitelist Management) lives in [me.html](me.html)/[me.js](me.js) now, see the Me bullet above. `settings.js` itself is unchanged and still script-tagged on `settings.html` (harmless — it runs briefly against `settings.html`'s still-intact markup before the meta-refresh navigates away) — kept in the repo as the historical source `me.js`'s logic was copied from, not as a parallel implementation to maintain going forward. [export.js](export.js)'s `fetchMyCollection(name)` still exports strictly "my own docs," never anyone else's public ones, unaffected by the move.
- **[images/](images/)** holds photo assets plus the PWA icons `icon-192.png`/`icon-512.png` (cropped from `me5.jpeg` via a one-off PowerShell/`System.Drawing` script — no build tool involved, just static files).
- **[firebase-init.js](firebase-init.js)** — shared Firebase bootstrap. Exports `auth`, `googleProvider`, `db`, `storage`, `OWNER_EMAIL`, `isOwner(user)`, plus the role helpers `USER_MODE_KEY`, `getUserMode()`, `canParticipate()` (read `lfj:userMode` from `localStorage` — UI gating only, real enforcement is always the Firestore/Storage rules re-checking `friends` fresh). Also calls `setPersistence(auth, browserLocalPersistence)` so sessions survive a PWA relaunch.
- **Deploying rules**: `npx firebase-tools deploy --only firestore:rules,storage` (project `lfj-profolio`, via [firebase.json](firebase.json)/[.firebaserc](.firebaserc)) after any `firestore.rules`/`storage.rules` edit. Dev-only tool, doesn't affect the site's buildless runtime.
- **PWA**: [manifest.json](manifest.json) + [service-worker.js](service-worker.js) (network-first with cache fallback; `CACHE` is version-stamped — bump it whenever `PRECACHE`'s file list changes, currently `eden-shell-v8`). Bypasses `gstatic.com`/`googleapis.com`/`firebaseapp.com`/`openweathermap.org`/CDN hosts so it never intercepts live Auth/Firestore/Storage/weather/CDN requests.
- **Light mode**: toggle in Me's Preferences tab (was Settings' Preferences pre-v2.7), stored in `localStorage` (`lfj:settings.theme`), applied via a synchronous theme-preload inline `<script>` at the top of every `<head>` plus `styles.css`'s `html[data-theme="light"]` overrides.

## Conventions to follow when editing

- **Nav links (v2.7: two live navs, one dead one)**: the original `<nav>` inside each page's `<header>` (15 non-login/non-profile pages as of v2.9: Home, Career, Memories, Atlas, Journey, Finance, Journal, Calendar, Connections, Reports, Inbox, Me, Habits, Time Capsule, Contact — `login.html` excluded, AI removed in v2.6, `profile.html` and `collections.html`/`collection-detail.html`/`me.html`/`atlas.html` are reached without ever being *in* this dead nav's link list, or in `collections.html`'s/`collection-detail.html`'s case have no dead-header nav block at all since they were built after the header was already retired) is now permanently inert — the `<header>` itself is `class="hidden"` on every breakpoint, superseded by `js/sidebar.js` (desktop) and `js/mobile-nav.js` (mobile). **When adding a new page, update three navs, not one**: `sidebar.js`'s `PRIMARY_LINKS`/`SECONDARY_LINKS`, `mobile-nav.js`'s `DRAWER_LINKS`, and (for completeness/history, even though it no longer renders) the dead `<header>` nav block, plus a quick-link card on `index.html` — unless, like Collections, the page deliberately has no sidebar/drawer entry of its own. The Notifications/Inbox link carries a `<span id="notif-badge">` in both the dead header nav and nowhere else — `auth-guard.js` looks it up by ID, and neither `sidebar.js` nor `mobile-nav.js` currently render an unread badge (a gap, not a deliberate omission — worth fixing if the badge matters going forward). When editing the *dead* header nav block identically across many files, a scripted find/replace (PowerShell loop matching the exact `<a href="...">` line text) beats manual edits — **always read the file back with explicit `-Encoding UTF8` (or `[System.IO.File]::ReadAllText(path, [System.Text.Encoding]::UTF8)`) on both read and write**. Windows PowerShell 5.1's `Get-Content`/`Set-Content` default to the system ANSI codepage when a file has no BOM, which silently mangles any existing non-ASCII character (em dashes, emoji) into mojibake (`â€”`, `ðŸ”¥`) that then gets baked into the file on write — this happened for real during the v2.0 pass and had to be cleaned up after the fact across several files.
- **Role-aware "Light EdenAtlas" navigation (v3.2)**: `js/sidebar.js`/`js/mobile-nav.js` now check `getUserMode()` and render a shorter flattened link list for any non-owner (Friend or Viewer), dropping Career/Finance/Reports/Time Capsule/Constellation — see the "EdenAtlas v3.2" history bullet. A page in that hidden set stays reachable by direct URL, backstopped by `auth-guard.js` redirecting non-owners away when the page's `<body>` carries `data-owner-only="true"` — add that attribute (not a new per-page check) when adding a future owner-only page.
- **New protected pages need three things**: the theme-preload inline `<script>` as the first line of `<head>`, the PWA `<link rel="manifest">`/`theme-color`/`apple-touch-icon` tags, `auth-check-pending` in the `<body class="...">` string, and `<script type="module" src="auth-guard.js"></script>` right after `scripts.js`. Copy an existing page (e.g. `timeline.html` or `habits.html`) as the template.
- **Color palette**: `darkBg`, `cardBg`, `borderNeon`, `neonPurple`, `neonBlue`, `neonViolet`, `textGray` — defined identically in each page's inline `tailwind.config`. No single source of truth; keep in sync manually.
- **Fonts**: `font-cyber` (headings/labels), `font-code` (monospace, data/labels), `font-sans` (body, default) — system stacks only.
- **Card style**: `bg-cardBg/90 backdrop-blur-sm p-6 rounded-2xl neon-border-purple`, often with `hover:-translate-y-1 transition-all` on clickable cards.
- **Icons**: Font Awesome 6 solid icons, colored per section to visually distinguish categories.
- **Scroll reveal**: `reveal` class on top-level sections/cards; `reveal-group` on a shared parent for staggered children. Requires `<script src="scripts.js" defer></script>` before `</body>`.
- Copy the closest existing page as a starting template rather than writing one from scratch.
- **Copy tone**: professional "system profile" language — avoid RPG vocabulary (hunter, quest, guild, level/LV, EXP, inventory, loot tiers, dungeon). Prefer plain dashboard/resume terms.

## Keeping docs current

When adding a new page, section, or notable structural change, update both [README.md](README.md) (page table / tech stack) and this file so they stay accurate.
