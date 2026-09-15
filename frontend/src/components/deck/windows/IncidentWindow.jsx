import { useEffect, useRef, useState } from 'react'
import { fmtSimClock } from './format'

const RAIL = ['OPEN', 'INVESTIGATING', 'RECOVERING', 'VERIFYING', 'RESOLVED']
// The terminal set, verbatim from `TERMINAL_STATUSES` in backend/pipeline/incident.py:
// exactly RESOLVED, ESCALATED, FAILED. There is no CLOSED status anywhere in this system — an
// incident retired by pre-run triage is written RESOLVED or ESCALATED with `closure_reason` set,
// so that styling is keyed off `closure_reason` being non-null, never off a status that does
// not exist.
const TERMINAL = ['RESOLVED', 'ESCALATED', 'FAILED']

// The Incident window's content. The only source is one entry of `snapshot.incidents[]` —
// no other endpoint, and no computed "is this okay" — the frontend reads `incident.status`
// verbatim and renders it.
export default function IncidentWindow({ incident }) {
  const prevStatus = useRef(incident.status)
  const [retreat, setRetreat] = useState(false)

  // The retreat: VERIFYING -> RECOVERING on a failed verification is the system refusing the
  // agent's word. The snapshot carries only the current status, not a history, so the backward
  // transition is detected here by comparing this poll's status to the previous one and held
  // as a brief local flag — this is the one place the window keeps state beyond the snapshot,
  // and it drives a CSS class, never a rendering decision about the incident itself.
  useEffect(() => {
    if (prevStatus.current === 'VERIFYING' && incident.status === 'RECOVERING') {
      setRetreat(true)
      const t = setTimeout(() => setRetreat(false), 1800)
      prevStatus.current = incident.status
      return () => clearTimeout(t)
    }
    prevStatus.current = incident.status
  }, [incident.status])

  const isTerminal = TERMINAL.includes(incident.status)
  const railIndex = RAIL.indexOf(incident.status)

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <span className="text-[13px] text-ink">{incident.type}</span>
        <span className="text-dim">severity {incident.severity}</span>
      </div>
      <div className="flex items-baseline justify-between text-dim">
        <span>target {incident.target}</span>
        <span>opened {fmtSimClock(incident.opened_sim_time)}</span>
      </div>

      {incident.queued && (
        <div className="w-fit rounded border border-amber/40 bg-amber/10 px-1.5 py-0.5 text-[11px] tracking-wide text-amber">
          QUEUED behind an active run
        </div>
      )}

      <div className="border-t border-edge/70" />

      {!isTerminal ? (
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-x-1 gap-y-1 text-[11px]">
            {RAIL.map((step, i) => (
              <span key={step} className="flex items-center gap-1">
                <span
                  className={
                    i === railIndex && retreat && step === 'RECOVERING'
                      ? 'text-amber transition-colors duration-300'
                      : i <= railIndex
                        ? 'text-ice'
                        : 'text-dim/50'
                  }
                >
                  {i <= railIndex ? '●' : '○'} {step}
                </span>
                {i < RAIL.length - 1 && <span className="text-dim/40">→</span>}
              </span>
            ))}
          </div>
          {retreat && (
            <span className="text-[11px] text-amber transition-opacity duration-300">
              ↩ verification failed — sent back to RECOVERING (the system refusing the agent's word)
            </span>
          )}
        </div>
      ) : (
        <TerminalBanner incident={incident} />
      )}

      <div className="border-t border-edge/70" />

      <div className="text-dim">
        {incident.trigger_event_count} trigger event{incident.trigger_event_count === 1 ? '' : 's'}
        {incident.agent_run_id && <> · run {incident.agent_run_id}</>}
      </div>
    </div>
  )
}

// Terminal restyle. ESCALATED reads as handed to a human in amber, never as an error
// (Invariant 8) — the rose reserved for FAILED alone.
function TerminalBanner({ incident }) {
  if (incident.closure_reason) {
    return (
      <div className="text-[13px] text-dim">
        retired without an agent run: <span className="text-ink/80">{incident.closure_reason}</span>
      </div>
    )
  }
  if (incident.status === 'RESOLVED') {
    return <div className="text-[13px] font-medium tracking-wide text-mint">RESOLVED</div>
  }
  if (incident.status === 'ESCALATED') {
    return (
      <div className="flex flex-col gap-1">
        <div className="text-[13px] font-medium tracking-wide text-amber">HANDED TO A HUMAN — SAFE STATE</div>
        {incident.escalation_reason && <div className="text-[13px] text-dim">{incident.escalation_reason}</div>}
      </div>
    )
  }
  if (incident.status === 'FAILED') {
    return <div className="text-[13px] font-medium tracking-wide text-rose">FAILED</div>
  }
  return null
}
