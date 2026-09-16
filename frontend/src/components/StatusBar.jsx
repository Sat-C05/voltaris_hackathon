import { useState } from 'react'
import CornerTicks from './CornerTicks'
import { useRun } from '../useRun'
import { derivePhase, selectIncident, selectRunId, PHASE, PHASE_SEGMENTS } from '../lib/phase'

// Dark-mode toggle (dark-mode-toggle round). Deliberately NOT a React context or a JS theme
// object — see palette.js's own comment for why: `StationPillar` is memoized with a
// `signature()` comparator that has no theme field, so a context re-render wouldn't repaint any
// pillar without also teaching that comparator about theme. Toggling a `data-theme` attribute on
// `<html>` needs no re-render at all; every colour in index.css's `--v-*` custom properties
// updates the instant the attribute changes, wherever it's used (Tailwind classes, raw SVG
// `fill`/`stroke`, CSS gradients alike). This component's own `useState` exists only to redraw
// the toggle's own label/glyph, never to drive any other component's colours.
const THEME_KEY = 'voltaris-theme'

// Light is the default, full stop — deliberately NOT read from the OS/browser preference (fix
// B, dark-mode-toggle round): a machine-dependent default would make a first-time visitor's
// theme, and therefore the demo, depend on whatever machine happens to open the deck, which is
// exactly wrong for a projector laptop nobody has configured. The only source of "dark" is an
// explicit `data-theme="dark"` already on `<html>` — set either by a previous click of this same
// toggle (persisted to `localStorage`, restored by `index.html`'s pre-paint script) or, within
// this session, by the toggle itself.
function readTheme() {
  if (typeof document === 'undefined') return 'light'
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
}

function ThemeToggle() {
  const [theme, setTheme] = useState(readTheme)

  function toggle() {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    document.documentElement.setAttribute('data-theme', next)
    try {
      localStorage.setItem(THEME_KEY, next)
    } catch {
      // Private-browsing / storage-disabled: the toggle still works for this page load, it just
      // won't be remembered on the next one. Never let a storage failure break the toggle.
    }
  }

  return (
    <button
      onClick={toggle}
      title={theme === 'dark' ? 'switch to light mode' : 'switch to dark mode'}
      className="rounded-sm border border-edge px-1.5 py-0.5 text-[11px] tracking-widest text-ink/80 transition-colors hover:bg-edge/60 hover:text-ink"
    >
      {theme === 'dark' ? '☾ DARK' : '☀ LIGHT'}
    </button>
  )
}

// Verified against the live backend: ×60 and ×120 both measured exact (300 and 600
// sim-seconds per 5 real seconds). `POST /clock/scale` accepts any positive value and only
// changes how fast wall-clock time delivers ticks — TICK_SIM_SECONDS is untouched.
const SCALES = [1, 30, 60, 120]
const PAUSE_SCALE = 0.0001 // no pause endpoint exists — "pause" is scale set very low.
// The terminal incident statuses, verbatim from `TERMINAL_STATUSES` in
// backend/pipeline/incident.py. There is no 'CLOSED' status anywhere in this system — an
// incident retired by triage is written RESOLVED or ESCALATED with a `closure_reason` set.
const TERMINAL_INCIDENT_STATUSES = ['RESOLVED', 'ESCALATED', 'FAILED']

function fmtSim(seconds) {
  const s = Math.floor(seconds % 60)
  const m = Math.floor(seconds / 60) % 60
  const h = Math.floor(seconds / 3600)
  return `T+${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

async function setScale(scale) {
  await fetch('/clock/scale', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scale }),
  })
}

function Divider() {
  return <div className="h-8 w-px shrink-0 bg-edge" />
}

// A small instrument: a label above, a value below, monospace and tabular — the same shape a
// telemetry readout uses on a real instrument panel. Used for both the station/incident counts.
function Readout({ label, value, tone = 'text-ink' }) {
  return (
    <div className="flex flex-col items-center gap-0.5 px-3">
      <span className="text-[10px] tracking-[0.18em] text-dim">{label}</span>
      <span className={`font-mono text-[16px] leading-none tabular-nums ${tone}`}>{value}</span>
    </div>
  )
}

// Tone per lit phase — existing palette classes only (Invariant 4), the same ones already used
// elsewhere in this file for the same meanings: `text-ice`/`bg-ice` is this file's default
// "instrument active" accent (SCALE buttons, the product-mark dot), `mint`/`amber`/`rose` are
// already this file's RESOLVED-ish/ESCALATED-ish/error tones (the LINK dot, the INCIDENTS
// readout). A phase with no entry here (every non-terminal one) falls through to DEFAULT_TONE —
// there is no fourth terminal tone to guess at.
const PHASE_TONE = {
  [PHASE.RESOLVED]: { text: 'text-mint', dot: 'bg-mint' },
  [PHASE.ESCALATED]: { text: 'text-amber', dot: 'bg-amber' },
  [PHASE.FAILED]: { text: 'text-rose', dot: 'bg-rose' },
}
const DEFAULT_TONE = { text: 'text-ice', dot: 'bg-ice' }

// The terminal segment's label is static ("RESOLVED/ESCALATED", the pipeline's own two named
// outcomes) until the phase actually IS one of the three terminal PHASE values, at which point
// it names the real one — including FAILED, which the pipeline strip doesn't have a dedicated
// box for but TERMINAL_INCIDENT_STATUSES (below) does track. Never a guess: this only ever
// reads `phase`, which `derivePhase` already computed from `incident.status`.
function terminalLabel(phase) {
  if (phase === PHASE.RESOLVED) return 'RESOLVED'
  if (phase === PHASE.ESCALATED) return 'ESCALATED'
  if (phase === PHASE.FAILED) return 'FAILED'
  return 'RESOLVED/ESCALATED'
}

// The phase strip: `src/lib/phase.js` derives one PHASE value, total and pure (see that file's
// header comment for the full table); this component only turns that single value into pixels.
// Exactly one segment lights at a time — never a filled trail — because a terminal phase can be
// reached without passing through every intermediate segment (phase.js's invariant note). CSS
// `transition-colors` moves the lit state between renders; no keyframes (index.css is not
// this package's to edit).
function PhaseStrip({ phase }) {
  return (
    <div
      className="flex items-center justify-center gap-1.5 border-t border-edge/70 px-4 py-1.5"
      title="pipeline phase"
    >
      {PHASE_SEGMENTS.map((segment, i) => {
        const lit = segment.matches.includes(phase)
        const tone = lit ? (PHASE_TONE[phase] ?? DEFAULT_TONE) : null
        const label = segment.key === 'TERMINAL' ? terminalLabel(phase) : segment.label
        return (
          <div key={segment.key} className="flex items-center gap-1.5">
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full transition-colors duration-300 ${
                lit ? tone.dot : 'bg-edge'
              }`}
            />
            <span
              className={`whitespace-nowrap font-mono text-[13px] tracking-[0.1em] transition-colors duration-300 ${
                lit ? tone.text : 'text-dim/70'
              }`}
            >
              {label}
            </span>
            {i < PHASE_SEGMENTS.length - 1 && (
              <span className="text-[13px] text-dim/50">→</span>
            )}
          </div>
        )
      })}
    </div>
  )
}

// The status bar, built as a mission-control instrument strip rather than a flat row of
// marks, clocks, buttons and counts. Same data either way — this is presentation only, nothing here reads
// anything `/world` didn't already carry. `snapshot.sim_time` is still the only clock on
// screen (Invariant 1).
export default function StatusBar({ snapshot, error }) {
  const [preScale, setPreScale] = useState(30)
  const scale = snapshot?.clock?.scale
  const paused = typeof scale === 'number' && scale <= PAUSE_SCALE * 10

  const stationCount = snapshot ? Object.keys(snapshot.stations).length : 0
  const openIncidents = snapshot
    ? (snapshot.incidents ?? []).filter((i) => !TERMINAL_INCIDENT_STATUSES.includes(i.status)).length
    : 0

  // Phase strip: the incident/run selection and the tool_log-based DIAGNOSE/INVESTIGATE split
  // both live in src/lib/phase.js (the one place that derivation happens). `useRun` is the same
  // 500ms poller AgentTimeline.jsx already uses, called directly here per the brief — no state
  // added to DeckApp.jsx, no second poller. A `null` runId (no incident yet) makes `useRun`
  // return `null` immediately without ever issuing a fetch (see useRun.js's own guard), and
  // `derivePhase` reads that `null` defensively (Invariant 10) rather than assuming a shape.
  const phaseIncident = selectIncident(snapshot)
  const phaseRunId = selectRunId(snapshot, phaseIncident)
  const phaseRun = useRun(phaseRunId)
  const phase = derivePhase(snapshot, phaseRun)

  const togglePause = () => {
    if (paused) {
      setScale(preScale)
    } else {
      if (typeof scale === 'number') setPreScale(scale)
      setScale(PAUSE_SCALE)
    }
  }

  return (
    <header className="relative flex shrink-0 flex-col border-b border-edge bg-void text-dim">
      <div className="pointer-events-none absolute inset-x-2 inset-y-1.5">
        <CornerTicks className="border-edge" />
      </div>
      {/* a thin accent rule under the whole strip — the one hairline that says "instrument" */}
      <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-ice/40 to-transparent" />

      <div className="flex h-14 items-stretch justify-between px-4">
        {/* LEFT CLUSTER — product mark */}
        <div className="flex items-center gap-2 pr-4">
          <span className="h-1.5 w-1.5 rounded-full bg-ice" />
          <div className="flex flex-col leading-none">
            <span className="text-[13px] tracking-[0.22em] text-ink">VOLTARIS</span>
            <span className="text-[9px] tracking-[0.24em] text-dim">AUTONOMOUS NOC</span>
          </div>
        </div>

        <Divider />

        {/* CENTRE CLUSTER — the sim clock, the primary instrument, and the scale control */}
        <div className="flex flex-1 items-center justify-center gap-4">
          <div className="flex flex-col items-center leading-none">
            <span className="text-[9px] tracking-[0.22em] text-dim">SIM TIME</span>
            <span className="font-mono text-[28px] leading-tight tabular-nums text-ice">
              {snapshot ? fmtSim(snapshot.sim_time) : '—'}
            </span>
          </div>

          <div className="flex flex-col items-center gap-1">
            <span className="text-[9px] tracking-[0.22em] text-dim">SCALE</span>
            <div className="flex items-center gap-0.5 rounded border border-edge bg-deck/60 p-0.5">
              <button
                onClick={togglePause}
                title="pause / resume (no pause endpoint — sets scale very low)"
                className="rounded-sm px-1.5 py-0.5 text-[11px] tracking-widest text-ink/80 hover:bg-edge/60"
              >
                {paused ? '▸' : '▮▮'}
              </button>
              <div className="h-4 w-px bg-edge" />
              {SCALES.map((s) => (
                <button
                  key={s}
                  onClick={() => setScale(s)}
                  className={`rounded-sm px-1.5 py-0.5 text-[11px] tracking-widest transition-colors ${
                    !paused && scale === s ? 'bg-ice/20 text-ice' : 'text-ink/65 hover:bg-edge/60'
                  }`}
                >
                  ×{s}
                </button>
              ))}
            </div>
          </div>
        </div>

        <Divider />

        {/* RIGHT CLUSTER — telemetry readouts + live indicator */}
        <div className="flex items-center pl-2">
          <Readout label="STATIONS" value={stationCount} />
          <Readout label="INCIDENTS" value={openIncidents} tone={openIncidents > 0 ? 'text-amber' : 'text-ink'} />
          <div className="flex flex-col items-center gap-0.5 pl-3">
            <span className="text-[10px] tracking-[0.18em] text-dim">LINK</span>
            <span
              title={error ? `/world poll failing: ${error}` : 'live'}
              className={`h-2 w-2 rounded-full ${error ? 'bg-rose animate-pulse' : 'bg-mint'}`}
            />
          </div>
          <div className="flex flex-col items-center gap-0.5 pl-3">
            <span className="text-[10px] tracking-[0.18em] text-dim">THEME</span>
            <ThemeToggle />
          </div>
        </div>
      </div>

      <PhaseStrip phase={phase} />
    </header>
  )
}
