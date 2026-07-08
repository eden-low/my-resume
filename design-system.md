# EdenAtlas Design System

## Brand

- **Name**: EdenAtlas
- **Positioning**: "A personal digital atlas for memories, growth, career, and life."
- **Homepage line**: "Your life, beautifully organized."
- **Footer**: `EdenAtlas · by Jun · Version 3.0` on every page (`login.html` uses a stacked
  three-line variant of the same text as part of its v2.8 redesign).
- **Visual style**: Apple + Notion + Linear inspired — dark glassmorphism, one soft accent
  color, generous whitespace, calm typography. Not a dashboard, not a portfolio, not a game.

## Logo system (v3.0)

One canonical mark, `images/logo-mark.png` (PNG, non-square source — always rendered inside a
square `w-*`/`h-*` box with `object-contain`, never stretched) — referenced by exactly the same
path everywhere it appears, no per-page copies. A separate square asset, `images/icon-192.png`
(also used at `images/icon-512.png`), is the PWA/favicon/apple-touch-icon source — kept distinct
from the mark because a favicon needs to read at 16–32px, where the mark's finer detail would
muddy. Do not introduce a third logo asset or an SVG conversion unless the underlying artwork
changes — see [CLAUDE.md](CLAUDE.md)'s "EdenAtlas v3.0" history entry for why PNG was kept as-is.

| Context | Size | File |
|---|---|---|
| Splash screen mark | 48px | `logo-mark.png` |
| Login card mark | 64px (`w-16 h-16`) | `logo-mark.png` |
| Login post-sign-in transition mark | 56px (`w-14 h-14`) | `logo-mark.png` |
| Desktop sidebar brand mark | 32px (`w-8 h-8`) | `logo-mark.png` |
| Mobile drawer header mark | 24px (`w-6 h-6`) | `logo-mark.png` |
| Mobile top bar mark | 20px (`w-5 h-5`) | `logo-mark.png` |
| Favicon / apple-touch-icon / manifest icons | 192px / 512px | `icon-192.png` / `icon-512.png` |

Usage rules: pair the mark with the "EdenAtlas" wordmark (the existing
`bg-clip-text bg-gradient-to-r from-white to-neonPurple` gradient-text treatment) in nav
chrome (sidebar, mobile top bar, mobile drawer) and the login card; use the mark alone
(no wordmark) in tight contexts — splash screen, the login page's post-sign-in transition,
favicon/app icon. Don't add the mark to card interiors, empty states, or as decoration — it
marks *navigation and identity* moments only, never fills space.

## Removed vocabulary — do not reintroduce

RPG/hunter/level-up wording, "cyberpunk"/"hacker terminal" framing, excessive neon glow used
as an aesthetic identity, and the shield icon as a brand mark. Concretely: no "DEVELOPER MODE"
badges, no "TEAMWORK SCORE"/"RADAR MATRIX"-style gamified labels, no `fa-shield-halved` as the
logo icon, no "SYSTEM PROFILE" tagline. Charts, stats, and progress bars are fine — the *data*
can stay quantitative, only the *labels* around it should read as a professional product, not
a stat-panel from a game.

## Colors

Defined identically in every page's inline `tailwind.config` (no single source of truth yet —
keep all copies in sync manually when changing):

| Token | Hex | Use |
|---|---|---|
| `darkBg` | `#0a0a0e` | Page background |
| `cardBg` | `#17151f` | Card/panel background (used at `/90`, `/60`, `/40` opacity) |
| `borderNeon` | `#2a2833` | Hairline borders |
| `neonPurple` | `#a78bfa` | Primary accent — buttons, links, active states |
| `neonBlue` | `#6ea8fe` | Secondary accent |
| `neonViolet` | `#8b7cf0` | Gradient partner to `neonPurple` (buttons, brand mark) |
| `textGray` | `#9793ab` | Secondary/muted text |

Light mode is a functional override only (`html[data-theme="light"]` in `styles.css`), not a
second designed theme — it swaps backgrounds/text via attribute-substring selectors so every
existing `bg-cardBg`/`bg-darkBg`/`text-textGray`/`border-borderNeon` utility class gets light
values for free. Any new UI must use these exact class name prefixes to inherit that for free.

## Typography

- `font-cyber` — headings, labels, nav (`-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", sans-serif`)
- `font-code` — monospace, used for data/metadata/timestamps/badges (`ui-monospace, "SF Mono", Menlo, Consolas, "Fira Code", monospace`)
- `font-sans` — body text, the default (`-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif`)

System font stacks only — no webfont loading, ever.

## Spacing & layout

Standard Tailwind spacing scale. Conventions in practice: page containers `max-w-2xl` to
`max-w-7xl` depending on content density; card padding `p-4` (compact/mobile tiles), `p-5`
(list cards), `p-6` (section cards); vertical rhythm between sections `space-y-6`; grids use
`gap-3`–`gap-6`.

## Border radius

- `rounded-xl` — small tiles, inputs, buttons, badges
- `rounded-2xl` — cards, sections, modals — the dominant radius site-wide
- `rounded-full` — pills, avatars, toggle switches

## Card style

`bg-cardBg/90 backdrop-blur-sm p-6 rounded-2xl neon-border-purple` (`.neon-border-purple` in
`styles.css`: a 1px translucent hairline border + 18px backdrop blur + soft drop shadow — no
colored glow). Hover state on clickable cards: `hover:border-neonPurple/40 transition-all`.

## Button style

- **Primary**: `bg-gradient-to-r from-neonViolet to-neonPurple rounded-xl text-xs font-cyber
  font-bold tracking-wider text-white hover:scale-105 transition-all`
- **Secondary/outline**: `bg-cardBg/70 border border-borderNeon rounded-xl text-white
  hover:border-neonPurple transition-all`
- **Icon-only**: plain icon, `text-textGray hover:text-neonPurple`, no border/background
- **Minimum touch target**: 44×44px on any interactive element reachable on mobile (drawer
  links, bottom nav items, quick-add sheet rows) — enforced via `min-w-[44px] min-h-[44px]`.

## Form style

`bg-darkBg/60 border border-borderNeon rounded-lg px-3 py-2 text-sm text-white
placeholder:text-textGray/60`. Labels: `text-xs font-code text-textGray mb-1.5`. Radio/checkbox
groups (visibility, category) use plain native inputs with `text-xs font-code text-textGray`
labels, not custom-styled controls.

## Modal style

`fixed inset-0 z-50 flex items-center justify-center p-4` wrapping a `bg-darkBg/80
backdrop-blur-sm` backdrop and a `bg-cardBg neon-border-purple rounded-2xl p-6` panel
(`max-w-sm`–`max-w-xl` depending on form size). Close via an explicit `&times;` button, backdrop
click, and (where implemented) Escape.

## Drawer style (mobile, `js/mobile-nav.js`)

Slide-in panel from the left, `w-72 max-w-[85vw]`, same `bg-cardBg neon-border-purple` card
language as every other modal, `role="dialog"`, closes via backdrop click, the `&times;`
button, or Escape. Animates with a 0.2s `translateX` transition, disabled under
`prefers-reduced-motion`.

## Desktop navigation rules (v2.6)

- The old horizontal top-nav header is permanently hidden (`class="hidden"`, markup left in
  place rather than deleted) on every breakpoint. In its place, `js/sidebar.js` injects a fixed
  left sidebar (`hidden md:flex`, `240px` expanded / `72px` collapsed via the `--sidebar-w`
  CSS variable) — brand mark, primary nav (Home/Career/Memories/Journey/Finance/Journal/
  Calendar/People/Reports/Inbox/Settings), a secondary group (Habits/Contact — real pages that
  would otherwise become unreachable), then Profile/Logout/Collapse pinned to the bottom.
  Collapse state persists in `localStorage`; collapsing hides `.eden-sidebar-label` text and
  leaves an icon-only rail with `title=` tooltips.
- Body reflows via `padding-left: var(--sidebar-w)` (a `min-width:768px` media query in
  `styles.css`) rather than every page needing its own flex/margin layout change — this is why
  the sidebar can be a single shared module instead of a per-page markup edit.

## Mobile navigation rules

- **Below the `md` breakpoint**, both the desktop header and the sidebar are hidden in favor of:
  a fixed top bar (hamburger — brand — avatar), a fixed bottom
  nav (Home / Memories / Quick Add / People / Me), and the hamburger drawer for the full page
  list + language switcher + logout.
- **Quick Add** is a bottom-sheet action list (Add Expense / Write Journal / Upload Photo / Add
  Timeline Event / Add Habit) — each item deep-links to `{page}.html?new=1`, which auto-opens
  that page's existing "New X" modal (`canParticipate()`-gated) rather than duplicating the form.
  Never add a form here directly — always link to the real page's flow.
- Body gets `padding-top`/`padding-bottom` on mobile (`styles.css`) so the fixed bars never
  cover content — any new page must not fight this with its own conflicting padding.

## Splash screen (v3.0)

`js/splash.js` — a sixth sanctioned shared module, loaded before `js/i18n.js` on every
protected page (and on `login.html`). While `body.auth-check-pending` is present it renders a
full-viewport overlay (mark + "EdenAtlas" wordmark + a `data-i18n="splash.message"` tagline,
`"Loading your atlas…"`/`"正在打开你的数字地图…"`) appended to `<html>` directly — a sibling of
`<body>`, not a descendant, so `body.auth-check-pending`'s own `opacity:0`/`visibility:hidden`
can't hide it (same reasoning as the pre-existing `html::before` pulse mark it layers on top
of, which still fires from the very first paint with zero JS as an instant fallback). Fades out
the moment `auth-check-pending` is removed from `body` (a `MutationObserver`, not a fixed
timer — so a fast-resolving auth check never gets artificially delayed) with a 6s hard fallback
in case that class is never removed on that page (e.g. `login.html`'s session-restore path,
which navigates away instead). Skips mounting entirely if auth has already resolved by the time
the script runs — no flash, no unnecessary delay. Respects `prefers-reduced-motion`.

## Loading states (v3.0)

Prefer `.skeleton` placeholder blocks (see below) shaped roughly like the real content, written
directly into a container's *static* HTML so they're on screen immediately and are wiped for
free the moment a page's existing `replaceChildren(...)`/`innerHTML =` render call runs — no
extra loading-state JS needed. Used on Career's Experience list (pre-existing), Memories'
feed, Collections' grid, and Time Capsule's three sections. Reserve `common.loading_atlas`
("Loading your atlas…" / "正在整理你的数字地图…") for places a skeleton doesn't fit — a short
inline status line, not a full-page state (the splash screen above already owns the
full-page moment). Don't use it for small contextual loads (weather, comment panels, analytics)
that already have their own specific copy — `common.loading` remains correct there.

## Animation rules

- `.reveal` / `.reveal-group` (`styles.css` + `scripts.js`'s `IntersectionObserver`): fade +
  slide-up on scroll into view, staggered up to ~7 siblings. Disabled under
  `prefers-reduced-motion: reduce`.
- Transitions elsewhere: `transition-all` / `transition-colors`, typically 150–200ms, no bounce
  or spring easing — motion should read as calm, not playful.
- **Button press feedback (v3.0)**: any element carrying the sitewide `hover:scale-105`
  convention automatically gets a matching `:active { transform: scale(0.97) }` from a single
  attribute-substring rule in `styles.css` — no per-button markup change needed, new buttons get
  it for free just by following the existing Primary/Secondary button style below. Disabled
  under `prefers-reduced-motion: reduce`.
- **First-impression principle**: every fade/scale in this system is 150–300ms, never longer —
  motion should confirm an action already happened, not make the user wait for it.

## Icon rules

**As of v2.6, Lucide is the standard icon set going forward.** Loaded via CDN
(`unpkg.com/lucide`) on every page alongside the pre-existing Font Awesome 6 link. Font Awesome
is **not** being removed — swapping all ~327 existing references (many generated dynamically by
gallery.js/dashboard.js/etc., each needing a `lucide.createIcons()` re-render call afterward) in
one unverifiable pass was judged too risky. The rule going forward:
- **New/redesigned surfaces** (the desktop sidebar, Home, Career, Profile — everything touched in
  the v2.6 design pass) use Lucide (`<i data-lucide="icon-name">`), matching CSS sizing
  (`w-4 h-4` etc.) instead of Font Awesome's font-size-driven sizing.
- **Static** Lucide markup renders for free the moment any page-level script calls
  `window.lucide.createIcons()` — `js/sidebar.js` already does this once on load, and since
  `createIcons()` scans the whole document, it converts every static `data-lucide` element on
  the page in one call, not just its own.
- **Dynamically-rendered** Lucide icons (injected via `innerHTML`/template strings after that
  initial call) need their own follow-up `lucide.createIcons()` call — `index.html`'s Home
  render functions do this; if you add Lucide markup inside a JS template string, remember the
  re-call or the icon will render as blank text.
- Everything else keeps Font Awesome for now. Don't mix the two within the same visual row/card —
  pick one per surface, not per icon.

## i18n

- `data-i18n="namespace.key"` on any element whose `textContent` should translate;
  `data-i18n-placeholder="namespace.key"` for input placeholders. Applied by `js/i18n.js`.
- Never hardcode a duplicated translation string inside a page's own inline script — add the
  key once to `locales/en.json` and `locales/zh-CN.json` and reference it everywhere.
- Bilingual **content** (Career CMS fields like `title_en`/`title_zh`) is a different mechanism
  from `data-i18n` UI chrome — it's picked at render time by `career.js`, not by `i18n.js`.
