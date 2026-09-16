// Shared scene-layer overlay — an SVG <g> painted after the pillars and before `WindowLayer`
// (see `Deck.jsx`, which mounts this between the pillar `<g>` and the closing `</svg>`, still
// inside the one untransformed, `project()`-driven station SVG — see `projection.js`'s comment
// on why the SVG itself must stay untransformed for `WindowLayer`'s leader lines to keep
// working via `svg.getScreenCTM()`).
//
// This is shared infrastructure, not uplink-specific: P1 (uplink beams) is the first tenant,
// P3 (agent attention beam), P6 (verdict rings) and P8 (state-change pings) are later tenants
// of this same layer. Keep this file a plain, generic wrapper — no uplink-specific markup or
// logic belongs here, only the shared paint order and the shared `pointer-events: none` so a
// scene-level effect can never steal a click from a pillar underneath it (pillars still handle
// their own hover/click directly; this layer is decoration only).
export default function DeckOverlay({ children }) {
  return (
    <g style={{ pointerEvents: 'none' }} data-layer="deck-overlay">
      {children}
    </g>
  )
}
