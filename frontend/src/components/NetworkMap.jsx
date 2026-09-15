const DOT = {
  AVAILABLE: 'bg-emerald-500',
  PREPARING: 'bg-amber-400',
  CHARGING: 'bg-amber-400',
  FINISHING: 'bg-amber-400',
  FAULTED: 'bg-red-500',
  UNAVAILABLE: 'bg-zinc-500',
  OFFLINE: 'bg-zinc-600',
}

const HEALTH_STYLE = {
  DEGRADED: 'border-amber-600/60 text-amber-300',
  FAILED: 'border-red-700/70 text-red-300',
  OFFLINE: 'border-zinc-600 text-zinc-400',
}

const COMMS_STYLE = {
  DEGRADED: 'border-amber-600/60 text-amber-300',
  DISCONNECTED: 'border-red-700/70 text-red-300',
}

// Four station tiles, colour by state. One glance should tell you which
// station is in trouble — the map is not where the detail lives, the incident panel is.
//
// Component health IS in the snapshot for operators even though the agent has to ask for it,
// and showing it here is the whole point of that distinction: live testing repeatedly
// hit "I need something in the UI to show me that
// communication is degrading or failed" — until now the only way to see a component's health
// was to read the agent's own tool log after the fact. Only abnormal components are listed:
// a healthy station should be quiet, so an amber or red chip is what draws the eye.
export default function NetworkMap({ stations }) {
  const ids = Object.keys(stations).sort()
  return (
    <section className="border border-zinc-800 rounded p-3">
      <h2 className="text-xs tracking-widest text-zinc-500 mb-3">NETWORK MAP</h2>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {ids.map((id) => {
          const s = stations[id]
          const unhealthy = Object.entries(s.components).filter(([, c]) => c.health !== 'HEALTHY')
          return (
            <div key={id} className="border border-zinc-800 rounded p-3 flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className={`inline-block w-2.5 h-2.5 rounded-full ${DOT[s.status] ?? 'bg-zinc-600'}`} />
                <span className="text-sm">{id}</span>
                {s.maintenance_hold && (
                  // A hold silences this station's admission control and folds its queued
                  // incidents into the open escalation — correct while an engineer owns the
                  // equipment, and wrong forever after. This button is the way back: without
                  // it, a station escalated early in a session looks broken for the rest of it,
                  // because every fault injected there afterwards is deliberately ignored.
                  <button
                    onClick={() => fetch(`/stations/${id}/return-to-service`, { method: 'POST' })}
                    title="Lift the maintenance hold and return this station to service"
                    className="ml-auto text-[9px] tracking-wider px-1 py-0.5 rounded border border-sky-800 text-sky-300 hover:bg-sky-900/40"
                  >
                    HOLD ✕
                  </button>
                )}
              </div>
              <span className="text-[11px] text-zinc-500">{s.status}</span>

              <div className="flex flex-wrap gap-x-3 text-[11px] text-zinc-500">
                <span className={s.telemetry.temperature_c >= 65 ? 'text-amber-400' : undefined}>
                  {s.telemetry.temperature_c.toFixed(1)} °C
                </span>
                <span>{s.telemetry.power_kw.toFixed(0)} kW</span>
              </div>

              {Object.entries(s.connectors).map(([cid, c]) => (
                <span key={cid} className="text-[11px] text-zinc-600">
                  {cid} · {c.status}
                </span>
              ))}

              {(unhealthy.length > 0 || s.communication_state !== 'CONNECTED') && (
                <div className="flex flex-wrap gap-1 pt-1">
                  {s.communication_state !== 'CONNECTED' && (
                    <Chip className={COMMS_STYLE[s.communication_state]}>
                      link {s.communication_state.toLowerCase()}
                    </Chip>
                  )}
                  {unhealthy.map(([name, c]) => (
                    <Chip key={name} className={HEALTH_STYLE[c.health]}>
                      {name} {c.health}
                    </Chip>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}

function Chip({ className, children }) {
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded border ${className ?? 'border-zinc-700 text-zinc-400'}`}>
      {children}
    </span>
  )
}
