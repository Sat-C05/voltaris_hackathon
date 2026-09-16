import { useMemo } from 'react'
import { project } from './projection'
import { uplinkAnchor } from './StationPillar'
import { PALETTE } from '../../palette'

// The shared backhaul: one node per `snapshot.gateway` entry, placed through the same `project()`
// every other deck object uses (Invariant 6 — never hand-place in screen pixels), high and
// behind the back row, in the empty upper third above the horizon (see projection.js — the
// floor's vanishing point sits at VANISH_Y = 38% down, so a world y this large projects well
// above it). Tuned against a render, per the brief.
// Lowered 900 -> 690 by the orchestrator after a render + crop check. `Deck.jsx` renders the
// station SVG with `preserveAspectRatio="xMidYMid slice"`, which CROPS vertically on any
// container wider than the 1000x600 viewBox — and every real laptop is. At 900 the node landed
// at viewBox y=50, inside the cropped band on 3 of 4 realistic viewports (1080p with browser
// chrome clips everything above y~53, with a bookmarks bar above y~73): the backhaul hub, and
// the point every beam converges on, would simply have been missing on a borrowed machine.
// 690 puts it at y~120 — still well above the horizon (228) and still in the upper dead space
// this package exists to fill, but with real margin against the worst-case crop.
// If this is ever retuned, re-check it against the crop, not against a 1000x600 preview.
// Lowered again, 690 -> 595 (viewBox y 119 -> 150), after P5 grew the status bar from a fixed
// h-14 to two rows for the phase strip. That shrinks the deck container, which makes
// `preserveAspectRatio="xMidYMid slice"` crop MORE vertically — on a 2560x1080 ultrawide the
// visible band starts at y~122, which clipped this node at its old y~119. Any future change to
// the header's height re-opens this: re-run the crop check, don't assume.
const BACKHAUL_Y = 595
const BACKHAUL_Z = 1400
// World-unit spacing between multiple backhaul nodes, spread evenly around x = 0. Only matters
// if `snapshot.gateway` ever holds more than the one entry the real world data ships today.
const BACKHAUL_X_STEP = 170

// Static per gateway id list — a fixed world point through a fixed projection never changes
// poll to poll, so this is computed once per distinct id set (almost always: once, ever), not
// recomputed on every 500ms snapshot poll. Positions depend only on which ids exist, never on
// their `status`, so a status-only change across polls does not invalidate this memo either.
function backhaulLayout(gatewayIds) {
  const n = gatewayIds.length
  return gatewayIds.map((id, i) => {
    const worldX = n <= 1 ? 0 : (i - (n - 1) / 2) * BACKHAUL_X_STEP
    const [sx, sy] = project(worldX, BACKHAUL_Y, BACKHAUL_Z)
    return { id, worldX, sx, sy }
  })
}

// Per-station beam styling — a direct, continuous rendering of fields already in the snapshot,
// never an invented threshold (Invariant 2): `handshake_success_rate` is already 0..1, so a
// linear map to opacity/gap is just drawing that number, not deciding anything about it.
// Motion budget (Invariant 8): even a perfectly healthy link stays low-contrast — opacity is
// capped well below the `.voltaris-pulse`/`.voltaris-flicker` range a genuine fault uses, so a
// faulting pillar's own pulse always reads first.
function beamStyle(station) {
  const linkDown = station.communication_state !== 'CONNECTED'
  const rate = Math.max(0, Math.min(1, station.telemetry.handshake_success_rate))
  const latency = station.telemetry.comm_latency_ms
  const opacity = Math.max(0.1, Math.min(0.4, 0.1 + rate * 0.3))
  const gap = 8 + (1 - rate) * 26 // healthy: tight ~8px gaps · struggling: sparse, up to ~34px
  const duration = Math.max(1.5, Math.min(4.5, 1.5 + (latency / 1800) * 3)) // higher latency -> slower packets
  return { linkDown, opacity, gap, duration }
}

// Quiet instrument-node styling for the backhaul itself, from `gateway[id].status` — the same
// direct-string-comparison pattern `StationPillar.jsx`'s own `classify()` already uses for
// `station.status`/`communication_state` (never a derived "is this okay" boolean invented here).
function nodeColor(status) {
  return status === 'AVAILABLE' ? PALETTE.uplinkIdle : PALETTE.amberDesat
}

// One beam per station (head-top to its nearest backhaul node) plus the backhaul node(s)
// themselves — everything driven from `snapshot` alone (Invariant 1: no `/events`, no
// `useEvents` import anywhere in this file). `layout` is the same per-station map
// `Deck.jsx`/`StationPillar.jsx` already use.
export default function UplinkBeams({ snapshot, layout }) {
  const gateway = snapshot.gateway ?? {}
  const gatewayIdsKey = Object.keys(gateway).sort().join(',')
  const gatewayIds = useMemo(() => (gatewayIdsKey ? gatewayIdsKey.split(',') : []), [gatewayIdsKey])
  const nodes = useMemo(() => backhaulLayout(gatewayIds), [gatewayIds])

  if (nodes.length === 0) return null

  const stationIds = Object.keys(snapshot.stations).filter((id) => layout[id])

  return (
    <>
      {/* the backhaul node(s) — small, quiet, instrument-like: a ring + dot + id label, never
          pulsing on its own (only a genuine fault earns a pulse, and the gateway's `status`
          field is not a fault signal the way a station's is). */}
      {nodes.map(({ id, sx, sy }) => {
        const stroke = nodeColor(gateway[id]?.status)
        return (
          <g key={id} transform={`translate(${sx}, ${sy})`}>
            <circle r="7" fill={PALETTE.void} stroke={stroke} strokeWidth="1.5" opacity="0.85" />
            <circle r="2.5" fill={stroke} opacity="0.9" />
            <text
              x="11" y="3"
              fontSize="9" fontFamily="ui-monospace, monospace" letterSpacing="0.04em"
              fill={PALETTE.dim}
            >
              {id}
            </text>
          </g>
        )
      })}

      {/* one beam per station, from its own head-top anchor (`uplinkAnchor`, exported by
          StationPillar.jsx so the two files never disagree on the point) to its nearest
          backhaul node. Straight `<line>`s between two already-`project()`-ed points are exact
          here, the same way Grid.jsx's floor lines are: a pinhole projection maps a straight
          3D line to a straight 2D line. */}
      {stationIds.map((id) => {
        const station = snapshot.stations[id]
        const stationLayout = layout[id]
        const [sx, sy] = uplinkAnchor(stationLayout)

        // The snapshot carries no station->gateway relationship, only `gateway[id].status` —
        // "nearest by world x" is the only defensible, data-free tie-break: exact with today's
        // single real gateway, a reasonable visual default if more are ever added.
        let node = nodes[0]
        for (const n of nodes) {
          if (Math.abs(n.worldX - stationLayout.worldX) < Math.abs(node.worldX - stationLayout.worldX)) node = n
        }

        const { linkDown, opacity, gap, duration } = beamStyle(station)
        const dash = 2.5
        // A packet pattern that loops seamlessly regardless of this station's own gap (which
        // varies with handshake rate): shift by an exact multiple of (dash + gap) rather than a
        // fixed pixel amount, via a CSS custom property the shared keyframe below reads — so
        // every station's dashes wrap cleanly with one keyframe, not one keyframe per gap value.
        const shift = -(dash + gap) * 8

        return (
          <g key={id}>
            {/* the wire itself: faint and static. Dead link reuses the exact vocabulary the
                pillar's own uplink arc already uses for the same condition (rose, dashed,
                `.voltaris-flicker`) — the two must agree, never contradict. */}
            <line
              x1={sx} y1={sy} x2={node.sx} y2={node.sy}
              stroke={linkDown ? PALETTE.rose : PALETTE.uplinkIdle}
              strokeWidth="1.25"
              opacity={linkDown ? 0.55 : 0.22}
              strokeDasharray={linkDown ? '3 3' : undefined}
              className={linkDown ? 'voltaris-flicker' : undefined}
            />
            {/* packets: short dash, long gap, CSS-animated `stroke-dashoffset` only — no
                `requestAnimationFrame`, no SMIL, no timer in React state (Invariant 8's trap:
                a JS loop here would fight the 500ms snapshot poll). None at all while the link
                is down. */}
            {!linkDown && (
              <line
                x1={sx} y1={sy} x2={node.sx} y2={node.sy}
                stroke={PALETTE.uplinkIdle}
                strokeWidth="1.5"
                strokeLinecap="round"
                opacity={opacity}
                strokeDasharray={`${dash} ${gap}`}
                className="voltaris-packet-flow"
                style={{ '--packet-shift': `${shift}px`, animationDuration: `${duration}s` }}
              />
            )}
          </g>
        )
      })}
    </>
  )
}
