# LFJ Resume — Solo Leveling Style

An interactive, multi-page resume for **Low Fang Jun**, styled after the "Solo Leveling" hunter status UI (neon purple/blue, cyber fonts, grid background). Built as static HTML/CSS with Tailwind CSS (via CDN) — no build step, no framework, no dependencies to install.

## Pages

| Page | File | Content |
|---|---|---|
| Home | [index.html](index.html) | Landing page with cards linking to every section |
| Status | [status.html](status.html) | Profile, contact info, education, skills |
| Matrix | [matrix.html](matrix.html) | Leadership metrics and core attributes |
| Quests | [quests.html](quests.html) | Academic quests, projects, achievements |
| Events | [events.html](events.html) | Event organization and leadership records |
| Experience | [experience.html](experience.html) | Work experience, role by role |
| Inventory | [inventory.html](inventory.html) | Awards, certifications, skill inventory |

## Running locally

No install or build required — just open [index.html](index.html) in a browser, or serve the folder locally:

```powershell
npx serve .
```

## Tech stack

- HTML5 + [Tailwind CSS](https://tailwindcss.com/) (loaded via CDN, configured inline in each page's `<script>` block)
- [Font Awesome 6](https://fontawesome.com/) for icons
- Google Fonts: Orbitron (cyber headings), Fira Code (code/labels), Inter (body text)
- Shared custom styles in [styles.css](styles.css) (neon borders/glow, grid background, scrollbar)

## Structure notes

Every page repeats the same header/nav and Tailwind theme config — there's no shared layout include, so changes to the nav or color palette need to be applied to each `.html` file individually. See [CLAUDE.md](CLAUDE.md) for details if editing with Claude Code.
