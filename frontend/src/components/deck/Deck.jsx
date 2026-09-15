import { useMemo, useRef } from 'react'
import Grid from './Grid'
import GroundPlane from './GroundPlane'
import StationPillar from './StationPillar'
import WindowLayer from './windows/WindowLayer'
import { computeStationLayout, VIEWBOX_W, VIEWBOX_H } from './layout'
import { stationOfTarget } from '../../lib/target'

// The Deck: static grid + data-driven pillars + the window layer. Renders strictly from
// `snapshot` alone. `selectedId`/`focusIncident`/`hoveredId` all live in DeckApp, one
// level up — `hoveredId` lives there because the hover card it drives
// renders inside `RightRail`, a sibling of this component, not inside this component itself.
export default function Deck({ snapshot, selectedId, onSelect, focusIncident, focusReplay, hoveredId, onHover, onLeave }) {
  // The window layer needs the container's box to clamp a drag, and the SVG's screen matrix
  // (`getScreenCTM()`) to draw a leader line from a window to a pillar.
  const svgRef = useRef(null)
  const containerRef = useRef(null)

  // Station positions are computed from whichever ids are actually in the snapshot, never
  // hardcoded, memoized on the sorted id list so a
  // temperature-only poll doesn't recompute it.
  const stationIdsKey = snapshot ? Object.keys(snapshot.stations).sort().join(',') : ''
  const layout = useMemo(
    () => computeStationLayout(stationIdsKey ? stationIdsKey.split(',') : []),
    [stationIdsKey],
  )

  if (!snapshot) {
    return (
      <div className="flex h-full w-full items-center justify-center text-dim text-xs tracking-widest">
        WAITING FOR WORLD SNAPSHOT…
      </div>
    )
  }

  const pendingFaultByStation = {}
  for (const f of snapshot.faults ?? []) {
    if (!f.applied) pendingFaultByStation[stationOfTarget(f.target)] = true
  }

  return (
    <div ref={containerRef} className="relative h-full w-full" onClick={() => onSelect(null)}>
      {/* The ground plane is a separate, purely decorative CSS layer BEHIND the station SVG —
          see GroundPlane.jsx for why (leader lines depend on `getScreenCTM()`, a 2D matrix, so
          the stations themselves must stay in an untransformed SVG). `relative` on the SVG
          below is load-bearing, not decoration: without it, this in-flow SVG would paint ABOVE
          the absolutely-positioned ground plane regardless of DOM order (CSS's stacking rules
          paint non-positioned in-flow content before z-index:auto positioned content) — making
          both elements "positioned" is what makes DOM order (ground plane first) the tiebreak. */}
      <GroundPlane />
      <svg
        ref={svgRef}
        viewBox={`0 0 ${VIEWBOX_W} ${VIEWBOX_H}`}
        preserveAspectRatio="xMidYMid slice"
        className="relative h-full w-full"
      >
        <Grid />
        <g>
          {Object.keys(layout).sort().map((id) => (
            <StationPillar
              key={id}
              id={id}
              station={snapshot.stations[id]}
              layout={layout[id]}
              selected={selectedId === id}
              dimmed={selectedId !== null && selectedId !== id}
              faultPending={!!pendingFaultByStation[id]}
              onHover={onHover}
              onLeave={() => onLeave(id)}
              onClick={(clickedId) => onSelect(selectedId === clickedId ? null : clickedId)}
            />
          ))}
        </g>
      </svg>

      {/* The hover card used to float here as an absolutely-positioned overlay; it now renders
          in flow at the bottom of RightRail's own column (see RightRail.jsx
          for why: a fixed-height overlay here meant permanently shrinking the incident list and
          event ticker to leave it room even while nothing was hovered). The pillar itself still
          highlights on hover, so the link to the station is not lost. */}

      <WindowLayer snapshot={snapshot} svgRef={svgRef} containerRef={containerRef} layout={layout} focusIncident={focusIncident} focusReplay={focusReplay} />
    </div>
  )
}
