// P14: the left rail's screen geometry, in ONE place — imported by BOTH `LeftRail.jsx` (to
// position itself) and `deck/windows/layout.js` (to exclude the area from `tileWindows`). Before
// this module, the exclusion zone was a hand-copied `{x:0,y:0,w:300,h:420}` inside layout.js
// while the rail itself was pinned `absolute left-4 top-4` in LeftRail.jsx — two numbers that
// happened to describe the same box, kept in sync only by nobody moving either one. The moment
// the rail moves (this package), a copy left behind tiles windows straight into it. Both files
// now read the SAME functions below, so they can't drift.
//
// `LeftRail` and `Deck`'s own window-layer container (`containerRef` in Deck.jsx) are both
// direct, same-sized children of DeckApp's `relative min-h-0 flex-1` wrapper — `LeftRail` is
// `absolute` inside it, `Deck`'s container is `relative h-full w-full` inside it. A `top`
// percentage on LeftRail and a fraction of `boxH` passed to `tileWindows` therefore address the
// exact same box with no unit conversion.

// Generous overestimates of each rail's own rendered footprint (width/inset, and how tall an
// accordion section's content can get), unchanged in value from the old hand-copied constants —
// only WHERE the left one's box sits changes in this package, not its size.
export const RAIL_ZONE_WIDTH = 300
export const LEFT_RAIL_ZONE_HEIGHT = 420
export const RIGHT_RAIL_ZONE_HEIGHT = 420

// Left rail's vertical anchor, as a fraction of the deck box's own height (never a pixel value —
// every other scripted placement in this codebase, `windows/layout.js`'s own `ANCHORS`, does the
// same, so it scales with viewport instead of being tuned for one resolution). It is the CENTRE
// of the rail's box, not its top edge: `LeftRail.jsx` pairs `top: <fraction>%` with a
// `-translate-y-1/2`, which centres the panel on this line regardless of how tall its content
// currently is (accordion open/closed) — a plain top-edge fraction would visually "centre" only
// for one particular content height. The exclusion zone below centres `LEFT_RAIL_ZONE_HEIGHT` on
// the same line for the same reason.
//
// Idle: dead centre of the deck (0.5) — the user asked for the operator tools (FAULT INJECTION,
// the default-open section) at "left-middle" rather than pinned to the top-left corner.
//
// Shifted (an incident exists): nudged DOWN by SHIFT_FRACTION, not to the bottom — "only
// slightly... to give space for the incident and the agent windows". 0.10 sits in the middle of
// the brief's ~8-12% guidance.
export const LEFT_RAIL_IDLE_CENTER_FRACTION = 0.5
const IDLE_CENTER_FRACTION = LEFT_RAIL_IDLE_CENTER_FRACTION
const SHIFT_FRACTION = 0.10

export function leftRailTopFraction(hasIncident) {
  return hasIncident ? IDLE_CENTER_FRACTION + SHIFT_FRACTION : IDLE_CENTER_FRACTION
}

// The same displacement `leftRailTopFraction` expresses, but as PIXELS relative to the idle
// centre line — which is what `LeftRail.jsx` needs to render the shift as a `transform` rather
// than as an animated `top`.
//
// Why it changed (P14b): animating `top` moves an element by re-running LAYOUT on every frame,
// and `.voltaris-panel` carries `backdrop-filter: blur(10px)` — so each of those frames also
// re-samples and re-blurs everything behind the rail (the deck, the grid, the pillars, the
// packets already animating on the beams). That is the most expensive thing on the page to
// redo 30 times during one 500ms glide, and it showed: the rail stepped down instead of
// gliding. A `transform` is composited — it never touches layout and never invalidates the
// backdrop — so the same movement costs nothing. The GEOMETRY is deliberately unchanged:
//
//     idle centre (top: 50%)  +  leftRailShiftPx(boxH, hasIncident)
//       === leftRailTopFraction(hasIncident) * boxH
//
// by construction, so `railZones()` below still describes exactly where the rail draws itself
// and the tiler cannot drift from it. That identity is the whole point of this module — if you
// ever change one of these two functions, change the other in the same edit.
export function leftRailShiftPx(boxH, hasIncident) {
  return (leftRailTopFraction(hasIncident) - IDLE_CENTER_FRACTION) * boxH
}

// The rail's glide, kept here beside the geometry rather than as Tailwind classes in
// `LeftRail.jsx`, because the numbers are a choreography decision shared with the window layer,
// not styling: `deck/windows/Window.jsx` glides a re-tiled window over **220ms ease-out**, and
// the rail moves in response to the SAME snapshot that causes that re-tile. Two uncoordinated
// curves on screen at once is what reads as amateur.
//
// - 420ms, not 500: long enough for ~10% of the deck's height to read as a deliberate move,
//   short enough that it is settled before a judge's eye leaves it.
// - `cubic-bezier(0.32, 0.72, 0, 1)` — leaves immediately and decelerates long into rest. A
//   plain `ease-out` starts too gently for a panel this heavy; this curve commits, which is
//   what makes the move look intentional rather than dragged.
// - Asymmetric delay, and this is the part that matters. Going DOWN (an incident just opened)
//   the rail must lead: it is vacating space the incident and agent windows are about to be
//   tiled into, so it starts on the same frame they do. Coming back UP (the world was reset,
//   incidents gone) those windows are closing, so the rail waits RETURN_DELAY_MS for them to
//   clear before reclaiming the centre — otherwise both move through each other at once and
//   the screen looks like it is merely reflowing, not responding.
export const LEFT_RAIL_GLIDE_MS = 420
export const LEFT_RAIL_GLIDE_EASING = 'cubic-bezier(0.32, 0.72, 0, 1)'
export const LEFT_RAIL_RETURN_DELAY_MS = 200

// Both rail zones as rects in the deck box's own pixel space — the left one tracking
// `leftRailTopFraction` exactly (so it can never drift from where `LeftRail.jsx` actually draws
// itself), the right one unconditional at the top (the right rail does not move in this
// package). `hasIncident` mirrors the same `snapshot.incidents` non-empty check `LeftRail.jsx`
// uses to choose its own position.
export function railZones(boxW, boxH, hasIncident) {
  const leftCenterY = leftRailTopFraction(hasIncident) * boxH
  // Clamp so a very short box can't push the zone's top edge negative — harmless either way
  // (an exclusion rect extending past the box does no damage, `tileWindows` only ever scans
  // inside the box margin), but a plain, sane rect is easier to reason about in a test failure.
  const leftY = Math.max(0, leftCenterY - LEFT_RAIL_ZONE_HEIGHT / 2)
  return [
    { x: 0, y: leftY, w: RAIL_ZONE_WIDTH, h: LEFT_RAIL_ZONE_HEIGHT }, // left rail
    { x: boxW - RAIL_ZONE_WIDTH, y: 0, w: RAIL_ZONE_WIDTH, h: RIGHT_RAIL_ZONE_HEIGHT }, // right rail
  ]
}

// How tall an OPEN accordion section's scroll area may get, derived from the deck box rather
// than hardcoded. It was a flat `max-h-[320px]` in `LeftRail.jsx`; the headless render
// (`render-html-preview.sh`) measured the FAULT INJECTION panel's natural content at **430px**,
// so the flat cap was cutting the INJECT button — the panel's whole point — in half, behind a
// scrollbar nobody looks for on a panel that appears complete. (Measured siblings: SCENARIOS
// 220px with an empty golden-run table, WORLD CONTROL 110px. Only the fault panel overflowed.)
//
// The cap cannot just become 460 either: the rail is CENTRED on `leftRailTopFraction`, so it
// grows from both edges at once, and the binding constraint is the room below it in its shifted
// position — `(1 - 0.6) * boxH`. Hence:
//
//     half the rail's total height  <=  0.4 * boxH
//     (cap + CHROME) / 2            <=  0.4 * boxH
//     cap                           <=  0.8 * boxH - CHROME
//
// CHROME is everything in the rail that is NOT the open section's content: the three section
// headers, the permanent STATION KEY strip (P9's `Legend`) and the paddings. **It is MEASURED,
// not estimated** — `PROBE=1 ./frontend_fiels/render-html-preview.sh` reports it as `chrome` on
// each frame. The first value here was a guess of 105 and, once the legend landed, the real
// figure was 260: the centred rail rendered 750px tall in a 900px box and clipped its own last
// legend row off the bottom. If you add anything permanent to this rail, re-run that probe and
// put the number it prints here.
//
// Below roughly a 500px-tall deck box the MIN clamp wins and the rail can overflow slightly.
// That is deliberate: a section shorter than MIN is unusable whether it fits or not, and 500 is
// far below the realistic floor already documented for the window tiler (~720). The result
// is clamped: never below MIN (a section shorter than that is unusable, scroll or not), never
// above MAX (past the tallest panel's natural height there is nothing left to reveal).
const SECTION_CHROME_PX = 260
const SECTION_MIN_PX = 200
const SECTION_MAX_PX = 460

export function leftRailSectionMaxHeight(boxH) {
  if (!boxH) return SECTION_MIN_PX
  return Math.round(Math.min(SECTION_MAX_PX, Math.max(SECTION_MIN_PX, 0.8 * boxH - SECTION_CHROME_PX)))
}
