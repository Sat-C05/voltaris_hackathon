import { memo } from 'react'
import { TEMP_PROTECTION, AMBIENT_TEMP_C, COMPONENTS } from '../../contracts'
import { UPLIGHT } from './uplight'
import { PALETTE } from '../../palette'

const HEALTH_COLOR = { HEALTHY: PALETTE.mint, DEGRADED: PALETTE.amber, FAILED: PALETTE.rose }

// State -> appearance. Every branch below reads
// only `station` (a slice of snapshot.stations[id]) — never a derived "is this okay" boolean
// computed elsewhere. The frontend does not decide outcomes; it just maps snapshot
// fields to colour.
function classify(station) {
  const isolated = station.status === 'UNAVAILABLE'
  const faulted = station.status === 'FAULTED' ||
    Object.values(station.connectors).some((c) => c.status === 'FAULTED')
  const charging = Object.values(station.connectors).some((c) =>
    ['PREPARING', 'CHARGING', 'FINISHING'].includes(c.status))
  const failedComponents = COMPONENTS.filter((c) => station.components[c]?.health === 'FAILED')
  const degradedComponents = COMPONENTS.filter((c) => station.components[c]?.health === 'DEGRADED')
  const linkDown = station.communication_state !== 'CONNECTED'

  let halo = 'mint'
  if (isolated) halo = 'isolated'
  else if (faulted) halo = 'rose'
  else if (failedComponents.length > 0) halo = 'rose'
  else if (degradedComponents.length > 0 || linkDown) halo = 'amber-desat'
  else if (charging) halo = 'amber'

  return { isolated, faulted, charging, failedComponents, degradedComponents, linkDown, halo }
}


function tempOpacity(tempC) {
  const t = (tempC - AMBIENT_TEMP_C) / (TEMP_PROTECTION - AMBIENT_TEMP_C)
  return Math.max(0, Math.min(0.9, t * 0.9))
}

function StationPillarInner({ id, station, layout, selected, dimmed, faultPending, onHover, onLeave, onClick }) {
  const { x, y, scale } = layout
  const cls = classify(station)
  const w = 90, h = 160
  const heatOpacity = tempOpacity(station.telemetry.temperature_c)
  // The ONLY condition that earns a pulse. Everything else breathes almost imperceptibly —
  // if three things pulse at once, nothing reads as wrong.
  const alert = cls.faulted || cls.failedComponents.length > 0
  const screenText = cls.faulted ? 'FAULT' : (
    Object.values(station.connectors).find((c) => c.status === 'CHARGING')
      ? `${station.telemetry.power_kw.toFixed(0)} kW`
      : id
  )

  const ringComponents = COMPONENTS.map((name, i) => ({
    name,
    health: station.components[name]?.health ?? 'HEALTHY',
    angle: (i / COMPONENTS.length) * 2 * Math.PI,
  }))

  return (
    <g
      transform={`translate(${x}, ${y}) scale(${scale})`}
      opacity={dimmed ? 0.6 : 1}
      style={{ cursor: 'pointer', transition: 'opacity 240ms ease' }}
      onMouseEnter={() => onHover?.(id)}
      onMouseLeave={() => onLeave?.(id)}
      onClick={(e) => { e.stopPropagation(); onClick?.(id) }}
      data-station={id}
    >
      {/* armed-fault reticle: a faint amber target on this station while a fault is pending */}
      {faultPending && (
        <g className="voltaris-pulse-slow" opacity="0.8">
          <circle cx="0" cy="0" r="46" fill="none" stroke={PALETTE.amber} strokeWidth="1.5" strokeDasharray="4 4" />
          <circle cx="0" cy="0" r="6" fill="none" stroke={PALETTE.amber} strokeWidth="1.5" />
        </g>
      )}

      {/* heat column */}
      {heatOpacity > 0.02 && (
        <rect
          x={-w / 4} y={-h - 90} width={w / 2} height="90"
          fill="url(#heatGradient)" opacity={heatOpacity}
        />
      )}

      {/* contact shadow — the light-theme replacement for the old dark-ground drop shadow.
          Neutral, never status-coloured: it's what grounds the pillar on the plane,
          the status fill/outline below is what carries the state. */}
      <ellipse cx="0" cy="4" rx={w * 0.62} ry="11" fill={PALETTE.ink} opacity="0.18" />

      {/* STATUS FILL/OUTLINE. The original uplight did not survive the move to a light
          theme: a glow spilling upward reads as light only against darkness, and on a pale
          ground it looks like a smudge. On paper, status has to read as ink and fill
          instead — a solid-filled plinth the pillar stands
          on, plus a coloured outline on the pillar's own body. Same five `UPLIGHT` states as
          before, same "only a genuine fault pulses" rule; only the rendering changed. */}
      <g className={alert ? 'voltaris-pulse' : 'voltaris-breathe'}>
        <ellipse cx="0" cy="5" rx={w * 0.58} ry="12" fill={UPLIGHT[cls.halo]} opacity={cls.isolated ? 0.35 : 0.55} />
        <ellipse cx="0" cy="5" rx={w * 0.58} ry="12" fill="none" stroke={UPLIGHT[cls.halo]} strokeWidth="1.5" opacity="0.9" />
      </g>

      {/* pillar body — shaped to read as an EV station rather than a plain cuboid.
          Same isometric three-face-box idiom as before,
          but now three distinct sub-forms instead of one cuboid: a foot/plinth the cabinet
          rests on, the main cabinet body, and a narrower head/display bezel on top with a
          chamfered cap — plus a charging cable and holster. The bounding box is still exactly
          `w=90 h=160` from the base origin (layout.js and the leader-line maths depend on this
          not changing); everything below is drawn *within* that same box, just no longer as
          one flat-cut cuboid. Maintenance-hold grey and the three light/mid/dark cabinet shades
          are `PALETTE.panelLight`/`panelLighter`/`holdPanel`/`holdPanelDark`/`holdPanelDarker`
          — these were raw hex before; only the fill values moved into the palette so they
          gain a dark-theme counterpart, and the GEOMETRY is unchanged. */}
      <g opacity={cls.failedComponents.length > 0 ? 0.55 : 1}>
        {/* foot / plinth: a short, slightly wider slab the cabinet stands on. Deliberately
            narrower than the status ellipse above (rx ~52) so that ellipse's colour and its
            outline ring still read clearly around the foot's edges — status must keep showing
            through the plinth, this is decoration standing on top of it, not covering it. */}
        <path
          d="M -40 0 L -40 -10 L 30 -10 L 30 0 Z"
          fill={station.maintenance_hold ? PALETTE.holdPanelDark : PALETTE.panelLight}
          stroke={PALETTE.ink}
          strokeWidth="1.5"
        />
        <path
          d="M 30 0 L 30 -10 L 40 -20 L 40 -10 Z"
          fill={station.maintenance_hold ? PALETTE.holdPanelDarker : PALETTE.panelLighter}
          stroke={PALETTE.ink}
          strokeWidth="1.5"
        />
        <path
          d="M -40 -10 L 30 -10 L 40 -20 L -30 -20 Z"
          fill={station.maintenance_hold ? PALETTE.holdPanelDarker : PALETTE.panelLighter}
          stroke={PALETTE.ink}
          strokeWidth="1"
          opacity="0.8"
        />

        {/* cabinet body: sits on the foot, no top face of its own — the head above supplies
            the roofline, the way a real charger's control head sits on a taller cabinet. */}
        <path
          d={`M ${-w / 2} -10 L ${-w / 2} -126 L ${w / 2 - 14} -126 L ${w / 2 - 14} -10 Z`}
          fill={station.maintenance_hold ? PALETTE.holdPanel : PALETTE.deck}
          stroke={PALETTE.ink}
          strokeWidth="1.5"
        />
        <path
          d={`M ${w / 2 - 14} -10 L ${w / 2 - 14} -126 L ${w / 2} -140 L ${w / 2} -24 Z`}
          fill={station.maintenance_hold ? PALETTE.holdPanelDark : PALETTE.panelLight}
          stroke={PALETTE.ink}
          strokeWidth="1.5"
        />
        {/* status tint + outline on the cabinet front, same treatment as before this pass */}
        <path
          d={`M ${-w / 2} -10 L ${-w / 2} -126 L ${w / 2 - 14} -126 L ${w / 2 - 14} -10 Z`}
          fill={UPLIGHT[cls.halo]} opacity="0.12"
        />
        <path
          d={`M ${-w / 2} -10 L ${-w / 2} -126 L ${w / 2 - 14} -126 L ${w / 2 - 14} -10 Z`}
          fill="none" stroke={UPLIGHT[cls.halo]} strokeWidth="2"
        />

        {/* head: a distinct, narrower display bezel on top of the cabinet, with a chamfered
            (corner-cut) cap instead of a flat-cut roof — "a proper display bezel/head section
            ... rounded or chamfered top cap rather than a flat-cut cuboid". */}
        <path
          d="M -33 -126 L -33 -154 L -27 -160 L 13 -160 L 19 -154 L 19 -126 Z"
          fill={station.maintenance_hold ? PALETTE.holdPanel : PALETTE.deck}
          stroke={PALETTE.ink}
          strokeWidth="1.5"
        />
        <path
          d="M 19 -126 L 19 -154 L 29 -160 L 29 -132 Z"
          fill={station.maintenance_hold ? PALETTE.holdPanelDark : PALETTE.panelLight}
          stroke={PALETTE.ink}
          strokeWidth="1.5"
        />
        <path
          d="M -27 -160 L 13 -160 L 29 -132 L 29 -132 L 19 -154 L -33 -154 Z"
          fill={station.maintenance_hold ? PALETTE.holdPanelDarker : PALETTE.panelLighter}
          stroke={PALETTE.ink}
          strokeWidth="1"
          opacity="0.9"
        />
        {/* status tint + outline on the head front too, so the colour reads from the top of
            the station as well as the cabinet, not just one band */}
        <path
          d="M -33 -126 L -33 -154 L -27 -160 L 13 -160 L 19 -154 L 19 -126 Z"
          fill={UPLIGHT[cls.halo]} opacity="0.12"
        />
        <path
          d="M -33 -126 L -33 -154 L -27 -160 L 13 -160 L 19 -154 L 19 -126 Z"
          fill="none" stroke={UPLIGHT[cls.halo]} strokeWidth="1.5"
        />

        {/* screen panel, now set into the head. Font sizes left at the same ~9px this
            in-scene label already used before this pass (a physical station's own built-in
            display, miniaturized by the isometric scale — not the window/rail body text the
            "never below 13px" rule protects) rather than shrunk further to fit the narrower
            head; the rect grew instead so the label still has room. */}
        <rect x="-24" y="-153" width="44" height="22" rx="2" fill={PALETTE.void} stroke={PALETTE.ink} />
        <text x="-20" y="-144" fill={PALETTE.ice} fontSize="9" fontFamily="ui-monospace, monospace" letterSpacing="0.04em">
          {id}
        </text>
        <text x="-20" y="-134" fill={cls.faulted ? PALETTE.rose : PALETTE.ink} fontSize="9" fontFamily="ui-monospace, monospace">
          {screenText}
        </text>

        {/* charging cable: leaves the cabinet's side, hangs in a curve, and ends in a
            connector resting in a holster on the plinth. Neutral ink throughout — status
            keeps reading through the plinth ellipse and the outlines above, not through this. */}
        <path
          d="M 40 -70 C 62 -54, 60 -28, 49 -13"
          fill="none"
          stroke={PALETTE.ink}
          strokeWidth="3"
          strokeLinecap="round"
          opacity="0.75"
        />
        <rect x="39" y="-19" width="15" height="10" rx="3" fill={PALETTE.ink} opacity="0.15" stroke={PALETTE.ink} strokeWidth="1" />
        <rect x="42.5" y="-17.5" width="8" height="7" rx="1.5" fill={PALETTE.ink} opacity="0.85" />
      </g>

      {/* uplink arc — flickers/breaks when the link is not CONNECTED */}
      <path
        d={`M ${-14} ${-h - 20} A 14 14 0 0 1 14 ${-h - 20}`}
        fill="none"
        stroke={cls.linkDown ? PALETTE.rose : PALETTE.uplinkIdle}
        strokeWidth="2"
        strokeDasharray={cls.linkDown ? '3 3' : undefined}
        className={cls.linkDown ? 'voltaris-flicker' : undefined}
      />

      {/* maintenance hold: hazard chevrons at the base */}
      {station.maintenance_hold && (
        <g fill={PALETTE.amber} opacity="0.9">
          <path d="M -30 14 L -22 8 L -14 14 Z" />
          <path d="M 14 14 L 22 8 L 30 14 Z" />
        </g>
      )}

      {/* isolated ring — blue, not red: the system doing the right thing */}
      {cls.isolated && (
        <circle cx="0" cy={-h / 2} r={w * 0.72} fill="none" stroke={UPLIGHT.isolated} strokeWidth="1.5" opacity="0.7" />
      )}

      {/* component ring: six tiny arcs around the base, one per component in COMPONENTS order */}
      {ringComponents.map(({ name, health, angle }) => {
        const r = w * 0.62
        const a0 = angle - 0.22
        const a1 = angle + 0.22
        const p0 = [r * Math.sin(a0), 8 + r * 0.28 * Math.cos(a0)]
        const p1 = [r * Math.sin(a1), 8 + r * 0.28 * Math.cos(a1)]
        return (
          <path
            key={name}
            d={`M ${p0[0]} ${p0[1]} A ${r} ${r * 0.28} 0 0 1 ${p1[0]} ${p1[1]}`}
            fill="none"
            stroke={HEALTH_COLOR[health] ?? PALETTE.dim}
            strokeWidth={health === 'HEALTHY' ? 2 : 3}
            opacity={health === 'HEALTHY' ? 0.5 : 1}
            className={health !== 'HEALTHY' ? 'voltaris-pulse' : undefined}
          />
        )
      })}

      {selected && (
        <rect x={-w / 2 - 8} y={-h - 24} width={w + 16 - 14} height={h + 24} fill="none" stroke={PALETTE.ice} strokeWidth="1" strokeDasharray="2 3" opacity="0.7" />
      )}
    </g>
  )
}

// Signature-based comparator: the snapshot is a brand-new object graph every poll (fresh JSON),
// so reference equality would always fail. Compare the primitive fields this pillar actually
// renders instead — one station's temperature changing must not force a
// re-render of the other three plus the grid.
function signature(props) {
  const s = props.station
  return JSON.stringify([
    s.status,
    s.connectors,
    s.components,
    s.communication_state,
    Math.round(s.telemetry.temperature_c * 10),
    Math.round(s.telemetry.power_kw),
    s.maintenance_hold,
    props.selected,
    props.dimmed,
    props.faultPending,
  ])
}

function areEqual(prev, next) {
  return signature(prev) === signature(next)
}

const StationPillar = memo(StationPillarInner, areEqual)
export default StationPillar
