import { useRun } from '../useRun'

// An operational timeline — sim timestamp, tool call, result, policy verdict. Never raw
// model reasoning (the backend's tool_log has none to show). A visible policy rejection
// followed by the agent adapting is deliberately the most prominent line style here — it is,
// per the spec, "the single most convincing thing on screen."
export default function AgentTimeline({ runId }) {
  const run = useRun(runId)

  return (
    <section className="border border-zinc-800 rounded p-3 flex flex-col gap-2 overflow-y-auto max-h-[28rem]">
      <h2 className="text-xs tracking-widest text-zinc-500">AGENT ACTIVITY</h2>
      {!runId && <p className="text-xs text-zinc-600">No agent run yet.</p>}
      {runId && !run && <p className="text-xs text-zinc-600">loading…</p>}
      {run && run.tool_log.length === 0 && (
        <p className="text-xs text-zinc-600">Run {run.run_id} started — waiting for the first tool call…</p>
      )}
      <ol className="flex flex-col gap-1.5 text-xs">
        {run?.tool_log.map((entry, i) => (
          <li key={i} className="border-l-2 pl-2" style={{ borderColor: entry.rejected ? '#ef4444' : '#3f3f46' }}>
            <div className="text-zinc-600">t={entry.sim_time.toFixed(0)}s{entry.forced ? ' · forced' : ''}</div>
            {entry.rejected ? (
              <div className="text-red-400">
                ✗ POLICY REJECTED — {entry.tool}({fmtArgs(entry.args)}) → {entry.reason}: {entry.message}
              </div>
            ) : (
              <div className="text-zinc-300">
                {entry.tool}({fmtArgs(entry.args)}) → <span className="text-zinc-500">{fmtResult(entry.result)}</span>
              </div>
            )}
          </li>
        ))}
      </ol>
    </section>
  )
}

function fmtArgs(args) {
  return Object.entries(args ?? {}).map(([k, v]) => `${k}=${v}`).join(', ')
}

function fmtResult(result) {
  if (result == null) return ''
  if (typeof result === 'object') return JSON.stringify(result)
  return String(result)
}
