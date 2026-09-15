import { useState } from 'react'
import { COMPONENTS } from '../../../contracts'

const STATIONS = ['ST-01', 'ST-02', 'ST-03', 'ST-04']

// Identical to the classic `FaultInjectionForm.jsx`'s effect table — same six components,
// same wording, so the two forms never disagree about what a fault does.
const EFFECTS = {
  cooling: {
    DEGRADED: 'temperature climbs ~1 °C/sim-min — THERMAL_WARNING at 65 °C, connector FAULTED at 78 °C. Takes a while.',
    FAILED: 'temperature climbs ~3 °C/sim-min — crosses both thresholds fast.',
  },
  communication: {
    DEGRADED: 'handshakes succeed 30% of the time, latency 1800 ms — sessions start failing.',
    FAILED: 'station goes DISCONNECTED immediately. Opens COMMUNICATION_LOSS.',
  },
  power_module: {
    DEGRADED: 'delivered power capped at 40% of rated (20 kW).',
    FAILED: 'a charging connector trips to FAULTED; an idle one can never leave PREPARING.',
  },
  contactor: {
    DEGRADED: '70% of sessions drop to FAULTED after 20 s of charging.',
    FAILED: 'connector cannot leave PREPARING at all.',
  },
  temp_sensor: {
    DEGRADED: 'the temperature reading moves at half the true rate — masks a cooling fault.',
    FAILED: 'the temperature reading freezes at its last value.',
  },
  network_iface: {
    DEGRADED: 'handshakes succeed 50% of the time, latency 1800 ms — the link, not the controller.',
    FAILED: 'station goes DISCONNECTED while the communication component still reads HEALTHY.',
  },
}

// The left-rail Fault Injection panel — the deck's version of the classic, browser-verified
// `FaultInjectionForm.jsx`. Same endpoint, same request body shape, same field names; only the
// chrome is different. The frontend never sets any world state itself — this submits,
// and the next `/world` poll shows the consequence.
export default function FaultInjectionPanel({ faults = [], simTime = 0, stationIds }) {
  const stations = stationIds && stationIds.length > 0 ? stationIds : STATIONS
  const [stationId, setStationId] = useState(stations[0])
  const [component, setComponent] = useState('cooling')
  const [mode, setMode] = useState('DEGRADED')
  const [recoverable, setRecoverable] = useState(true)
  const [severity, setSeverity] = useState(0.7)
  const [delay, setDelay] = useState(30)
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState(false)

  const inject = async () => {
    setBusy(true)
    setStatus('injecting…')
    try {
      const res = await fetch('/faults/inject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          station_id: stationId, component, mode, recoverable,
          severity: Number(severity), delay_sim_seconds: Number(delay),
        }),
      })
      const data = await res.json()
      setStatus(res.ok ? `scheduled ${data.fault_id} → fires at t=${data.fires_at_sim_time.toFixed(0)}s` : data.detail ?? 'rejected')
    } catch (e) {
      setStatus(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2.5">
      <Field label="Station">
        <select className="w-full rounded border border-edge bg-void px-2 py-1 text-[13px] text-ink" value={stationId} onChange={(e) => setStationId(e.target.value)}>
          {stations.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </Field>

      <Field label="Component">
        <select className="w-full rounded border border-edge bg-void px-2 py-1 text-[13px] text-ink" value={component} onChange={(e) => setComponent(e.target.value)}>
          {COMPONENTS.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </Field>

      <Field label="Mode" hint="FAILED opens an incident on its own; DEGRADED only through its consequences">
        <select className="w-full rounded border border-edge bg-void px-2 py-1 text-[13px] text-ink" value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="DEGRADED">DEGRADED</option>
          <option value="FAILED">FAILED</option>
        </select>
      </Field>

      <div className="flex items-center gap-2">
        <input id="fi-recoverable" type="checkbox" checked={recoverable} onChange={(e) => setRecoverable(e.target.checked)} />
        <label htmlFor="fi-recoverable" className="text-[11px] tracking-wide text-dim" title="if off, restart_component cannot fix it — the agent must escalate">
          RECOVERABLE
        </label>
      </div>

      <Field label={`Severity ${Number(severity).toFixed(1)}`} hint={`rate ×${(0.5 + Number(severity)).toFixed(2)} — scales how fast, not what`}>
        <input type="range" min="0.1" max="1" step="0.1" value={severity} className="w-full" onChange={(e) => setSeverity(e.target.value)} />
      </Field>

      <Field label="Delay (sim seconds)">
        <input type="number" className="w-full rounded border border-edge bg-void px-2 py-1 text-[13px] text-ink" value={delay} onChange={(e) => setDelay(e.target.value)} />
      </Field>

      <button
        onClick={inject}
        disabled={busy}
        className="w-full rounded border border-rose/50 px-2 py-1.5 text-[12px] tracking-[0.18em] text-rose transition-colors hover:bg-rose/10 disabled:opacity-50"
      >
        {busy ? 'INJECTING…' : 'INJECT FAULT'}
      </button>

      <p className="text-[11px] text-dim">
        <span className="text-ink/65">{component} {mode}:</span> {EFFECTS[component]?.[mode] ?? '—'}
      </p>

      {status && <p className="text-[11px] text-dim/80">{status}</p>}

      {faults.length > 0 && (
        <div className="flex flex-col gap-1 border-t border-edge/70 pt-2">
          <h3 className="text-[11px] tracking-[0.14em] text-dim">ARMED FAULTS</h3>
          {[...faults].reverse().map((f) => (
            <div key={f.fault_id} className="text-[11px] text-dim">
              <span className="text-ink/80">{f.fault_id}</span> {f.target} → {f.mode}
              {f.recoverable ? '' : ' (unrecoverable)'}{' · '}
              {f.applied
                ? <span className="text-amber">APPLIED at t={f.fires_at_sim_time?.toFixed(0)}s</span>
                : <span>
                    fires t={f.fires_at_sim_time?.toFixed(0)}s (in {Math.max(0, (f.fires_at_sim_time ?? 0) - simTime).toFixed(0)}s)
                  </span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Field({ label, hint, children }) {
  return (
    <label className="flex flex-col gap-1 text-[11px] tracking-wide text-dim" title={hint}>
      {label}
      {children}
    </label>
  )
}
