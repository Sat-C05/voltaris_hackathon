import { TAILWIND_PALETTE } from './src/palette.js'

// Palette values live in src/palette.js as CSS-var-backed strings — the raw SVG/CSS-gradient
// code that can't take a Tailwind class imports `PALETTE`
// (the plain `rgb(var(--v-x))` form) from the same file; this config uses `TAILWIND_PALETTE`
// instead, which carries the `<alpha-value>` placeholder Tailwind needs to make opacity
// modifiers like `bg-void/40` / `border-edge/70` / `bg-mint/15` work. See palette.js's own
// comment for why these are two different exports rather than one.
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: { ...TAILWIND_PALETTE },
      fontFamily: {
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
}
