import { UPLIGHT } from './uplight'
import { classify } from './StationPillar'

// P8 — one expanding ring at a pillar the instant its state changes. The deck's job is to make
// the agent's work legible at a glance from across a room; without this, a station going FAULTED
// is a colour swap that a judge looking at the agent console misses entirely. The ring is the
// only thing on the deck that says "look HERE, now".
//
// One-shot, ~700ms, never a loop (Invariant 8 — the motion budget is cumulative, and this has to
// coexist with P1's packets, P2's cable flow and a genuine fault's `.voltaris-pulse` in the same
// frame). It is transient by design: it announces the change and then leaves the pillar's own
// colour to hold the state.
//
// Tone comes from `classify()` — the SAME function `StationPillar` uses to pick its own colour,
// imported rather than reimplemented. A second copy of that mapping would drift, and it would
// drift in the worst possible way: a ring in a different colour from the pillar it is drawn
// around, which reads as a bug even to someone who does not know what either colour means.
// Note this is the tone of the state the station is arriving AT, which is the point.
//
// Nothing here decides anything (Invariant 2): `useDeckTransitions` reports that fields changed,
// `classify` maps the new fields to a colour that is already on screen, and this draws a circle.

// The ring sits on the floor, so it is a flattened ellipse, not a circle — the same flatten the
// pillar's own contact shadow uses. Lesson 5 in STATUS.md is about a gradient whose shape did not
// match the shape it filled; the cheap way to never hit that again is to not introduce a circular
// shape onto a plane that is drawn in perspective in the first place.
const FLATTEN = 0.22
// World units, matching the scale the pillar's own geometry is expressed in: `PLINTH_HALF_W` is
// 48, so the ring finishes a little over twice as wide as the base it comes off. The first
// version used 34 and the render showed why that was wrong — a ring INSIDE the pillar's own
// contact-shadow ellipse does not read as a ring at all, it reads as part of the shadow.
const BASE_RADIUS = 104

export default function StatePings({ pings, snapshot, layout }) {
  if (!pings.length) return null
  return (
    <g data-layer="state-pings">
      {pings.map((ping) => {
        const pos = layout[ping.id]
        const station = snapshot.stations[ping.id]
        // A ping can outlive its station by one render if the station set changes mid-flight.
        if (!pos || !station) return null
        const tone = UPLIGHT[classify(station).halo]
        // Scaled by the pillar's own depth scale so a back-row ring is the same SIZE RELATIVE
        // TO ITS PILLAR as a front-row one, instead of being a fixed screen radius that would
        // swallow a distant station and look like a nick on a near one.
        const r = BASE_RADIUS * pos.scale
        return (
          <g key={ping.key} transform={`translate(${pos.x}, ${pos.y})`}>
            {/* The CSS transform on the inner <g> scales about its own local origin, which the
                parent's translate has already placed at the pillar's base. Two rings, the inner
                one a touch behind, so the expansion reads as a wavefront rather than as a single
                hoop growing — the difference between "something happened" and "something is
                spreading from here". */}
            <g className="voltaris-ping">
              <ellipse cx="0" cy="0" rx={r} ry={r * FLATTEN} fill="none" stroke={tone} strokeWidth={3 * pos.scale} />
            </g>
            <g className="voltaris-ping voltaris-ping-trail">
              <ellipse cx="0" cy="0" rx={r} ry={r * FLATTEN} fill="none" stroke={tone} strokeWidth={1.5 * pos.scale} />
            </g>
          </g>
        )
      })}
    </g>
  )
}
