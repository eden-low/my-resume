// EdenAtlas — single source of truth for Tailwind tokens.
//
// Replaces the per-page inline `tailwind.config = {...}` blocks the Tailwind Play CDN
// (cdn.tailwindcss.com) used to read at runtime on 24 pages. Every value below was copied
// verbatim from that shared config (byte-identical across all 24 pages except for
// whitespace/formatting — see the Phase 2 migration audit) — token names, capitalization, and
// hex/font-stack values are unchanged so every existing `bg-darkBg`/`font-cyber`/etc. utility
// class already in page markup keeps resolving to the exact same value.
//
// No darkMode key: the site never uses Tailwind's `dark:` variant — light/dark is implemented
// entirely via `html[data-theme="light"]` overrides in styles.css. No plugins, no safelist: the
// migration audit found zero unsafe computed-class patterns anywhere in the codebase.
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./*.html",
    "./*.js",
    "./js/**/*.js",
    "!./js/**/__tests__/**",
  ],
  theme: {
    extend: {
      colors: {
        darkBg: '#0a0a0e',
        cardBg: '#17151f',
        borderNeon: '#2a2833',
        neonPurple: '#a78bfa',
        neonBlue: '#6ea8fe',
        neonViolet: '#8b7cf0',
        textGray: '#9793ab',
      },
      fontFamily: {
        cyber: ['-apple-system', 'BlinkMacSystemFont', '"SF Pro Display"', '"Segoe UI"', 'sans-serif'],
        code: ['ui-monospace', '"SF Mono"', 'Menlo', 'Consolas', '"Fira Code"', 'monospace'],
        sans: ['-apple-system', 'BlinkMacSystemFont', '"SF Pro Text"', '"Segoe UI"', 'Roboto', 'sans-serif'],
      }
    }
  }
}
