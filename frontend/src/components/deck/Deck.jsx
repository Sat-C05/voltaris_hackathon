import { useMemo, useRef } from 'react'
import Grid from './Grid'
import StationPillar from './StationPillar'
import DeckOverlay from './DeckOverlay'
import UplinkBeams from './UplinkBeams'
import AgentFocus from './AgentFocus'
import StatePings from './StatePings'
import Verdict from './Verdict'
import BootSequence from './BootSequence'
import WindowLayer from './windows/WindowLayer'
import { computeStationLayout, VIEWBOX_W, VIEWBOX_H } from './layout'
import { stationOfTarget } from '../../lib/target'
import { useDeckTransitions } from '../../useDeckTransitions'

// The Deck: static grid + data-driven pillars + the window layer. Renders strictly from
// `snapshot` alone. `selectedId`/`focusIncident`/`hoveredId` all live in DeckApp, one
// level up — `hoveredId` lives there because the hover card it drives
// renders inside `RightRail`, a sibling of this component, not inside this component itself.
export default function Deck({ snapshot, selectedId, onSelect, focusIncident, focusReplay, hoveredId, onHover, onLeave }) {
  // The window layer needs the container's box to clamp a drag, and the SVG's screen matrix
  // (`getScreenCTM()`) to draw a leader line from a window to a pillar.
  const svgRef = useRef(null)
  const containerRef = useRef(null)

  // P8/P6 — the only things on the deck driven by the DIFFERENCE between two snapshots rather
  // than by one. Called before the `!snapshot` early return below, because hooks cannot be
  // conditional; the hook's own first statement is a `!snapshot` guard.
  const { pings, verdicts } = useDeckTransitions(snapshot)

  // Station positions are computed from whichever ids are actually in the snapshot, never
  // hardcoded, memoized on the sorted id list so a
  // temperature-only poll doesn't recompute it.
  const stationIdsKey = snapshot ? Object.keys(snapshot.stations).sort().join(',') : ''
  const layout = useMemo(
    () => computeStationLayout(stationIdsKey ? stationIdsKey.split(',') : []),
    [stationIdsKey],
  )

  // P12: the pre-first-snapshot state. A FALLBACK, never a splash — the moment `snapshot` is
  // non-null this branch is not taken and the real deck renders, mid-boot-animation if that is
  // when the poll lands. `BootSequence` holds no timer and no state precisely so it cannot ever
  // become a delay. The old text here was a single grey `WAITING FOR WORLD SNAPSHOT…`, which
  // read as a page that had failed to load.
  if (!snapshot) return <BootSequence />

  const pendingFaultByStation = {}
  for (const f of snapshot.faults ?? []) {
    if (!f.applied) pendingFaultByStation[stationOfTarget(f.target)] = true
  }

  return (
    <div ref={containerRef} className="relative h-full w-full" onClick={() => onSelect(null)}>
      {/* The floor grid used to be a separate CSS 3D layer behind this SVG (`GroundPlane.jsx`,
          now retired) because the stations were in a different, incompatible projection. Now
          both the grid (`Grid.jsx`) and the pillars (`StationPillar.jsx`) are driven by the
          same JS `project()` (`./projection`) and drawn directly in this one, untransformed
          SVG — see projection.js and layout.js. The SVG itself carries no 3D transform, which
          is what keeps `svg.getScreenCTM()` (WindowLayer's leader lines) a valid 2D matrix. */}
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

        {/* Shared scene overlay: painted after the pillars, still inside this same
            untransformed, `project()`-driven SVG (Invariant 6). P1's uplink beams are the first
            tenant of this shared layer — see DeckOverlay.jsx. P3's agent attention beam +
            bounded-autonomy gauges (AgentFocus.jsx) are the next: painted after the uplink
            beams so the agent's own beam/gauges sit on top of the ambient network beams when
            the two ever overlap on screen. */}
        <DeckOverlay>
          <UplinkBeams snapshot={snapshot} layout={layout} />
          <AgentFocus snapshot={snapshot} layout={layout} />
          {/* P8 then P6, last in the layer and in that order: a state-change ping is ambient
              punctuation, a verdict is the end of the story, so when a run's final ACT and its
              RESOLVED land in the same 500ms poll the verdict paints over the ping rather than
              under it. Both are transient — they render nothing at all when nothing changed. */}
          <StatePings pings={pings} snapshot={snapshot} layout={layout} />
          <Verdict verdicts={verdicts} layout={layout} />
        </DeckOverlay>
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
