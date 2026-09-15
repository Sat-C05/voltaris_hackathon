// Deck geometry. The viewBox and vanishing point are fixed; station
// positions are now COMPUTED from whichever station ids are actually in the snapshot rather
// than hardcoded — the backend renders whatever `backend/data/worlds/*.json` defines, and nothing
// there pins the count at four). `computeStationLayout` is still the only place a position is
// decided — nothing computes it per-render inside a component.

export const VIEWBOX_W = 1000
export const VIEWBOX_H = 600

// The floor's vanishing point, ~38% down the viewport.
export const VANISH_X = VIEWBOX_W / 2
export const VANISH_Y = VIEWBOX_H * 0.38

// Scaled to roughly two-thirds of the original pillar size, which was too big for the deck.
// Applied as a flat multiplier on both rows' original
// scale so the two-thirds reduction is uniform front and back.
const PILLAR_SCALE = 0.67
const FRONT_SCALE = 1.0 * PILLAR_SCALE
const BACK_SCALE = 0.82 * PILLAR_SCALE

// Half the horizontal spread of a row, before the back-row convergence factor narrows it.
//
// Capped at 200 (= 20% of VIEWBOX_W) so the outermost pillar in any row lands at 30%/70% of
// the deck and never further out — this is what guarantees the floating rails never cover a
// station. A row of more stations packs tighter inside that band rather than growing past it.
// Corrected during review: the first version widened with the station count
// (`200 + 70 * (n - 2)`), which put a four-across row at 19%/81% — under both rails.
const ROW_HALF_SPREAD = 200

// Two rows as soon as there are three stations. The back row is the smaller, further one, and
// it is what sells the perspective — a single flat row of four reads as a chart, not a place.
// Corrected during review: the first version put everything up to four stations in one row,
// which silently replaced the intended hand-placed 2x2.
const MIN_FOR_TWO_ROWS = 3

export function computeStationLayout(stationIds) {
  const ids = [...stationIds].sort()
  const n = ids.length
  const rows = n < MIN_FOR_TWO_ROWS
    ? [{ ids, depthT: 1 }] // one or two stations: a single front row, full scale
    : (() => {
        // Back row gets the smaller half, so an odd count puts the extra station in the front
        // row, where there is more width to spend and where it reads larger.
        const backCount = Math.floor(n / 2)
        return [
          { ids: ids.slice(0, backCount), depthT: 0 },
          { ids: ids.slice(backCount), depthT: 1 },
        ]
      })()

  const layout = {}
  for (const { ids: rowIds, depthT } of rows) {
    const y = 330 + depthT * 150 // 330 (back) -> 480 (front): the original hand-placed anchors
    const scale = BACK_SCALE + depthT * (FRONT_SCALE - BACK_SCALE)
    // 0.65 at the back, 1.0 at the front: the back row converges toward the vanishing point.
    const half = (rowIds.length <= 1 ? 0 : ROW_HALF_SPREAD) * (0.65 + 0.35 * depthT)
    const m = rowIds.length
    rowIds.forEach((id, i) => {
      const t = m === 1 ? 0 : (i / (m - 1)) * 2 - 1 // -1..1
      layout[id] = { x: VANISH_X + t * half, y, scale }
    })
  }
  return layout
}
