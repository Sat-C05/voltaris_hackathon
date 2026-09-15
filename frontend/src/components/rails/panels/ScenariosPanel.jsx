import { useState } from 'react'
import { useScenarios } from '../../../useScenarios'

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

// The left-rail Scenarios panel: launcher + golden-run table. `POST /scenarios/run` resets
// the world, so the button confirms first. `onRunLaunched` bumps the
// snapshot's incident window etc. by nothing special — the next `/world` poll picks it up like
// any other world change; it exists only so `useScenarios` can refresh its two GETs afterward.
export default function ScenariosPanel({ onRunLaunched, onOpenReplay }) {
  const [refreshToken, setRefreshToken] = useState(0)
  const { scenarioIds, goldenRuns, error } = useScenarios(refreshToken)
  const [seeds, setSeeds] = useState({})
  const [busyId, setBusyId] = useState(null)
  const [status, setStatus] = useState(null)

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
