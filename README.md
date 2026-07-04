# Personal OS — Dark Glass System Dashboard

A 14-page **login-first**, **multi-tenant** personal system ("Personal OS") built around **Low Fang Jun**, styled as a dark glassmorphism "system dashboard" (near-black canvas, translucent blurred cards, a single soft violet accent, Apple system fonts). The owner and any number of approved "friends" each get their own private expenses/journal/photos/timeline/habits space, isolated by Firebase Auth `uid`; anyone else who signs in is a read-only Viewer limited to public content. Every page requires Google sign-in via `login.html` before it renders — see [Login gate](#login-gate-auth-guardjs--loginhtml) below. Built as static HTML/CSS with Tailwind CSS (via CDN) — no build step, no framework, no dependencies to install. Installable as a PWA (`manifest.json` + `service-worker.js`, real `images/icon-192.png`/`icon-512.png` app icons) with offline shell caching.

## Roles

- **Owner** (`jjun8647@gmail.com`) — full access everywhere, plus the only role that sees System Logs and Whitelist Management in Settings.
- **Friend** — anyone approved via Settings' Whitelist (a `friends/{email}` Firestore doc). Gets their own private expenses/journal/photos/timeline/habits space, structurally identical to the owner's.
- **Viewer** — anyone else who signs in with Google. Read-only: sees public content from the owner and any friend, can like/comment on public gallery posts, but can't create anything of their own.

Nobody is ever signed out or blocked at login — everyone gets in, access just scales with role.

## Pages

| Page | File | Content |
|---|---|---|
| Login | [login.html](login.html) | The one page reachable while signed out — "Sign in with Google," resolves the signer's role, then redirects into the app |
| Home | [index.html](index.html) | Dashboard layout: identity strip, System Status, live Weather widget, a "Today's Habits" widget, and quick-link cards to every other page |
| Resume | [resume.html](resume.html) | Combined resume — Profile, Matrix, Education, Leadership & Events, Work Experience, Achievements & Skills sections with a sticky in-page sub-nav |
| Gallery | [gallery.html](gallery.html) | Instagram-style feed — your own photos (any visibility) plus everyone's public ones; likes, comments, and per-post view analytics visible only to that post's own creator |
| Journal | [journal.html](journal.html) | Daily journal — markdown entries with mood + tags, optional image; your own entries plus everyone's public ones |
| Expenses | [expenses.html](expenses.html) | Personal spend tracker — always private, never shared; daily-spending and by-category Chart.js charts |
| Timeline | [timeline.html](timeline.html) | Life events grouped by year — your own events plus everyone's public ones |
| Habits | [habits.html](habits.html) | Habit tracker — daily check-ins, streaks, a 7-day weekly strip, and a monthly completion ring per habit |
| Calendar | [calendar.html](calendar.html) | Monthly 7-column grid of your own expenses/photos/journal entries, bucketed by day |
| Reports | [reports.html](reports.html) | Monthly recap of your own activity — total spend, top category, weekday-vs-weekend spending comparison, photo/journal counts |
| Dashboard | [dashboard.html](dashboard.html) | Read-only analytics of your own Gallery/Expenses/Journal activity, plus **Search People** to browse another signed-in user's public content |
| Notifications | [notifications.html](notifications.html) | Your own notification center — login/expense/journal/habit/gallery alerts, unread badge in the nav, mark-as-read |
| Contact | [contact.html](contact.html) | Email / phone / location, with a one-click "send message" CTA |
| Settings | [settings.html](settings.html) | Profile, preferences, Export & Backup (any signed-in user), and — owner-only — login history and Whitelist Friend Management |

## Running locally

No install or build required — just open [index.html](index.html) in a browser, or serve the folder locally:

```powershell
npx serve .
```

## Login gate: `auth-guard.js` + `login.html`

Every page except `login.html` is gated: a single `<script type="module" src="auth-guard.js"></script>` tag checks `onAuthStateChanged` and redirects to `login.html?redirect=<page>` if signed out, or reveals the page once a user is confirmed. `login.html` resolves the signer's role (Owner / Friend / Viewer, cached to `localStorage` as `lfj:userMode`), upserts a `users/{uid}` directory doc, writes a `login_logs` doc, and writes a "new login" notification — all before redirecting into the app. This gate is a UX convenience, not the security boundary — real access control is (and remains) enforced by `firestore.rules`/`storage.rules`.

On iPhone, an installed "Add to Home Screen" PWA can't reliably complete Google sign-in inside its own standalone window — `login.html` detects that (`isStandalone()`) and swaps the button for an "Open in Safari to Sign In" link instead, which hands off to real Safari where the normal popup flow works; the installed app picks up the resulting session on next launch.

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

`friends/{email}` (Settings' Whitelist — Friend Management) grants Friend status; `users/{uid}` is a lightweight directory doc upserted on every login, powering Dashboard's **Search People** (find another signed-in user, view only their public content). [firestore.rules](firestore.rules) and [storage.rules](storage.rules) are the source of truth for all of this; after editing either, deploy with `npx firebase-tools deploy --only firestore:rules,storage` (see [firebase.json](firebase.json)/[.firebaserc](.firebaserc) — a dev-only CLI tool, the site itself stays buildless).

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

[dashboard.js](dashboard.js) computes Gallery/Expense/Journal analytics from your own data only (no cross-user aggregation). **Search People** fetches the `users` directory, lets you search by name/email, and shows a read-only summary of another signed-in user's public activity.

## Settings

**Profile** (read-only off `auth.currentUser`) and **Preferences** (`localStorage`) are available to everyone. **Export & Backup** is available to any signed-in user. **System Logs** (last 20 `login_logs`) and **Whitelist — Friend Management** (promote/demote `friends/{email}` docs) are owner-only.

## Structure notes

Every page repeats the same header/nav and Tailwind theme config — there's no shared layout include, so changes to the nav or color palette need to be applied to each `.html` file individually. See [CLAUDE.md](CLAUDE.md) for details if editing with Claude Code.
