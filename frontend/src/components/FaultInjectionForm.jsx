import { useState } from 'react'

const STATIONS = ['ST-01', 'ST-02', 'ST-03', 'ST-04']
const COMPONENTS = ['cooling', 'communication', 'power_module', 'contactor', 'temp_sensor', 'network_iface']

// What each (component, mode) pair actually does to the world — simulator.py's effect table
// in one line each, so the person injecting a fault knows what symptom to expect and
// how long to wait for it. Live testing hit exactly this: a DEGRADED
// component was injected, nothing appeared to happen for minutes, and there was no way to
// tell a slow causal chain from a broken injection.
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

// The FAULT INJECTION form, on the single fault path: this POSTs to the same
// `/faults/inject` endpoint the scenario runner uses. The frontend never sets any state itself
// — it submits, and the next `/world` poll shows the consequence.
export default function FaultInjectionForm({ faults = [], simTime = 0, onReset }) {
  const [stationId, setStationId] = useState('ST-02')
  const [component, setComponent] = useState('cooling')
  const [mode, setMode] = useState('DEGRADED')
  const [recoverable, setRecoverable] = useState(true)
  const [severity, setSeverity] = useState(0.7)
  const [delay, setDelay] = useState(30)
  const [status, setStatus] = useState(null)

  const inject = async () => {
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
    }
  }

  const reset = async () => {
    setStatus('resetting…')
    await fetch('/world/reset', { method: 'POST' })
    onReset?.()
    setStatus('world reset')
  }

  return (
    <section className="border border-zinc-800 rounded p-3 flex flex-col gap-3">
      <h2 className="text-xs tracking-widest text-zinc-500">FAULT INJECTION</h2>

      <div className="flex flex-wrap items-end gap-4">
        <Field label="Station">
          <select className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs" value={stationId} onChange={(e) => setStationId(e.target.value)}>
            {STATIONS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </Field>

        <Field label="Component">
          <select className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs" value={component} onChange={(e) => setComponent(e.target.value)}>
            {COMPONENTS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </Field>

        <Field label="Mode" hint="FAILED opens an incident on its own; DEGRADED only through its consequences">
          <select className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs" value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="DEGRADED">DEGRADED</option>
            <option value="FAILED">FAILED</option>
          </select>
        </Field>

        <Field label="Recoverable" hint="if off, restart_component cannot fix it — the agent must escalate">
          <input type="checkbox" checked={recoverable} onChange={(e) => setRecoverable(e.target.checked)} />
        </Field>

        <Field label={`Severity ${Number(severity).toFixed(1)}`} hint={`rate ×${(0.5 + Number(severity)).toFixed(2)} — scales how fast, not what`}>
          <input type="range" min="0" max="1" step="0.1" value={severity} onChange={(e) => setSeverity(e.target.value)} />
        </Field>

        <Field label="Delay" hint="simulated seconds from now until the fault fires">
          <input type="number" className="w-20 bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs" value={delay} onChange={(e) => setDelay(e.target.value)} />
        </Field>

        <button onClick={inject} className="px-3 py-1.5 text-xs rounded bg-red-900/60 border border-red-800 hover:bg-red-900 text-red-200">
          INJECT
        </button>
        <button onClick={reset} className="px-3 py-1.5 text-xs rounded bg-zinc-800 border border-zinc-700 hover:bg-zinc-700 text-zinc-300">
          RESET WORLD
        </button>

        {status && <span className="text-xs text-zinc-500">{status}</span>}
      </div>

      <p className="text-[11px] text-zinc-500">
        <span className="text-zinc-400">{component} {mode}:</span> {EFFECTS[component]?.[mode] ?? '—'}
      </p>

      {faults.length > 0 && (
        <div className="flex flex-col gap-0.5 border-t border-zinc-800 pt-2">
          <h3 className="text-[10px] tracking-widest text-zinc-600">INJECTED FAULTS</h3>
          {[...faults].reverse().map((f) => (
            <div key={f.fault_id} className="text-[11px] text-zinc-500">
              <span className="text-zinc-400">{f.fault_id}</span> {f.target} → {f.mode}
              {f.recoverable ? '' : ' (unrecoverable)'}{' · '}
              {f.applied
                ? <span className="text-amber-400">active since t={f.fires_at_sim_time?.toFixed(0)}s</span>
                : <span className="text-zinc-500">
                    pending — fires at t={f.fires_at_sim_time?.toFixed(0)}s (in {Math.max(0, (f.fires_at_sim_time ?? 0) - simTime).toFixed(0)}s sim)
                  </span>}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function Field({ label, hint, children }) {
  return (
    <label className="flex flex-col gap-1 text-[11px] text-zinc-500" title={hint}>
      {label}
      {children}
      {hint && <span className="text-[10px] text-zinc-600 max-w-[16rem]">{hint}</span>}
    </label>
  )
}
