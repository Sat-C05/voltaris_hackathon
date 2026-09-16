import { useEffect, useState } from 'react'
import { useScenarios } from '../../../useScenarios'
import { DIRECTOR_PHASE, useDemoDirector } from '../../../useDemoDirector'

// Hardcoded one-line descriptions, not fetched. Written from the scenario ids' own names,
// deliberately
// without opening the scenario JSON files — those carry `hidden_truth`, the answer key, and
// the rule is not "don't render it", it's "don't go anywhere near it" while writing this panel.
const DESCRIPTIONS = {
  communication_failure: 'a network interface degrades — handshakes start failing, sessions drop.',
  contactor_failure: 'a contactor sticks — sessions trip to FAULTED mid-charge.',
  cooling_failure: 'cooling degrades — temperature climbs toward the protection threshold.',
  cooling_failure_unrecoverable: 'cooling fails outright and cannot be restarted — expect escalation.',
}

const OUTCOME_COLOR = {
  RESOLVED: 'text-mint',
  ESCALATED: 'text-amber',
  FAILED: 'text-rose',
}

// One line per director phase the operator can be sitting in — plain English, never the raw
// enum, never a percentage or a countdown (Invariant 3: no wall-clock/derived timing on
// screen, only "what step are we on").
const STEP_LABEL = {
  [DIRECTOR_PHASE.RESETTING]: 'resetting the world…',
  [DIRECTOR_PHASE.CONFIRMING_RESET]: 'confirming the reset…',
  [DIRECTOR_PHASE.LAUNCHING]: 'launching the scenario…',
  [DIRECTOR_PHASE.AWAITING_INCIDENT]: 'waiting for the fault to open an incident…',
  [DIRECTOR_PHASE.FOLLOWING]: 'following the agent…',
}

// The left-rail Scenarios panel: the one-click Demo Director (P4), then the manual launcher +
// golden-run table underneath, untouched and still fully usable — the director is an addition,
// never a replacement, exactly per the brief ("do not disable the manual controls"). `POST
// /scenarios/run` resets the world, so the manual button confirms first; the director's own
// button doesn't need a second confirm, since starting it IS the one deliberate action that
// commits to a reset. `onRunLaunched` bumps the
// snapshot's incident window etc. by nothing special — the next `/world` poll picks it up like
// any other world change; it exists only so `useScenarios` can refresh its two GETs afterward.
export default function ScenariosPanel({ onRunLaunched, onOpenReplay }) {
  const [refreshToken, setRefreshToken] = useState(0)
  const { scenarioIds, goldenRuns, error } = useScenarios(refreshToken)
  const [seeds, setSeeds] = useState({})
  const [busyId, setBusyId] = useState(null)
  const [status, setStatus] = useState(null)
  const director = useDemoDirector()
  const [directorScenarioId, setDirectorScenarioId] = useState('')

  // Default to the first scenario the moment the list loads, so the control is genuinely
  // one-click — but only ever while nothing has been picked yet, never overriding an operator's
  // own choice.
  useEffect(() => {
    if (!directorScenarioId && scenarioIds.length > 0) setDirectorScenarioId(scenarioIds[0])
  }, [scenarioIds, directorScenarioId])

  // The director's own run resets the world exactly like every manual run does — refresh the
  // golden-run table the same way `onRunLaunched` already does for a manual run: once right as
  // the director commits to a reset (matching the manual button's own timing), and again once
  // the run reaches a terminal status, since that is when the backend actually persists the
  // golden-run row — refreshing only at launch would never show the run this director just
  // drove.
  useEffect(() => {
    if (director.phase === DIRECTOR_PHASE.RESETTING || director.phase === DIRECTOR_PHASE.DONE) {
      onRunLaunched?.()
      setRefreshToken((t) => t + 1)
    }
  }, [director.phase, onRunLaunched])

  async function run(scenarioId) {
    if (!window.confirm(`Run "${scenarioId}"? This resets the world first.`)) return
    setBusyId(scenarioId)
    setStatus(null)
    try {
      const seedRaw = seeds[scenarioId]
      const body = { scenario_id: scenarioId }
      if (seedRaw !== undefined && seedRaw !== '') body.seed = Number(seedRaw)
      const res = await fetch('/scenarios/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      setStatus(res.ok ? `${scenarioId} running${data.run_id ? ` (${data.run_id})` : ''}` : data.detail ?? 'rejected')
      onRunLaunched?.()
      setRefreshToken((t) => t + 1)
    } catch (e) {
      setStatus(e.message)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {/* P4 — the one-click Demo Director. Everything below (manual per-scenario RUN buttons,
          golden-run table) is untouched and stays fully usable at all times, whether or not
          this is running — an addition, not a replacement. */}
      <div className="flex flex-col gap-2 rounded border border-violet/40 bg-violet/5 p-2.5">
        <h3 className="text-[13px] tracking-[0.14em] text-violet">DEMO DIRECTOR</h3>
        {director.isRunning ? (
          <div className="flex flex-col gap-2">
            <p className="text-[13px] text-ink">{STEP_LABEL[director.phase] ?? 'working…'}</p>
            <button
              onClick={director.abort}
              className="rounded border border-rose/50 px-2 py-1.5 text-[13px] tracking-[0.14em] text-rose transition-colors hover:bg-rose/10"
            >
              ■ ABORT
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <select
              value={directorScenarioId}
              onChange={(e) => setDirectorScenarioId(e.target.value)}
              disabled={scenarioIds.length === 0}
              className="rounded border border-edge bg-void px-1.5 py-1.5 text-[13px] text-ink disabled:opacity-50"
            >
              {scenarioIds.length === 0 && <option value="">no scenarios</option>}
              {scenarioIds.map((id) => (
                <option key={id} value={id}>{id}</option>
              ))}
            </select>
            <button
              onClick={() => director.start(directorScenarioId)}
              disabled={!directorScenarioId}
              className="rounded border border-violet/60 bg-violet/10 px-2 py-1.5 text-[13px] tracking-[0.14em] text-violet transition-colors hover:bg-violet/20 disabled:opacity-50"
            >
              ► RUN DIRECTED DEMO
            </button>
            {director.phase === DIRECTOR_PHASE.DONE && (
              <p className={`text-[13px] ${OUTCOME_COLOR[director.outcome] ?? 'text-dim'}`}>
                run reached {director.outcome}.
              </p>
            )}
            {director.phase === DIRECTOR_PHASE.FAILED && (
              <p className="text-[13px] text-rose">{director.message} — continue manually below.</p>
            )}
            {director.phase === DIRECTOR_PHASE.IDLE && director.message && (
              <p className="text-[13px] text-dim">{director.message}</p>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2">
        {scenarioIds.length === 0 && <p className="text-[11px] text-dim">{error ? `scenarios unavailable: ${error}` : 'loading…'}</p>}
        {scenarioIds.map((id) => (
          <div key={id} className="flex flex-col gap-1 rounded border border-edge/70 p-2">
            <span className="text-[13px] text-ink">{id}</span>
            <span className="text-[11px] text-dim">{DESCRIPTIONS[id] ?? '—'}</span>
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                placeholder="seed"
                value={seeds[id] ?? ''}
                onChange={(e) => setSeeds((s) => ({ ...s, [id]: e.target.value }))}
                className="w-20 rounded border border-edge bg-void px-1.5 py-1 text-[11px] text-ink"
              />
              <button
                onClick={() => run(id)}
                disabled={busyId === id}
                className="flex-1 rounded border border-violet/50 px-2 py-1 text-[11px] tracking-[0.14em] text-violet transition-colors hover:bg-violet/10 disabled:opacity-50"
              >
                {busyId === id ? 'RUNNING…' : 'RUN'}
              </button>
            </div>
          </div>
        ))}
        {status && <p className="text-[11px] text-dim/80">{status}</p>}
      </div>

      <div className="flex flex-col gap-1 border-t border-edge/70 pt-2">
        <h3 className="text-[11px] tracking-[0.14em] text-dim">GOLDEN RUNS</h3>
        {goldenRuns.length === 0 && <p className="text-[11px] text-dim/70">none recorded yet.</p>}
        {goldenRuns.map((r) => (
          // Two lines, not one cramped three-column row, since the left rail is only
          // 260px: run_id + outcome on top, scenario_id below — nothing here truncates or
          // clips at that width. Rows are clickable to replay: a real <button>, not a
          // `div` with onClick, so the row is keyboard-
          // focusable — same two-line layout, just wrapped instead of re-laid-out.
          <button
            key={r.run_id}
            type="button"
            onClick={() => onOpenReplay?.(r.run_id)}
            className="flex flex-col rounded text-left text-[11px] transition-colors hover:bg-ice/5 focus-visible:outline focus-visible:outline-1 focus-visible:outline-ice/60"
          >
            <div className="flex items-center justify-between">
              <span className="text-ink/80">{r.run_id}</span>
              <span className={OUTCOME_COLOR[r.outcome] ?? 'text-dim'}>{r.outcome}</span>
            </div>
            <span className="text-dim">{r.scenario_id ?? '—'}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
