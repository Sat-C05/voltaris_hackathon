import { memo } from 'react'
import { PALETTE } from '../../palette'

// Shared SVG `<defs>` for the pillars — nothing else. This component used to draw the
// visible grid/background too; now that only the windows and the stations should be visible,
// the grid is a separate CSS ground-plane layer (`GroundPlane.jsx`), rendered *behind* this SVG,
// and this SVG itself paints nothing of its own — no background rect, no vignette — so the
// ground plane shows through everywhere the pillars don't cover it.
//
// `heatGradient` is the one definition still needed here: `StationPillar.jsx`'s heat column
// references `url(#heatGradient)`, and an SVG `<linearGradient>` has to live in a `<defs>`
// block that's actually in the document, so it stays local to this SVG rather than moving into
// the CSS ground-plane layer (which isn't SVG at all).
//
// Wrapped in React.memo with no props — the geometry here is fully static, so it renders once
// and is skipped on every parent re-render caused by a snapshot poll.
function GridInner() {
  return (
    <defs>
      <linearGradient id="heatGradient" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0%" stopColor={PALETTE.rose} stopOpacity="0" />
        <stop offset="100%" stopColor={PALETTE.rose} stopOpacity="0.55" />
      </linearGradient>
    </defs>
  )
}

const Grid = memo(GridInner)
export default Grid
