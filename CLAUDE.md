# CLAUDE.md

Guidance for Claude Code when working in this repo. See [README.md](README.md) for the project overview.

## What this is

A static, multi-page HTML resume for Low Fang Jun, styled like a "Solo Leveling" hunter status screen (dark background, neon purple/blue glow, cyber fonts). No build tools, no JS framework, no package.json — just plain HTML/CSS files opened directly in a browser or served statically.

## Architecture

- **No shared layout/include system.** Every page (`index.html`, `status.html`, `matrix.html`, `quests.html`, `events.html`, `experience.html`, `inventory.html`) is a fully standalone HTML file that repeats the same `<head>` (fonts, Tailwind CDN, Font Awesome, `styles.css`) and the same header/nav markup.
- **Tailwind is loaded via CDN** (`cdn.tailwindcss.com`) and configured inline in a `<script>` block on every page — the same `tailwind.config` (colors, fonts) is copy-pasted into each file.
- **[styles.css](styles.css)** holds the few things Tailwind utility classes can't express directly: `.neon-border-purple`, `.neon-text-purple`/`.neon-text-blue`, `.neon-bg-purple`, `.grid-bg`, and custom scrollbar styling.
- **matrix.html** additionally loads Chart.js (`cdn.jsdelivr.net/npm/chart.js`) for the attribute/metrics charts.

## Conventions to follow when editing

- **Nav links**: every page's `<nav>` lists all 7 pages (Home, Status, Matrix, Quests, Events, Experience, Inventory). If you add a new page, add its link to the nav in **all** existing HTML files, not just the new one.
- **Color palette**: `darkBg`, `cardBg`, `borderNeon`, `neonPurple`, `neonBlue`, `neonViolet`, `textGray` — defined identically in each page's inline `tailwind.config`. Keep them in sync if the palette changes; there's no single source of truth to edit.
- **Fonts**: `font-cyber` (Orbitron, headings/labels), `font-code` (Fira Code, small tags/labels), `font-sans` (Inter, body text, default).
- **Card style**: content blocks use `bg-cardBg/90 backdrop-blur-sm p-6 rounded-2xl neon-border-purple`, often with `hover:-translate-y-1 transition-all` on clickable cards.
- **Icons**: Font Awesome 6 solid icons (`fa-solid fa-*`), colored per section (purple/blue/emerald/amber/rose) to visually distinguish categories.
- When adding a new section/page, copy the closest existing page (same head + header/nav block) as the starting template rather than writing one from scratch, to keep everything consistent.

## Keeping docs current

When adding a new page, section, or notable structural change (e.g. introducing a shared layout, a build step, or a new palette), update both [README.md](README.md) (page table / tech stack) and this file (architecture / conventions) so they stay accurate.
