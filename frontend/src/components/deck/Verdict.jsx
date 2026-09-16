import { PALETTE } from '../../palette'
import { PHASE } from '../../lib/phase'
import { uplinkAnchor } from './StationPillar'

// P6 — the verdict moment. A run reaching terminal used to change nothing on the deck: the
// incident window's status text flipped and that was the whole beat. For a demo whose entire
// claim is "an agent resolved this on its own", the moment it finishes is the moment, and it was
// passing unmarked. This gives it one, under 900ms, at the station it happened to.
//
// It renders `incident.status` and nothing else (Invariant 2). The frontend does not decide that
// a run went well — the backend writes RESOLVED, ESCALATED or FAILED and this looks up a shape
// for the word. The three words come from `lib/phase.js`'s `PHASE`, whose values are the
// backend's own `TERMINAL_STATUSES` strings by frozen agreement (see STATUS.md); that is why
// this file imports them rather than typing "RESOLVED" three times.
//
// Fires once per incident, on the EDGE into terminal — see `useDeckTransitions`. A re-poll,
// and a page reload, must never replay it.

// Deliberately NOT a fourth invented colour each: each verdict borrows the tone the rest of the
// UI already uses for that word (`StatusBar`'s terminal segment, the incident window's header),
// so the ring and the text agree without anyone maintaining a second table.
const VERDICT = {
  [PHASE.RESOLVED]: { tone: PALETTE.mint },
  [PHASE.ESCALATED]: { tone: PALETTE.amber },
  [PHASE.FAILED]: { tone: PALETTE.rose },
}

const FLATTEN = 0.22
// Larger than P8's ping (104) on purpose: same visual family, one size up, so a verdict reads as
// the conclusion of the changes the pings were announcing rather than as one more of them.
const BASE_RADIUS = 148

// The escalation mark: hazard chevrons and a ticket, floated ABOVE THE PILLAR'S HEAD. The first
// version put it at a fixed offset from the base and the render showed it sitting in the
// plinth — two orange triangles and a small box tangled in the station's own geometry, reading
// as debris at its feet rather than as a verdict. It now hangs off `uplinkAnchor(layout)`, the
// same projected head-top point `UplinkBeams` already tethers to, which is the only anchor on a
// pillar guaranteed to be clear of every solid it is made of. An
// escalation is the one outcome that is NOT self-congratulatory — a human now owns this station
// — and it deserves to look different in kind, not just in hue, or a judge glancing at an amber
// ring will read "done, in yellow". Drawn in local coordinates around (0,0) and scaled by the
// caller, so it inherits the pillar's depth scale like everything else on the deck.
function EscalationMark({ tone }) {
  return (
    <g>
      <path d="M -11 -5 L 0 -17 L 11 -5 Z" fill="none" stroke={tone} strokeWidth="2" />
      <path d="M -11 4 L 0 -8 L 11 4 Z" fill="none" stroke={tone} strokeWidth="2" opacity="0.5" />
      <rect x="-9" y="9" width="18" height="13" rx="2" fill="none" stroke={tone} strokeWidth="1.8" />
      <path d="M -5 14 H 5 M -5 18 H 1" stroke={tone} strokeWidth="1.5" />
    </g>
  )
}

export default function Verdict({ verdicts, layout }) {
  if (!verdicts.length) return null
  return (
    <g data-layer="verdict">
      {verdicts.map((v) => {
        const pos = layout[v.id]
        const spec = VERDICT[v.status]
        // An unrecognised terminal status renders nothing rather than a guessed shape — the
        // explicit fallback Invariant 2 asks for. If the backend ever adds a fourth terminal
        // word, the deck stays quiet instead of inventing a meaning for it.
        if (!pos || !spec) return null
        const r = BASE_RADIUS * pos.scale
        const [headX, headY] = uplinkAnchor(pos)
        return (
          <g key={v.key}>
            <g transform={`translate(${pos.x}, ${pos.y})`}>
              {/* Two rings, the second started late — the same wavefront reading P8's ping uses,
                  because this IS a state change; it is only the one that ends the story. An
                  earlier version pooled a wash of the verdict tone at the base instead of the
                  second ring; the render showed it as a stain on the plinth rather than as
                  light, which is the same trap the retired glow-halo fell into on a light
                  ground (see uplight.js). Dropped rather than tuned. */}
              <g className="voltaris-verdict">
                <ellipse cx="0" cy="0" rx={r} ry={r * FLATTEN} fill="none" stroke={spec.tone} strokeWidth={3.5 * pos.scale} />
              </g>
              <g className="voltaris-verdict voltaris-verdict-trail">
                <ellipse cx="0" cy="0" rx={r} ry={r * FLATTEN} fill="none" stroke={spec.tone} strokeWidth={2 * pos.scale} />
              </g>
            </g>
            {v.status === PHASE.ESCALATED && (
              // TWO nested groups, and this is not cosmetic. A CSS `transform` in a keyframe
              // REPLACES an SVG `transform` attribute on the same element — it does not compose
              // with it. The first version put both on one <g>, so the moment the animation
              // started the mark snapped to the viewBox origin, which `preserveAspectRatio
              // ="xMidYMid slice"` crops off the screen entirely: the mark rendered, was in the
              // DOM, and was invisible. The outer <g> therefore carries the PLACEMENT (an
              // attribute, never animated) and the inner one carries the MOTION (CSS, never
              // positional). The rings above are nested for exactly the same reason.
              <g transform={`translate(${headX}, ${headY - 52 * pos.scale}) scale(${pos.scale})`}>
                <g className="voltaris-verdict-mark">
                  <EscalationMark tone={spec.tone} />
                </g>
              </g>
            )}
          </g>
        )
      })}
    </g>
  )
}
