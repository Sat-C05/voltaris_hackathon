import { useState } from 'react'

// The left-rail World Control panel. RESET WORLD was wired first, since without it there is
// no way back to a clean world — kept verbatim, just moved out of `LeftRail.jsx` alongside
// its siblings. Confirm-then-POST, because it throws
// the whole world away (twin, clock, events, incidents) — golden-run recordings survive it.
async function resetWorld(setBusy) {
  if (!window.confirm('Reset the world? This clears the clock, all events and all incidents. Recorded golden runs are kept.')) return
  setBusy(true)
  try {
    await fetch('/world/reset', { method: 'POST' })
  } finally {
    setBusy(false)
  }
}

// Return-to-service: a station the
// agent has isolated (`maintenance_hold: true`) stays silent to admission control until an
// operator lifts the hold — without this control from the deck, the only way back was the
// classic `?classic=1` page.
async function returnToService(id, setBusyId) {
  setBusyId(id)
  try {
    await fetch(`/stations/${id}/return-to-service`, { method: 'POST' })
  } finally {
    setBusyId(null)
  }
}

export default function WorldControlPanel({ stations = {} }) {
  const [busy, setBusy] = useState(false)
  const [busyId, setBusyId] = useState(null)
  const held = Object.entries(stations).filter(([, s]) => s.maintenance_hold)

  return (
    <div className="flex flex-col gap-3">
      <button
        onClick={() => resetWorld(setBusy)}
        disabled={busy}
        className="w-full rounded border border-rose/50 px-2 py-1.5 text-[12px] tracking-[0.18em] text-rose transition-colors hover:bg-rose/10 disabled:opacity-50"
      >
        {busy ? 'RESETTING…' : 'RESET WORLD'}
      </button>

      <div className="flex flex-col gap-1 border-t border-edge/70 pt-2">
        <h3 className="text-[11px] tracking-[0.14em] text-dim">MAINTENANCE HOLDS</h3>
        {held.length === 0 && <p className="text-[11px] text-dim/70">no station is on hold.</p>}
        {held.map(([id]) => (
          <button
            key={id}
            onClick={() => returnToService(id, setBusyId)}
            disabled={busyId === id}
            title="Lift the maintenance hold and return this station to service"
            // Was `border-sky-800`/`text-sky-300`/`hover:bg-sky-900` — a hardcoded Tailwind
            // colour that, like the `zinc-*` classes elsewhere, would not have flipped with the
            // theme (dark-mode-toggle round). `mint` reads as "bringing this station back to a
            // healthy state," matching the same border/text/hover-fill shape the other two
            // action buttons in this rail already use for rose (INJECT FAULT) and violet (RUN).
            className="flex items-center justify-between rounded border border-mint/50 px-2 py-1 text-[11px] tracking-wide text-mint transition-colors hover:bg-mint/10 disabled:opacity-50"
          >
            <span>{id}</span>
            <span>{busyId === id ? 'CLEARING…' : 'RETURN TO SERVICE'}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
