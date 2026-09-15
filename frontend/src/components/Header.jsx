const SCALES = [10, 30, 60]

function fmtSim(seconds) {
  const s = Math.floor(seconds % 60)
  const m = Math.floor(seconds / 60) % 60
  const h = Math.floor(seconds / 3600)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

// The header: sim clock + scale selector. `sim_time` is the only clock the frontend ever
// displays — never wall-clock.
export default function Header({ snapshot }) {
  const setScale = async (scale) => {
    await fetch('/clock/scale', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scale: Number(scale) }),
    })
  }

  return (
    <header className="flex items-baseline justify-between border-b border-zinc-800 pb-3">
      <h1 className="text-lg tracking-widest">EV AUTONOMOUS NOC</h1>
      <div className="flex items-center gap-3 text-sm text-zinc-400">
        {snapshot ? (
          <>
            <span>sim {fmtSim(snapshot.sim_time)}</span>
            <select
              className="bg-zinc-900 border border-zinc-700 rounded px-1.5 py-0.5 text-xs"
              value={snapshot.clock.scale}
              onChange={(e) => setScale(e.target.value)}
            >
              {SCALES.map((s) => <option key={s} value={s}>{s}x</option>)}
            </select>
          </>
        ) : '—'}
      </div>
    </header>
  )
}
