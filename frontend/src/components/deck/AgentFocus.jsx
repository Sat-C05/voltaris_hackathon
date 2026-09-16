import { PALETTE } from '../../palette'
import { stationOfTarget } from '../../lib/target'

// P3: the agent becomes visible. While `snapshot.active_run` is non-null, this draws two
// concentric arc gauges at the station under investigation's own floor anchor, showing the
// run's two budgets: `steps_used/max_steps` and `actions_used/max_actions`. Mounted in
// `Deck.jsx` inside the shared `<DeckOverlay>`, alongside P1's `<UplinkBeams>` — see that file's
// own header comment: this layer is shared infrastructure, P3 was its next tenant.
//
// P14: the agent attention beam and its NOC (Network Operations Center) origin node were removed
// entirely — direct user feedback: "when an agent spawns, i dont want that agent line coming out
// of the station, remove that entirely". The node existed only as the beam's own origin (a node
// with nothing leaving it is noise), so it went too, along with the now-dead `NOC_X/Y/Z`/
// `NOC_POS` world-point constants and the beam's own dash/duration constants. The two
// bounded-autonomy gauges below are UNCHANGED — they carry the real point (the visual proof of
// bounded autonomy) and were not what the user objected to.
//
// Deliberately its own file, not folded into UplinkBeams.jsx: the whole layer still disappears
// the moment `active_run` goes null, unlike the always-present uplink beams.

// Gauge geometry, in the SAME local-unit scale StationPillar.jsx's own base decorations use
// (its component ring sits at r = w*0.62 with w = 90, i.e. r ≈ 56) — sized to read as a ring
// around the pillar's base, not an arbitrary circle. Actions renders larger/thicker: the brief
// is explicit that the actions budget is "the visual proof of bounded autonomy" and must get
// the stronger read, so it sits as the bigger, heavier, more opaque of the two concentric rings
// rather than a colour distinction (Invariant 4: one agent accent, `ice`, not a second hue).
const STEPS_R = 64
const STEPS_STROKE = 3
const STEPS_OPACITY = 0.55
const ACTIONS_R = 50
const ACTIONS_STROKE = 6
const ACTIONS_OPACITY = 0.95

// Continuous 0..1 fraction, clamped — never a step function, never a colour keyed to a
// judgement this file would be inventing (Invariant 2: render the budget, don't grade it).
function fractionOf(used, max) {
  if (!(max > 0)) return 0
  return Math.max(0, Math.min(1, used / max))
}

// One progress ring: a faint full-circle track plus a foreground arc drawn via
// `stroke-dasharray`/`stroke-dashoffset` on a plain circle (not a hand-built arc `d` path) so a
// CSS `transition` on `stroke-dashoffset` animates smoothly step to step (the brief's own
// allowance — "a CSS transition on the gauges is fine, transitions need no keyframe"). Rotated
// -90° so the empty notch starts at 12 o'clock and fills clockwise, the usual gauge reading
// direction, rather than SVG's native 3-o'clock start.
function GaugeRing({ r, strokeWidth, opacity, fraction }) {
  const circumference = 2 * Math.PI * r
  const dashOffset = circumference * (1 - fraction)
  return (
    <g transform="rotate(-90)">
      <circle r={r} fill="none" stroke={PALETTE.dim} strokeWidth={strokeWidth} opacity="0.22" />
      <circle
        r={r}
        fill="none"
        stroke={PALETTE.ice}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        opacity={opacity}
        strokeDasharray={circumference}
        strokeDashoffset={dashOffset}
        style={{ transition: 'stroke-dashoffset 400ms ease' }}
      />
    </g>
  )
}

// `snapshot`/`layout` — the same two props every other DeckOverlay tenant (UplinkBeams.jsx)
// takes; `layout` is `Deck.jsx`'s own `computeStationLayout()` map, keyed by station id.
export default function AgentFocus({ snapshot, layout }) {
  const activeRun = snapshot.active_run
  if (!activeRun) return null // Everything below disappears the instant the run does.

  // Resolve the station under investigation exactly as the brief specifies: the run's own
  // `incident_id` -> that incident's `target` -> `stationOfTarget()`. Never a second, invented
  // path (e.g. "whichever station is faulted") — a run can in principle investigate a station
  // that is not (or no longer) FAULTED.
  const incident = (snapshot.incidents ?? []).find((inc) => inc.incident_id === activeRun.incident_id)
  if (!incident) return null
  const stationId = stationOfTarget(incident.target)
  const stationLayout = layout[stationId]
  if (!stationLayout) return null // defensive: an id the current layout doesn't know about

  const { x, y, scale } = stationLayout

  const stepsFraction = fractionOf(activeRun.steps_used, activeRun.max_steps)
  const actionsFraction = fractionOf(activeRun.actions_used, activeRun.max_actions)

  // bounded-autonomy gauges: two concentric arcs at the station's own floor anchor. Steps (the
  // larger, thinner, quieter ring) outside; actions (the visual proof of bounded autonomy per
  // the brief) inside, larger stroke and opacity — the "stronger read" comes from weight, not a
  // second colour (Invariant 4). Wrapped in the same translate+scale(depthScale) shortcut every
  // other flat, camera-facing decoration on this pillar uses (see StationPillar.jsx's own `flat`
  // comment for why that is an exact projection, not an approximation, for a shape at one fixed
  // z). This is now the ONLY thing this component renders — see the P14 header comment above.
  return (
    <g transform={`translate(${x}, ${y}) scale(${scale})`}>
      <GaugeRing r={STEPS_R} strokeWidth={STEPS_STROKE} opacity={STEPS_OPACITY} fraction={stepsFraction} />
      <GaugeRing r={ACTIONS_R} strokeWidth={ACTIONS_STROKE} opacity={ACTIONS_OPACITY} fraction={actionsFraction} />
    </g>
  )
}
