const SEVERITY_COLOR = {
  HIGH: 'text-red-400',
  MEDIUM: 'text-amber-400',
  LOW: 'text-zinc-500',
  INFO: 'text-zinc-600',
}

// The EVENT LOG — the append-only display log, never a rendering input
//. Newest at the bottom, like a real log tail.
export default function EventLog({ events }) {
  return (
    <section className="border border-zinc-800 rounded p-3 flex flex-col gap-1 overflow-y-auto max-h-64">
      <h2 className="text-xs tracking-widest text-zinc-500 mb-1">EVENT LOG</h2>
      {events.length === 0 && <p className="text-xs text-zinc-600">No events yet.</p>}
      <div className="flex flex-col gap-0.5 text-[11px] font-mono">
        {events.map((e) => (
          <div key={e.event_id} className={SEVERITY_COLOR[e.severity] ?? 'text-zinc-500'}>
            <span className="text-zinc-600">t={e.sim_time.toFixed(0)}s</span>{' '}
            <span className="text-zinc-400">{e.source}</span> {e.type}
            {e.previous_state && <span className="text-zinc-600"> {e.previous_state}→{e.new_state}</span>}
          </div>
        ))}
      </div>
    </section>
  )
}
