const STATUS_COLOR = {
  OPEN: 'text-zinc-400',
  INVESTIGATING: 'text-amber-400',
  RECOVERING: 'text-amber-400',
  VERIFYING: 'text-amber-400',
  RESOLVED: 'text-emerald-400',
  ESCALATED: 'text-sky-400',   // a success outcome, never rendered as a failure colour
  FAILED: 'text-red-400',
}

const TERMINAL = ['RESOLVED', 'ESCALATED', 'FAILED']

// Component health IS in the /world snapshot for operators to see — the agent has to ask for
// it, a human reading this panel does not. This is the one place that distinction
// matters: showing it here is not a leak into the agent's context, which never sees this panel.
//
// It is LIVE state, though, not a record of what this incident was about — the snapshot has no
// history, and the twin only ever holds "now". Shown against a closed incident it told an
// outright lie: a resolved power_module incident picked up whatever happened to be unhealthy
// minutes later, and every incident in the list showed the same line (reported live). So it is
// rendered only for incidents still in flight, and labelled as the station's current state
// rather than as this incident's cause.
function unhealthyNow(target, stations) {
  const station = stations?.[target.split('/')[0]]
  if (!station) return []
  const bad = Object.entries(station.components)
    .filter(([, c]) => c.health !== 'HEALTHY')
    .map(([name, c]) => `${name}: ${c.health}`)
  if (station.communication_state !== 'CONNECTED') {
    bad.push(`communication link: ${station.communication_state}`)
  }
  return bad
}

// The INCIDENT panel. Shows every incident this session, most recent first — a resolved
// incident stays visible rather than disappearing, since "it closed cleanly" is part of what
// the judge should see.
export default function IncidentPanel({ incidents, activeRun, stations }) {
  const sorted = [...incidents].sort((a, b) => b.opened_sim_time - a.opened_sim_time)

  return (
    <section className="border border-zinc-800 rounded p-3 flex flex-col gap-3 overflow-y-auto max-h-[28rem]">
      <h2 className="text-xs tracking-widest text-zinc-500">INCIDENTS</h2>
      {sorted.length === 0 && <p className="text-xs text-zinc-600">No incidents yet — inject a fault below.</p>}
      {sorted.map((inc) => {
        const isActive = activeRun && activeRun.incident_id === inc.incident_id
        const isTerminal = TERMINAL.includes(inc.status)
        const live = isTerminal ? [] : unhealthyNow(inc.target, stations)
        return (
          <div key={inc.incident_id} className="border border-zinc-800 rounded p-2 text-xs flex flex-col gap-1">
            <div className="flex justify-between">
              <span className="text-zinc-300">{inc.incident_id}</span>
              <span className={STATUS_COLOR[inc.status] ?? 'text-zinc-400'}>
                {inc.status}{inc.queued ? ' (queued)' : ''}
              </span>
            </div>
            <span className="text-zinc-500">{inc.target} · {inc.type} · {inc.severity}</span>
            <span className="text-zinc-600">opened t={inc.opened_sim_time.toFixed(0)}s · {inc.trigger_event_count} trigger event(s)</span>
            {live.length > 0 && (
              <span className="text-amber-400/80">station now: {live.join(', ')}</span>
            )}
            {inc.closure_reason && (
              <span className={inc.status === 'ESCALATED' ? 'text-sky-400/70' : 'text-emerald-400/70'}>
                closed without an agent run: {inc.closure_reason}
              </span>
            )}
            {inc.escalation_reason && (
              <span className="text-sky-400/70">escalated by guardrail: {inc.escalation_reason}</span>
            )}
            {isActive && (
              <span className="text-zinc-600">
                steps {activeRun.steps_used}/{activeRun.max_steps} · actions {activeRun.actions_used}/{activeRun.max_actions}
              </span>
            )}
          </div>
        )
      })}
    </section>
  )
}
