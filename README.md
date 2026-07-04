# Personal OS — Dark Glass System Dashboard

A 12-page **login-first** personal system ("Personal OS") for **Low Fang Jun**, styled as a dark glassmorphism "system dashboard" (near-black canvas, translucent blurred cards, a single soft violet accent, Apple system fonts) — a deliberate move away from the earlier neon-cyber "hunter status" look, described further below. Every page requires Google sign-in via `login.html` before it renders — see [Login gate](#login-gate-auth-guardjs--loginhtml) below. Built as static HTML/CSS with Tailwind CSS (via CDN) — no build step, no framework, no dependencies to install. Installable as a PWA (`manifest.json` + `service-worker.js`, real `images/icon-192.png`/`icon-512.png` app icons) with offline shell caching.

## Pages

| Page | File | Content |
|---|---|---|
| Login | [login.html](login.html) | The one page reachable while signed out — "Sign in with Google," then redirects into the app |
| Home | [index.html](index.html) | Dashboard layout: identity strip, a System Status panel (live Firebase Auth session state), a live Weather widget (Kuching, OpenWeatherMap), and quick-link cards to the other pages |
| Resume | [resume.html](resume.html) | Combined resume — Profile, Matrix, Education, Leadership & Events, Work Experience, Achievements & Skills sections with a sticky in-page sub-nav |
| Gallery | [gallery.html](gallery.html) | Instagram-style feed of Firebase-backed posts — filter tabs by category/visibility, likes, comments, and owner-only view analytics per post; signing in as the owner reveals the Private tab and a "New Post" modal (see below) |
| Journal | [journal.html](journal.html) | Daily journal — markdown entries with mood + tags, optional image, search across title/content/tags, same public/private model as Gallery |
| Expenses | [expenses.html](expenses.html) | Personal spend tracker — daily-spending and by-category Chart.js charts, filterable list, owner-only "Add Expense" modal, same public/private model as Gallery |
| Timeline | [timeline.html](timeline.html) | Life events grouped by year — type/visibility filter tabs, search by year or text, owner-only "New Event" modal, same public/private model as Gallery |
| Habits | [habits.html](habits.html) | Habit tracker — daily check-ins, streaks, a 7-day weekly strip, and a monthly completion ring per habit, same public/private model as Gallery |
| Dashboard | [dashboard.html](dashboard.html) | Read-only analytics rollup across Gallery, Expenses, and Journal, plus a System Status panel (session, account age, current weather) — no writes on this page |
| Notifications | [notifications.html](notifications.html) | Owner-only notification center — login/expense/journal/habit/gallery alerts, unread badge in the nav, mark-as-read |
| Contact | [contact.html](contact.html) | Email / phone / location, with a one-click "send message" CTA |
| Settings | [settings.html](settings.html) | Profile, preferences (theme/default city/default privacy), owner-only login history + Access Management, and an owner-only Export & Backup section (CSV/Markdown/JSON exports plus a full JSON backup) |

## Running locally

No install or build required — just open [index.html](index.html) in a browser, or serve the folder locally:

```powershell
npx serve .
```

## Login gate: `auth-guard.js` + `login.html`

Every page except `login.html` is gated: a single `<script type="module" src="auth-guard.js"></script>` tag (dropped right after `scripts.js`) checks `onAuthStateChanged` and redirects to `login.html?redirect=<page>` if signed out, or reveals the page (removing a static `auth-check-pending` body class that starts every protected page hidden via `visibility: hidden` in `styles.css`) once a user is confirmed. `login.html` has the inverse logic inline — redirect away if already signed in, otherwise show a "Sign in with Google" button. A successful sign-in writes a `login_logs` doc (`uid`, `email`, `loginTime`, `device`, `page`) before redirecting into the app. This gate is a UX convenience, not the security boundary — real access control is (and remains) enforced by `firestore.rules`/`storage.rules`.

## Tech stack

- HTML5 + [Tailwind CSS](https://tailwindcss.com/) (loaded via CDN, configured inline in each page's `<script>` block)
- [Chart.js](https://www.chartjs.org/) (loaded via CDN on `resume.html`, `expenses.html`, and `dashboard.html`) for charts
- [marked.js](https://marked.js.org/) (loaded via CDN on `journal.html`) for lightweight markdown rendering
- [Font Awesome 6](https://fontawesome.com/) for icons
- System font stacks only — no webfont loading: `-apple-system`/SF Pro for UI text, `ui-monospace`/SF Mono for data and labels
- [Firebase](https://firebase.google.com/) (Auth, Firestore, Storage) on every page via `firebase-init.js`, `auth-guard.js`, `login.html`, `settings.js`, and each feature page's own module, loaded as ES modules straight from `gstatic.com` — no npm install, no bundler
- [OpenWeatherMap](https://openweathermap.org/) Current Weather API for the homepage weather widget (free-tier key embedded client-side in `index.html`, same trust model as the Firebase config — see Design system below)
- Shared custom styles in [styles.css](styles.css) (glass card treatment, ambient background glow, scrollbar, hero parallax layer, the `auth-check-pending` gate style, and the light-mode override block)
- Shared behavior in [scripts.js](scripts.js) (scroll-reveal animations, the hero mouse-parallax tilt — unused now that `index.html` is a dashboard rather than a photo hero — and service-worker registration)
- A PWA layer: [manifest.json](manifest.json) (name "Personal OS", `#09090e` theme/background colors, real `images/icon-192.png`/`icon-512.png` app icons) + [service-worker.js](service-worker.js) (network-first with cache fallback, explicitly bypassing Firebase/CDN/weather hosts so it never interferes with live requests)

## Design system

The site moved from a neon-cyber "hunter status" look to a dark glassmorphism dashboard: near-black background (`#0a0a0e`), translucent blurred cards (`.neon-border-purple` in styles.css — the class name is unchanged from the old theme, only its definition), a single soft violet accent (`#a78bfa`) plus a cool blue secondary (`#6ea8fe`), and system UI/monospace fonts instead of the old Orbitron/Fira Code webfonts. Because every page reads its palette from the same token names (`darkBg`, `cardBg`, `borderNeon`, `neonPurple`, `neonBlue`, `neonViolet`, `textGray`) in its inline `tailwind.config`, the whole site was re-themed by changing those token *values* once per page rather than rewriting markup — see CLAUDE.md for the exact values to keep in sync.

## Gallery: Instagram-style feed

`gallery.html` renders a single reverse-chronological feed of post cards (image, caption, category tag, public/private badge, timestamp), not fixed category grids. [firebase-init.js](firebase-init.js) sets up the Firebase app/auth/Firestore/Storage handles (reused by any future page that needs login), and [gallery.js](gallery.js) handles sign-in, fetches `photos` Firestore docs (public always, private only when authorized), merges + sorts them client-side by `uploadedAt` (deliberately not a Firestore `orderBy`, to avoid needing a composite index), and renders them into the feed. A filter tab bar (All / Personal / Event / Work / Project / Public / Private) re-filters the already-fetched posts in memory — no extra Firestore reads per click. The Private tab and the "New Post" button/modal only appear once signed in as the owner (`jjun8647@gmail.com`, see `OWNER_EMAIL` in `firebase-init.js`); the modal uploads the file to Storage then writes the Firestore doc (now including a user-entered `caption`).

Access to private posts beyond the owner is controlled by an `allowedUsers` Firestore collection (doc ID = lowercase email) — inviting someone is now done from Settings' Access Management panel (Promote/Demote), no Firebase Console visit needed. [firestore.rules](firestore.rules) and [storage.rules](storage.rules) are the source of truth for this access model; after editing either, deploy with `npx firebase-tools deploy --only firestore:rules,storage` (see [firebase.json](firebase.json)/[.firebaserc](.firebaserc) — a dev-only CLI tool, the site itself stays buildless).

Because posts are fetched at runtime, the feed is empty until the owner signs in and creates posts through the New Post modal.

**Social features**: each post has a like button (`photos/{id}/likes/{uid}` — doc ID is the liker's uid, so "one like per user" is structural, not just enforced by rules) and a comment thread (`photos/{id}/comments`, click the comment count to expand) open to any signed-in/allowed viewer, not just the owner. View analytics (`photos/{id}/views`) are owner-only end to end — recorded when a non-owner viewer sees a post, and only ever displayed to the owner (total views, unique visitors, recent visitor emails) via an "Analytics" toggle on each card. Firestore subcollection rules don't inherit from the parent document's `match` block, so `firestore.rules` adds a `canReadPost()` helper function reused by all three subcollections' read rules.

## Expenses: personal spend tracker

`expenses.html` follows the same pattern as the gallery — [expenses.js](expenses.js) fetches `expenses` Firestore docs (public always, private only when authorized), caches them client-side, and renders a filterable list (by category, or by Public/Private) plus two Chart.js charts built from the full accessible set regardless of the active list filter: a daily-spending bar chart (last 7 days) and a by-category doughnut chart. The owner-only "Add Expense" modal writes `{ amount, category, note, visibility, createdAt, uid }` — there's no file upload here, so it only needs Firestore, not Storage. Access control mirrors the gallery exactly (owner + `allowedUsers` allowlist); the `expenses` collection rules live alongside `photos` in [firestore.rules](firestore.rules).

## Journal: daily notes

`journal.html` reuses the same fetch/cache/filter pattern a third time — [journal.js](journal.js) fetches `journals` Firestore docs (public always, private only when authorized) into `journals/{public,private}` visibility groups, plus a mood filter and a client-side search box that matches title/content/tags on the cached set. Entries are written as raw markdown and rendered with marked.js only when a card is expanded (the collapsed card shows a plain-text snippet); there's no sanitizer on the rendered HTML, which is an accepted tradeoff since only the owner can ever write entries (write access is owner-only in the rules). Image attachment is optional — if a file is picked, it uploads to `journal/{public,private}/...` in Storage first (mirroring the gallery's Storage layout), otherwise `imageUrl` is stored as `null`. Access control mirrors Gallery/Expenses exactly (owner + `allowedUsers` allowlist).

## Timeline: life events by year

`timeline.html` is the fourth implementation of the fetch/cache/filter pattern, for a `life_events` Firestore collection (`{ title, description, date, type: career|education|travel|personal, visibility, uid }`). [timeline.js](timeline.js) groups the visible (filtered + searched) events by `date`'s year and renders each year as its own section with a vertical connector line; clicking an entry toggles its description open (no separate detail page). The search box matches title/description text **or** an exact year (typing "2024" jumps to that year's entries). `date` is a user-picked `<input type="date">` converted to a Firestore `Timestamp` on save — unlike the other pages' `createdAt`, this is an editable point-in-time value, not an auto "now" timestamp, since life events are often logged after the fact. **Scope note**: the automatic cross-collection aggregation described in some earlier planning notes (pulling in Gallery uploads / Expense milestones / Journal entries as auto-generated timeline items, and matching Travel events to related photos/expenses) was deliberately left out of this pass — it's a materially bigger feature (cross-collection queries + a unified item shape) that's easier to scope well once the manual timeline has real data in it. Right now the timeline only shows manually-created `life_events`.

## Habits: daily check-ins & streaks

`habits.html` is the fifth implementation of the fetch/cache/filter pattern, for a `habits` Firestore collection (`{ uid, title, icon, completedDates: [], visibility, createdAt }`). [habits.js](habits.js) computes everything client-side from `completedDates` (an array of `YYYY-MM-DD` strings): a current streak (consecutive days, allowing "not yet checked in today" without breaking it), a 7-day weekly strip, and a monthly completion percentage rendered as a CSS `conic-gradient` ring (no Chart.js needed). Checking in for today toggles today's date in/out of `completedDates` via `arrayUnion`/`arrayRemove`; this write, like every other collection, is owner-only — non-owner allowed viewers see read-only cards. `index.html`'s homepage has a compact "Today's Habits" widget (checklist + best streak) that duplicates a minimal version of this fetch/streak logic inline, matching how every other page keeps its own copy rather than importing a shared module.

## Notifications: owner-only alert center

`notifications.html` lists `notifications` docs (`{ uid, type, title, message, read, createdAt }`) for the owner only — the collection uses the same owner-write-only rule as everything else, deliberately, since there's no backend/Cloud Functions to push a notification the instant something happens elsewhere. Instead, each alert is written by the **owner's own client**, opportunistically, the next time their browser loads the page that would know about the triggering condition: a login alert from `login.html` right after the `login_logs` write, a spending alert from `expenses.js` when the current month crosses RM1000, a journal reminder from `journal.js` when the newest entry is 3+ days old, a habit-streak alert from `habits.js` on a 30/60/90-day milestone, and a "someone liked your photo" alert from `gallery.js` when a post's like count grows since the owner's last visit (tracked via `localStorage`, since there's no server-side comparison available). Duplicate alerts are avoided per-condition via `localStorage` checkpoints (e.g. one spending alert per calendar month). [auth-guard.js](auth-guard.js) — already loaded on every protected page — queries for unread count and lights up a badge next to the Notifications nav link.

## Export & Backup

Settings' owner-only **Export & Backup** section ([export.js](export.js)) downloads whatever is currently visible to the signed-in owner (public + private, same read pattern as every other page): Expenses as CSV (`date,amount,category,note`), Journal as a single combined Markdown file (one `# Title` block per entry with date/mood/tags), Timeline and Gallery metadata as JSON, and a "Full Backup" button that bundles `{ profile, settings, expenses, journals, timeline, gallery_metadata, habits }` into one `personal_os_backup.json` (`profile` from `auth.currentUser`, `settings` from the `lfj:settings` localStorage key). All downloads use a plain Blob + temporary `<a download>` click — no library.

## Dashboard: read-only analytics

`dashboard.html` has no create/edit UI at all — [dashboard.js](dashboard.js) just fetches from `photos`, `expenses`, and `journals` (public always, private only when authorized, same pattern as everywhere else) and computes aggregates client-side: Gallery totals/top category/last upload, Expense month/year/average-daily/top-category totals plus three Chart.js charts (monthly line, category pie, weekly bar), and Journal totals/mood/top-tags. A System Status section reads directly off `auth.currentUser.metadata` (`creationTime`, `lastSignInTime`) for account age and last sign-in, and does a simple (non-geolocated) OpenWeatherMap call for a Kuching weather readout. Because it only *reads* existing collections and the Auth user object, no new Firestore/Storage write rules were needed for this page.

## Settings: profile, preferences & login history

`settings.html` has four sections. **Profile** is read-only off `auth.currentUser` (name, email, avatar, account created/last sign-in) plus the site's one Sign Out button. **Preferences** (theme, default weather city, default post visibility) are stored client-side in `localStorage`, not Firestore — there's no per-user settings collection; the theme choice applies on the next reload. **System Logs** and **Access Management** are owner-only: System Logs lists the last 20 `login_logs` docs newest-first; Access Management lists every distinct email that has ever signed in (derived from the full `login_logs` collection) with a Promote/Demote control per row that adds/removes the corresponding `allowedUsers/{email}` doc — this replaces the previous manual Firebase-Console-only workflow for managing private-content access.

## Structure notes

Every page repeats the same header/nav and Tailwind theme config — there's no shared layout include, so changes to the nav or color palette need to be applied to each `.html` file individually. See [CLAUDE.md](CLAUDE.md) for details if editing with Claude Code.
