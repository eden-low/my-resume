# LFJ Portfolio — Dark Glass System Dashboard

A 5-page portfolio site for **Low Fang Jun**, styled as a dark glassmorphism "system dashboard" (near-black canvas, translucent blurred cards, a single soft violet accent, Apple system fonts) — a deliberate move away from the earlier neon-cyber "hunter status" look, described further below. Built as static HTML/CSS with Tailwind CSS (via CDN) — no build step, no framework, no dependencies to install.

## Pages

| Page | File | Content |
|---|---|---|
| Home | [index.html](index.html) | Dashboard layout: identity strip, a System Status panel (live Firebase Auth session state), a live Weather widget (Kuching, OpenWeatherMap), and quick-link cards to the other pages |
| Resume | [resume.html](resume.html) | Combined resume — Profile, Matrix, Education, Leadership & Events, Work Experience, Achievements & Skills sections with a sticky in-page sub-nav |
| Gallery | [gallery.html](gallery.html) | Instagram-style feed of Firebase-backed posts — filter tabs by category/visibility; signing in as the owner reveals the Private tab and a "New Post" modal (see below) |
| Expenses | [expenses.html](expenses.html) | Personal spend tracker — daily-spending and by-category Chart.js charts, filterable list, owner-only "Add Expense" modal, same public/private model as Gallery |
| Contact | [contact.html](contact.html) | Email / phone / location, with a one-click "send message" CTA |

## Running locally

No install or build required — just open [index.html](index.html) in a browser, or serve the folder locally:

```powershell
npx serve .
```

## Tech stack

- HTML5 + [Tailwind CSS](https://tailwindcss.com/) (loaded via CDN, configured inline in each page's `<script>` block)
- [Chart.js](https://www.chartjs.org/) (loaded via CDN on `resume.html` and `expenses.html`) for charts
- [Font Awesome 6](https://fontawesome.com/) for icons
- System font stacks only — no webfont loading: `-apple-system`/SF Pro for UI text, `ui-monospace`/SF Mono for data and labels
- [Firebase](https://firebase.google.com/) (Auth, Firestore, Storage) on `gallery.html`, `expenses.html`, and the homepage's session widget, loaded as ES modules straight from `gstatic.com` — no npm install, no bundler
- [OpenWeatherMap](https://openweathermap.org/) Current Weather API for the homepage weather widget (free-tier key embedded client-side in `index.html`, same trust model as the Firebase config — see Design system below)
- Shared custom styles in [styles.css](styles.css) (glass card treatment, ambient background glow, scrollbar, hero parallax layer)
- Shared behavior in [scripts.js](scripts.js) (scroll-reveal animations + the hero mouse-parallax tilt, unused now that `index.html` is a dashboard rather than a photo hero — see Architecture in CLAUDE.md)

## Design system

The site moved from a neon-cyber "hunter status" look to a dark glassmorphism dashboard: near-black background (`#0a0a0e`), translucent blurred cards (`.neon-border-purple` in styles.css — the class name is unchanged from the old theme, only its definition), a single soft violet accent (`#a78bfa`) plus a cool blue secondary (`#6ea8fe`), and system UI/monospace fonts instead of the old Orbitron/Fira Code webfonts. Because every page reads its palette from the same token names (`darkBg`, `cardBg`, `borderNeon`, `neonPurple`, `neonBlue`, `neonViolet`, `textGray`) in its inline `tailwind.config`, the whole site was re-themed by changing those token *values* once per page rather than rewriting markup — see CLAUDE.md for the exact values to keep in sync.

## Gallery: Instagram-style feed

`gallery.html` renders a single reverse-chronological feed of post cards (image, caption, category tag, public/private badge, timestamp), not fixed category grids. [firebase-init.js](firebase-init.js) sets up the Firebase app/auth/Firestore/Storage handles (reused by any future page that needs login), and [gallery.js](gallery.js) handles sign-in, fetches `photos` Firestore docs (public always, private only when authorized), merges + sorts them client-side by `uploadedAt` (deliberately not a Firestore `orderBy`, to avoid needing a composite index), and renders them into the feed. A filter tab bar (All / Personal / Event / Work / Project / Public / Private) re-filters the already-fetched posts in memory — no extra Firestore reads per click. The Private tab and the "New Post" button/modal only appear once signed in as the owner (`jjun8647@gmail.com`, see `OWNER_EMAIL` in `firebase-init.js`); the modal uploads the file to Storage then writes the Firestore doc (now including a user-entered `caption`).

Access to private posts beyond the owner is controlled by an `allowedUsers` Firestore collection (doc ID = lowercase email) — inviting someone is just adding a document in the Firebase Console, no code changes needed. [firestore.rules](firestore.rules) and [storage.rules](storage.rules) are the source of truth for this access model; paste them into the Firebase Console's Rules tabs after any change (there's no Firebase CLI/deploy step wired up — keeping the "no build tools" philosophy).

Because posts are fetched at runtime, the feed is empty until the owner signs in and creates posts through the New Post modal.

## Expenses: personal spend tracker

`expenses.html` follows the same pattern as the gallery — [expenses.js](expenses.js) fetches `expenses` Firestore docs (public always, private only when authorized), caches them client-side, and renders a filterable list (by category, or by Public/Private) plus two Chart.js charts built from the full accessible set regardless of the active list filter: a daily-spending bar chart (last 7 days) and a by-category doughnut chart. The owner-only "Add Expense" modal writes `{ amount, category, note, visibility, createdAt, uid }` — there's no file upload here, so it only needs Firestore, not Storage. Access control mirrors the gallery exactly (owner + `allowedUsers` allowlist); the `expenses` collection rules live alongside `photos` in [firestore.rules](firestore.rules).

## Structure notes

Every page repeats the same header/nav and Tailwind theme config — there's no shared layout include, so changes to the nav or color palette need to be applied to each `.html` file individually. See [CLAUDE.md](CLAUDE.md) for details if editing with Claude Code.
