// Single source for the palette. The actual colour VALUES live in `index.css` as CSS custom
// properties (`--v-*`), one set under `:root` (light) and one under `:root[data-theme="dark"]`
// / `@media (prefers-color-scheme: dark)` (dark) — see index.css. This file only maps each
// token NAME to the CSS var that carries it, in two forms:
//
//   PALETTE          — `rgb(var(--v-x))`, a directly-resolvable colour. This is what every
//                       raw-SVG `fill`/`stroke` attribute and CSS `background-image` gradient
//                       stop (Grid.jsx's heatGradient, StationPillar.jsx, uplight.js) imports —
//                       those sites apply opacity themselves via a separate `opacity`/
//                       `stopOpacity` attribute, so the colour string itself must be a plain,
//                       already-valid colour, never a Tailwind template string.
//   TAILWIND_PALETTE — `rgb(var(--v-x) / <alpha-value>)`, consumed ONLY by tailwind.config.js.
//                       Tailwind textually substitutes `<alpha-value>` when a class uses an
//                       opacity modifier (`bg-void/40`, `border-edge/70`, `bg-mint/15`) and
//                       drops it to `1` otherwise — that substitution only happens inside
//                       Tailwind's own class-generation pipeline. Using this form directly in a
//                       raw SVG attribute would emit the literal text "<alpha-value>", which is
//                       not a valid colour — hence the two separate exports.
//
// Switching CSS variables (rather than a JS theme object) is load-bearing, not a style choice:
// `StationPillar` is wrapped in `React.memo` with a `signature()` comparator that does not
// include a theme value, so a JS-object
// theme would need every pillar's memo comparator to also depend on the theme, or toggling
// would silently not repaint any pillar. A CSS variable needs no re-render at all: the browser
// repaints wherever the variable is used the instant `data-theme` changes on `<html>`.
//
// Token NAMES are unchanged from the original dark table — only the values moved to CSS and
// gained a light twin. Tokens added later (previously
// hardcoded hex at their call sites) are grouped at the bottom, same pattern.
const TOKEN_VARS = {
  void: 'void', // page ground — warm off-white parchment (light) / warm near-black (dark)
  deck: 'deck', // window/card surface — a shade brighter than the page in both themes
  grid: 'grid', // grid line "at rest" — warm graphite-tan (light) / warm graphite (dark)
  edge: 'edge', // UI chrome hairlines/borders
  ink: 'ink', // strong linework/text drawn directly in SVG — inverts light<->dark with the theme
  ice: 'ice', // primary accent — agent activity, leader lines, selection
  mint: 'mint', // healthy / AVAILABLE / VERIFIED
  amber: 'amber', // DEGRADED / warning / escalation
  rose: 'rose', // FAILED / FAULTED / policy rejection
  violet: 'violet', // harness / scenario chrome
  dim: 'dim', // secondary text / labels

  // Previously raw hex in uplight.js — the five-state station vocabulary's two non-token shades.
  amberDesat: 'amber-desat', // degraded component / uplink down — amber muted toward `dim`
  isolated: 'isolated', // taken out of service by the agent — deliberately blue, not rose

  // Previously raw hex in StationPillar.jsx — the pillar's own material shades (paper-white
  // cabinet faces in light mode; these need a dark counterpart or the cabinet reads as a white
  // block sitting on a dark ground).
  panelLight: 'panel-light', // cabinet/head side face, non-hold
  panelLighter: 'panel-lighter', // plinth side/top + head cap face, non-hold (lightest of the three)
  holdPanel: 'hold-panel', // cabinet/head front face while `maintenance_hold`
  holdPanelDark: 'hold-panel-dark', // plinth front + cabinet/head side face while `maintenance_hold`
  holdPanelDarker: 'hold-panel-darker', // plinth side/top + head cap while `maintenance_hold`
  uplinkIdle: 'uplink-idle', // uplink arc stroke when the link is up (not a status colour)
}

export const PALETTE = Object.fromEntries(
  Object.entries(TOKEN_VARS).map(([key, cssVar]) => [key, `rgb(var(--v-${cssVar}))`]),
)

export const TAILWIND_PALETTE = Object.fromEntries(
  Object.entries(TOKEN_VARS).map(([key, cssVar]) => [key, `rgb(var(--v-${cssVar}) / <alpha-value>)`]),
)
