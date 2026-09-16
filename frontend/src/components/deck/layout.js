// Deck geometry. Station positions are COMPUTED from whichever station ids are actually in
// the snapshot rather than hardcoded — the backend renders whatever `backend/data/worlds/*.json`
// defines, and nothing there pins the count at four. `computeStationLayout` is still the only
// place a position is decided — nothing computes it per-render inside a component.
//
// Every position below is derived from `project()`/`depthScale()` in `./projection` — the same
// pinhole projection the grid (`Grid.jsx`) draws through. There is no longer a scale fudge
// here: `layout[id].scale` IS `depthScale(z)`, not a hand-picked per-row multiplier, so a
// back-row station is smaller than a front-row one because it is genuinely further from the
// camera, not because a constant said so.
//
// `layout[id]` still comes back as `{ x, y, scale, ... }` in SCREEN (viewBox) space — that
// shape is a deliberate compatibility surface: `WindowLayer.jsx` (owned elsewhere) reads
// `layout[stationId].x/.y/.scale` to anchor leader lines via `svg.getScreenCTM()`, and must
// keep working unmodified. `z` (world depth) rides along on the same object for
// `StationPillar.jsx` and future depth-based effects (P11 haze) — extra fields are harmless to
// a caller that only destructures `{ x, y, scale }`.

import { project, depthScale, VIEWBOX_W, VIEWBOX_H, CAM_DIST, FOCAL, GRID_STEP } from './projection'

export { VIEWBOX_W, VIEWBOX_H }

// The two rows' world depth. Real placements (how far back the back row physically sits), not
// a fudge — analogous to picking where a rug ends on a real floor. Whole multiples of
// GRID_STEP so a row's stations land exactly on a grid line front-to-back as well as
// side-to-side (see snapToGrid below).
const Z_FRONT = 7 * GRID_STEP // 420
const Z_BACK = 15 * GRID_STEP // 900

// Two rows as soon as there are three stations. The back row is the smaller, further one, and
// it is what sells the perspective — a single flat row of four reads as a chart, not a place.
const MIN_FOR_TWO_ROWS = 3

// Screen-space guarantee this package must preserve (ROW_HALF_SPREAD's old purpose): the
// outermost pillar in any row never lands further out than 20% of the deck width either side
// of the vanishing point (i.e. never outside the 30%/70% band), so the floating rails never
// cover a station.
const SCREEN_HALF_SPREAD_CAP = VIEWBOX_W * 0.2 // 200

// Re-derived in WORLD units, once, from the front row's z (the row closest to the camera, and
// therefore the one where a given world-space spread produces the LARGEST screen-space
// spread). Solved from the inverse of project()'s x term
// (sx = VANISH_X + x*FOCAL/(z+CAM_DIST)) at the screen cap above, then floored to a whole
// number of grid cells so the outermost station still lands on a grid intersection instead of
// overshooting it by a fraction of a cell.
//
// Deliberately ONE constant shared by both rows, not a per-row value: real stations in a real
// lot are spaced the same physical distance apart regardless of which row they're in. The back
// row's smaller screen-space spread (the "converges toward the vanishing point" look the old
// per-row 0.65 factor hand-tuned) now falls out of the shared projection for free — the same
// world-unit spread simply covers fewer screen pixels the further back it is.
const WORLD_ROW_HALF_SPREAD =
  Math.floor((SCREEN_HALF_SPREAD_CAP * (Z_FRONT + CAM_DIST)) / FOCAL / GRID_STEP) * GRID_STEP

function snapToGrid(v) {
  return Math.round(v / GRID_STEP) * GRID_STEP
}

export function computeStationLayout(stationIds) {
  const ids = [...stationIds].sort()
  const n = ids.length
  const rows = n < MIN_FOR_TWO_ROWS
    ? [{ ids, z: Z_FRONT }] // one or two stations: a single front row, full scale
    : (() => {
        // Back row gets the smaller half, so an odd count puts the extra station in the front
        // row, where there is more effective screen width to spend.
        const backCount = Math.floor(n / 2)
        return [
          { ids: ids.slice(0, backCount), z: Z_BACK },
          { ids: ids.slice(backCount), z: Z_FRONT },
        ]
      })()

  const layout = {}
  for (const { ids: rowIds, z } of rows) {
    // P0c: both rows share the SAME world half-spread — no per-row factor. Real stations in a
    // real lot are spaced the same physical distance apart regardless of row; the back row
    // reads as narrower purely because it is further from the camera (same 240-unit spread
    // projects to a 373px front-row gap vs. 224px at the back, still clearly perspective, with
    // no fudge). `WORLD_ROW_HALF_SPREAD` is already floored to a whole GRID_STEP (see above),
    // which is the tie-safe snapping this package keeps.
    const half = rowIds.length <= 1 ? 0 : WORLD_ROW_HALF_SPREAD
    const m = rowIds.length
    const scale = depthScale(z)
    rowIds.forEach((id, i) => {
      const t = m === 1 ? 0 : (i / (m - 1)) * 2 - 1 // -1..1
      // Snap to a grid intersection, then clamp back inside the guaranteed band — snapping an
      // interior point can round it a half-cell outward, but the two endpoints (t = -1/+1) are
      // already exactly `half`, itself grid-aligned, so the clamp only ever affects roundoff,
      // never the intended spread.
      const worldX = Math.max(-half, Math.min(half, snapToGrid(t * half)))
      const [x, y] = project(worldX, 0, z)
      layout[id] = { x, y, scale, z, worldX }
    })
  }
  return layout
}
