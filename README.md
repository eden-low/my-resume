# EdenAtlas

*A personal digital atlas for memories, growth, career, and life.*

A 15-page **login-first**, **multi-tenant**, **bilingual (English/中文)** personal system built
around Low Fang Jun ("Jun"), styled as a dark glassmorphism product (near-black canvas,
translucent blurred cards, a single soft violet accent, Apple system fonts). The owner and any
number of approved "friends" each get their own private expenses/journal/photos/timeline/habits
space, isolated by Firebase Auth `uid`; anyone else who signs in is a read-only Viewer limited to
public content — including HR visitors reviewing the public **Career** page. Every page requires
Google sign-in via `login.html` before it renders — see [Login gate](#login-gate-auth-guardjs--loginhtml)
below. Built as static HTML/CSS with Tailwind CSS (via CDN) — no build step, no framework, no
dependencies to install. Installable as a PWA (`manifest.json` + `service-worker.js`, real
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
loading skeletons) were added. See `CLAUDE.md`'s version history for the full breakdown.

## Roles

- **Owner** (`jjun8647@gmail.com`) — full access everywhere, plus the only role that sees System Logs and Whitelist Management in Settings.
- **Friend** — anyone approved via Settings' Whitelist (a `friends/{email}` Firestore doc). Gets their own private expenses/journal/photos/timeline/habits space, structurally identical to the owner's.
- **Viewer** — anyone else who signs in with Google. Read-only: sees public content from the owner and any friend, can like/comment on public gallery posts, but can't create anything of their own.

Nobody is ever signed out or blocked at login — everyone gets in, access just scales with role.

## Pages

| Page | File | Content |
|---|---|---|
Nav labels below reflect the current EdenAtlas naming; file names are unchanged from the
original build to avoid a risky site-wide route rename (see the Brand & navigation section).

| Nav label | File | Content |
|---|---|---|
| (none) | [login.html](login.html) | The one page reachable while signed out — "Sign in with Google," resolves the signer's role, then redirects into the app |
| Home | [index.html](index.html) | A daily-habit landing page, not a dashboard: a time-of-day greeting + live clock + weather, a **Today** strip (habits/spending/journal/photos/notifications), an "On This Day" **Memories** flashback, **Recent Memories** (latest photo/journal/timeline events), a **This Month** recap, and **Quick Actions** (add an expense/journal entry/photo without leaving the page) |
| Career | [resume.html](resume.html) | HR-friendly Career CMS — Profile/Highlights/Education/Leadership sections stay static; **Experience**, **Projects** (with Featured strip + detail modal + Reflection), **Certificates**, and **Awards** are Firestore-backed and owner-editable, everyone else sees public items read-only. See [Career CMS](#career-cms-careerjs) below |
| Memories | [gallery.html](gallery.html) | Instagram-style feed — your own photos (any visibility) plus everyone's public ones, organized into albums (Travel/Projects/Events/Daily Life) plus a cross-cutting Favorites star; likes, comments, and per-post view analytics visible only to that post's own creator |
| Journal | [journal.html](journal.html) | Daily journal — markdown entries with mood + tags, optional image; your own entries plus everyone's public ones |
| Finance | [expenses.html](expenses.html) | Personal spend tracker — always private, never shared; daily-spending and by-category Chart.js charts |
| Journey | [timeline.html](timeline.html) | Life events grouped by year — your own events plus everyone's public ones |
| Habits | [habits.html](habits.html) | Habit tracker — daily check-ins, streaks, a 7-day weekly strip, and a monthly completion ring per habit |
| Calendar | [calendar.html](calendar.html) | Monthly 7-column grid of your own expenses/photos/journal entries, bucketed by day |
| Reports | [reports.html](reports.html) | Monthly recap of your own activity — total spend, top category, weekday-vs-weekend spending comparison, photo/journal counts |
| People | [dashboard.html](dashboard.html) | **Search People** (find another signed-in user by name/@username/email) plus read-only analytics of your own Memories/Finance/Journal activity, **Goals** (target/progress/deadline tracking), and auto-generated **Achievements** (tiered, data-driven badges) |
| (search result only) | [profile.html](profile.html) | Read-only GitHub+Instagram-style profile (`?uid=`) opened from Search People — avatar/name/@username/bio/location/joined date, public stats (incl. habit completion %), public Achievement badges, Recent Activity, photo **Albums** (Travel/Projects/Events/Daily Life/Favorites), and public Timeline/Journal lists — all public content only, nothing editable. Not in the nav — only reachable via a search result, same as `login.html` |
| Inbox | [notifications.html](notifications.html) | Your own notification center — login/expense/journal/habit/gallery alerts, unread badge in the nav, mark-as-read |
| Contact | [contact.html](contact.html) | Email / phone / location, with a one-click "send message" CTA |
| Settings | [settings.html](settings.html) | Profile (incl. @username, bio, location), **language switcher**, preferences, Export & Backup (any signed-in user), and — owner-only — login history and Whitelist Friend Management |

## Running locally

No install or build required — just open [index.html](index.html) in a browser, or serve the folder locally:

```powershell
npx serve .
```

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
Switch it from Settings' Preferences or the mobile drawer — both call the same `setLang()`,
which re-applies translations immediately (no reload) and fires an `eden:langchange` event that
`career.js` listens for, since Career's bilingual **content** fields (`title_en`/`title_zh`,
etc.) are a separate mechanism from `data-i18n` UI chrome.

## Career CMS: `career.js`

`resume.html` (nav-labeled "Career") is no longer purely static — **Experience**, **Projects**,
**Certificates**, and **Awards** are backed by four new Firestore collections
(`career_experiences`, `career_projects`, `career_certificates`, `career_awards`), each doc
carrying `uid`/`visibility`/`createdAt`/`updatedAt` plus bilingual content fields. Unlike every
other collection in this app, Career is **not** per-user multi-tenant — the page has always been
about one person — so writes are Owner-only (`isOwner()`), not `canParticipate()`-gated; HR
visitors and Friends only ever read `visibility:"public"` items. Profile/Highlights/Education/
Leadership stay static prose (out of CMS scope); Projects adds a Featured strip, category
filter, a detail modal, and a Reflection field. Uploads go to
`career/{uid}/{public,private}/...` in Storage. A one-time, manually-run
[migrate-career.html](migrate-career.html) ports the old static Education/Work-Experience/
Achievements prose into the new collections — delete it after running once.

## Desktop Sidebar: `js/sidebar.js`

A fifth shared module (v2.6), self-injecting like the others. The old horizontal top-nav
header is now permanently hidden on every breakpoint; on desktop, `js/sidebar.js` injects a
fixed left sidebar instead — Home/Career/Memories/Journey/Finance/Journal/Calendar/People/
Reports/Inbox/Settings as the primary list, Habits/Contact as a smaller secondary group (real
pages that would otherwise have no nav entry), then Profile/Logout/Collapse pinned to the
bottom. Collapses to an icon-only rail (`localStorage`-persisted) via a `--sidebar-w` CSS
variable that `body`'s `padding-left` reads, so every page reflows without its own layout change.

## Mobile navigation: `js/mobile-nav.js`

A fourth shared module. Below the `md` breakpoint, the sidebar and the old desktop header both
stay hidden in favor of an injected fixed top bar (hamburger — brand — avatar), a slide-in
drawer (full page list + language switcher + logout), a fixed bottom nav (Home / Memories /
Quick Add / People / Me), and a **Quick Add** bottom sheet (Add Expense / Write Journal / Upload
Photo / Add Timeline Event / Add Habit) that deep-links to `{page}.html?new=1` — the five target
pages' own scripts auto-open their existing "New X" modal when that param is present, rather
than duplicating the form. All touch targets are ≥44px.

## Global Search

[global-search.js](global-search.js) is a second shared module (alongside `auth-guard.js`) loaded on every protected page — it injects its own `Ctrl/Cmd-K` command palette into the header's nav rather than requiring per-page markup. Searches People/Gallery/Journal/Timeline/Habits/Expenses in one box, grouped results with a per-group count, each linking straight to the relevant page. Expenses are only ever searched against your own (never another uid — they stay strictly private by construction of the query itself).

## Memories, Goals & Achievements

- **Memories** ("On This Day," on the Home page) compares today's date against your own past photos/journal entries/timeline events from previous years and surfaces any matches as "N years ago" flashbacks.
- **Goals** (Dashboard) — personal targets with a title, target/current amount, unit, and deadline; always private, same shape as Expenses.
- **Achievements** (Dashboard, full set; Profile, public subset) are 100% computed from live Firestore counts — tiered badges for Photos Uploaded, Journal Entries, Expenses Recorded, and Longest Active Habit Streak. No hardcoded personal-history milestones. Profile only ever shows the badges derivable from *public* data (expenses are always private, so that badge never appears on anyone else's profile).

## Tech stack

- HTML5 + [Tailwind CSS](https://tailwindcss.com/) (loaded via CDN, configured inline in each page's `<script>` block)
- [Chart.js](https://www.chartjs.org/) (loaded via CDN on `resume.html`, `expenses.html`, `dashboard.html`, and `reports.html`) for charts
- [marked.js](https://marked.js.org/) (loaded via CDN on `journal.html`) for lightweight markdown rendering
- [Font Awesome 6](https://fontawesome.com/) for icons
- System font stacks only — no webfont loading
- [Firebase](https://firebase.google.com/) (Auth, Firestore, Storage) via `firebase-init.js` and each page's own module, loaded as ES modules straight from `gstatic.com` — no npm install, no bundler
- [OpenWeatherMap](https://openweathermap.org/) Current Weather API for the homepage weather widget
- Shared custom styles in [styles.css](styles.css); shared behavior in [scripts.js](scripts.js) (scroll-reveal, service-worker registration)
- A PWA layer: [manifest.json](manifest.json) + [service-worker.js](service-worker.js) (network-first with cache fallback, bypassing Firebase/CDN/weather hosts)

## Design system

The site moved from a neon-cyber "hunter status" look to a dark glassmorphism dashboard: near-black background (`#0a0a0e`), translucent blurred cards (`.neon-border-purple`), a soft violet accent (`#a78bfa`) plus a cool blue secondary (`#6ea8fe`), system UI/monospace fonts. Every page reads its palette from the same token names in its inline `tailwind.config` — see CLAUDE.md for the exact values to keep in sync.

## The multi-tenant data model

Every content collection (`expenses`, `journals`, `photos`, `life_events`, `habits`) is scoped by a `uid` field identifying its creator. The core fetch pattern, used identically across Gallery/Journal/Timeline/Habits: two Firestore queries merged by doc ID — `where("uid","==",myUid)` (all of *my* docs, any visibility) plus `where("visibility","==","public")` (everyone's public docs). Expenses skip the public half entirely (always private, no visibility concept). Every "New X" button and write is gated by `canParticipate()` (Owner or Friend) rather than a global owner check, and every new doc is written with `uid: auth.currentUser.uid`.

`friends/{email}` (Settings' Whitelist — Friend Management) grants Friend status; `users/{uid}` is a lightweight directory doc upserted on every login (now also carrying a public `role` field and an optional `username`), powering Dashboard's **Search People**. `usernames/{username}` is a one-doc-per-handle reservation collection (doc ID = the handle) that makes unique @usernames possible without a backend — Firestore's create-vs-update distinction means "claim if free" falls out of a plain `create` rule with no matching `update` rule. [firestore.rules](firestore.rules) and [storage.rules](storage.rules) are the source of truth for all of this; after editing either, deploy with `npx firebase-tools deploy --only firestore:rules,storage` (see [firebase.json](firebase.json)/[.firebaserc](.firebaserc) — a dev-only CLI tool, the site itself stays buildless).

## Gallery: Instagram-style feed with social features

[gallery.js](gallery.js) renders a single reverse-chronological feed (your own posts + everyone's public ones), with a like button (`photos/{id}/likes/{uid}` — doc ID is the liker's uid, so "one like per user" is structural) and a comment thread open to any signed-in viewer who can read the post. Per-post view analytics (`photos/{id}/views`) — total views, unique visitors, recent visitor emails — are visible only to that specific post's own creator, not a site-wide owner. Uploads go to `gallery/{uid}/{public,private}/...` in Storage.

## Expenses, Journal, Timeline, Habits

All four follow the same shape: your own entries (any visibility) plus everyone's public ones, rendered from a client-side cache with category/mood/type filter tabs. Expenses ([expenses.js](expenses.js)) are the exception — always private, with two Chart.js charts (daily spending, by-category). Journal ([journal.js](journal.js)) entries are raw markdown rendered via marked.js on expand, with optional image upload to `journal/{uid}/{public,private}/...`. Timeline ([timeline.js](timeline.js)) groups `life_events` by year with a user-picked date. Habits ([habits.js](habits.js)) compute streaks, a 7-day strip, and a `conic-gradient` monthly completion ring client-side from a `completedDates` array.

## Calendar & Reports

[calendar.js](calendar.js) renders a monthly grid of your own expenses/photos/journal entries bucketed by day (fetched in full per collection, filtered client-side to the visible month — avoids needing a composite index for an equality-plus-date-range query). [insights.js](insights.js) computes a current-month recap: total spend, top category, a weekday-vs-weekend average-spend comparison with a warning banner, and photo/journal counts.

## Notifications

Each user sees only their own notifications ([notifications.js](notifications.js)). Every alert is self-written by whichever client observed the triggering condition — a login alert from `login.html`, a spending alert from `expenses.js` (RM1000/month threshold), a journal reminder from `journal.js` (3+ days quiet), a habit-streak alert from `habits.js` (30/60/90-day milestones), and a "someone liked your photo" alert from `gallery.js`. Deduped via `localStorage` checkpoints per condition. [auth-guard.js](auth-guard.js) lights up an unread badge next to the nav's Notifications link.

## Export & Backup

Available to any signed-in user from Settings ([export.js](export.js)) — downloads *your own* data: Expenses as CSV, Journal as a combined Markdown file, Timeline and Gallery metadata as JSON, and a "Full Backup" JSON bundling `{ profile, settings, expenses, journals, timeline, gallery_metadata, habits }`.

## Dashboard: read-only analytics + Search People

[dashboard.js](dashboard.js) computes Gallery/Expense/Journal analytics from your own data only (no cross-user aggregation). **Search People** fetches the `users` directory, lets you search by name/@username/email, and — filtered by role (a Viewer only finds the Owner; a Friend or the Owner finds the Owner and any Friend) — links each result to [profile.html](profile.html), a dedicated read-only profile page with a public photo grid (like/comment, no edit) instead of an inline summary card.

## Settings

**Profile** (read-only off `auth.currentUser`) and **Preferences** (`localStorage`) are available to everyone. **Export & Backup** is available to any signed-in user. **System Logs** (last 20 `login_logs`) and **Whitelist — Friend Management** (promote/demote `friends/{email}` docs) are owner-only.

## Brand & navigation

Renamed sitewide from "Low Fang Jun / Personal OS" to **EdenAtlas** — nav labels changed
(Gallery→Memories, Timeline→Journey, Expenses→Finance, Notifications→Inbox, Resume→Career,
Dashboard→People) but **file names were deliberately left unchanged** to avoid the risk of a
site-wide route rename (broken bookmarks, PWA cache, internal links) for a purely cosmetic win.
Every page footer reads `EdenAtlas · by Jun · Version 2.5`.

## Structure notes

Every page repeats the same header/nav and Tailwind theme config — there's no shared layout include, so changes to the nav or color palette need to be applied to each `.html` file individually (the old top-nav header itself is now permanently hidden everywhere, superseded by the sidebar/mobile nav below, but its markup was left in place rather than deleted). The five sanctioned exceptions are `js/i18n.js` (translations, loaded first), `auth-guard.js` (the login gate), `global-search.js` (the command palette), `js/mobile-nav.js` (mobile chrome), and `js/sidebar.js` (desktop chrome) — all self-contained modules that inject their own DOM. See [CLAUDE.md](CLAUDE.md) and [design-system.md](design-system.md) for details if editing with Claude Code.
