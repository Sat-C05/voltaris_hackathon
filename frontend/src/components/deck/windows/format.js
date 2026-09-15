// Sim-time formatting for window content. Kept local to the window layer rather than shared
// with StatusBar.jsx — same formula, but not worth reaching into an already-working file for
// a one-line convenience. `seconds` must always be a `sim_time`/`*_sim_seconds` value; never
// Date.now(): the UI displays simulated time only.
export function fmtSimClock(seconds) {
  const s = Math.floor(seconds % 60)
  const m = Math.floor(seconds / 60) % 60
  const h = Math.floor(seconds / 3600)
  return `T+${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

// A short *duration*, not a clock time — `fmtSimClock`'s `T+HH:MM:SS` reads wrong for something
// like a detection latency (the Scorecard's `detection_latency_sim_seconds` is a span since
// the fault fired, not a moment on the run's clock). Still a `*_sim_seconds` value,
// just formatted the way a duration reads naturally: `42s`, `3m 12s`, `1h 05m`.
export function fmtSimDuration(seconds) {
  const s = Math.floor(seconds % 60)
  const m = Math.floor(seconds / 60) % 60
  const h = Math.floor(seconds / 3600)
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`
  return `${s}s`
}
