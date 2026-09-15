import { COMPONENTS } from '../../contracts'
import { PALETTE } from '../../palette'

const HEALTH_COLOR = { HEALTHY: 'text-mint', DEGRADED: 'text-amber', FAILED: 'text-rose' }

function sparklinePoints(values) {
  if (values.length < 2) return ''
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = Math.max(1, max - min)
  const w = 44, h = 14
  return values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * w
      const y = h - ((v - min) / span) * h
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}

// The vitals card — now a PERMANENT section of RightRail's column (reserved-space round), not a
// conditionally-mounted popup. `RightRail.jsx` always renders this inside a fixed-height slot;
// this component only decides what fills it: a quiet empty state when nothing is hovered or
// pinned, or the station's vitals when something is. `station == null` is a real, expected input
// now (it used to make the parent skip rendering this component at all) — that is exactly what
// makes the reserved slot's height constant regardless of hover state, which is the whole point.
//
// Content compacted into two-column grids (reserved-space round) — the four telemetry readouts
// and the six component rows used to be one-per-line (~286px total); two-per-line takes them to
// 2 rows and 3 rows respectively, which is what buys back the space INCIDENTS needs to be usable
// again. Every field is still here, none dropped — `title={name}` on each component row is a
// fallback in case `truncate` ever clips the two longest names ("communication",
// "network_iface") at this narrower per-column width; their HEALTH value (the field an operator
// actually needs) is never truncated. Not verified in a browser — a human should check that
// HANDSHAKE's value ("0.34 · 1800 ms" at its longest) doesn't wrap awkwardly in its half-width
// column, and that the two long component names read acceptably even if clipped.
//
// `pinned`: true when this card is showing because a station is *selected* rather than because
// the pointer is over it — RightRail computes that (`!hoveredId && !!selectedStationId`) and
// passes it down purely for the header's pin glyph; it changes no other rendering decision here.
export default function HoverCard({ id, station, tempHistory, pinned = false }) {
  if (!station) {
    return (
      <div className="pointer-events-none flex h-full flex-col items-center justify-center p-3 text-center text-[13px] text-dim/70">
        hover a station for its vitals
      </div>
    )
  }

  const connectorEntries = Object.entries(station.connectors)
  const abnormal = COMPONENTS
    .map((name) => ({ name, health: station.components[name]?.health ?? 'HEALTHY' }))
    .sort((a, b) => (a.health === 'HEALTHY') - (b.health === 'HEALTHY'))

  return (
    <div
      // No outer border/panel/padding-as-frame here any more (reserved-space round) — RightRail
      // supplies the section chrome (border, background, the "VITALS" header) now that this is
      // a permanent slot rather than a floating card of its own; `h-full` fills that slot
      // exactly, `pointer-events-none` still holds so it never eats a click meant for the deck.
      className="pointer-events-none flex h-full flex-col p-3 text-[13px] text-dim"
      style={{ fontFamily: 'ui-monospace, monospace' }}
    >
      <div className="flex items-baseline justify-between text-[13px]">
        <span className="flex items-center gap-1 text-ice tracking-wide">
          {pinned && (
            <span title="pinned — click the station again to unpin" aria-label="pinned">📌</span>
          )}
          {id}
        </span>
        <span className="text-ink">{station.status}</span>
      </div>
      {connectorEntries.map(([cid, c]) => (
        <div key={cid} className="text-ink/65">{cid} · {c.status}</div>
      ))}

      <div className="my-1.5 border-t border-edge" />

      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
        <div className="flex items-center gap-1.5">
          <span>TEMP</span>
          <span className="flex items-center gap-1 text-ink">
            {station.telemetry.temperature_c.toFixed(1)}°C
            {tempHistory.length > 1 && (
              <svg width="44" height="14" className="opacity-80">
                <polyline points={sparklinePoints(tempHistory)} fill="none" stroke={PALETTE.ice} strokeWidth="1" />
              </svg>
            )}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span>POWER</span><span className="text-ink">{station.telemetry.power_kw.toFixed(0)} kW</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span>COOLING</span><span className="text-ink">{station.telemetry.cooling_effectiveness.toFixed(2)}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span>HANDSHAKE</span>
          <span className="text-ink">{station.telemetry.handshake_success_rate.toFixed(2)} · {station.telemetry.comm_latency_ms}ms</span>
        </div>
      </div>

      <div className="my-1.5 border-t border-edge" />

      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
        {abnormal.map(({ name, health }) => (
          <div key={name} className="flex items-center justify-between gap-1" title={name}>
            <span className="truncate">{name}</span>
            <span className={`shrink-0 ${HEALTH_COLOR[health] ?? 'text-dim'}`}>
              {health}{health !== 'HEALTHY' ? ' ▲' : ''}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
