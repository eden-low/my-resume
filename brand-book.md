# EdenAtlas Brand Book

New in v3.0 ("Identity & Motion"). High-level identity decisions live here; component-level
implementation (exact classes, CSS, page conventions) stays in [design-system.md](design-system.md) —
this file should stay short enough to read in one sitting.

## Who we are

**EdenAtlas** — a personal digital atlas for memories, growth, career, and life. Built by Jun,
now genuinely multi-tenant (Owner, Friends, Viewers each get their own private space). Not a
dashboard, not a portfolio site, not a game — a calm, personal system someone would actually
want to open every day.

## Tagline

- **Primary** (login page, homepage): "Your life, beautifully organized." /
  "把生活、回忆与成长，安静地整理在一起。"
- **Longer form** (about/positioning copy, not UI chrome): "A personal digital atlas for
  memories, growth, and every chapter of life." / "一个属于你的数字人生地图，记录回忆、成长与每个章节。"

## Voice

Warm, plain, quietly confident. Never RPG/gamified ("quest," "level up," "loot"), never
cyberpunk/hacker-terminal, never corporate-dashboard cold. Empty states read like a person
wrote them, not a system message — see `design-system.md`'s "Removed vocabulary" list for the
specific words to never reintroduce.

## Logo

One mark, `images/logo-mark.png`, always inside a square box with `object-contain`. Paired with
the "EdenAtlas" wordmark in navigation chrome; alone in tight/branding-only moments (splash
screen, favicon, login transition). Never stretched, never recolored, never used as a repeating
pattern or watermark. Full size/context table in `design-system.md`'s Logo system section.

## Color, in one line

Dark glassmorphism canvas (`#0a0a0e`), one soft violet accent (`#a78bfa`/`#8b7cf0`), no other
"brand color" — see `design-system.md` for the full token table and light-mode behavior.

## First impression principles (v3.0)

1. **Never a blank page.** Every protected page shows a branded splash (mark + wordmark +
   tagline) for however long auth resolution actually takes — never longer, never padded.
2. **Motion confirms, it doesn't decorate.** 150–300ms fades/scales on things that already
   happened (a card appearing, a button pressed, a modal opening) — never a spinner-for-its-own-
   sake, never bounce/spring easing.
3. **One brand, everywhere.** Same mark, same tagline, same footer line
   (`EdenAtlas · by Jun · Version 3.0`), same empty-state warmth, whether you're on Home or four
   clicks deep in Career.
4. **Quiet by default.** The logo, the splash, the accent color all get *one* moment per screen,
   not several — see `design-system.md`'s "don't overuse the logo" guidance.

## Version

Current: **3.0**. Bump the footer line (`footer.line` / `login.footer_line` in both locale
files, plus every page's static fallback text) together, never partially.
