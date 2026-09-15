import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useReplay } from '../../../useReplay'
import { ToolRow, VerdictStrip } from './AgentConsoleWindow'
import { fmtSimClock } from './format'

// Same outcome→colour mapping as ScorecardWindow/IncidentWindow — escalation is amber, never
// rose (Invariant 8: "escalation is a success outcome").
const OUTCOME_TONE = {
  RESOLVED: 'text-mint',
  ESCALATED: 'text-amber',
  FAILED: 'text-rose',
}

// Discrete speed factors for the transport, and the pace ×1 actually walks at (sim-seconds
// per wall-second). Derived from this feature's own worked example: a recording spans roughly
// 90 -> 9315 sim-seconds, a ~9225-second run — 9225 / 75 ≈ 123 sim-seconds per wall-second lands
// in the middle of the "watchable in ~60-90s" window the task sets, so BASE_PACE is rounded to
// a plainer 120 (two sim-minutes per wall-second): 9225 / 120 ≈ 77s at ×1. ×4 and ×16 exist to
// skip ahead through the longer runs on record (an ESCALATED recording, RUN-062, spans to
// sim_time 27165 — ~226s at ×1, ~14s at ×16 — verified live against the backend).
const BASE_PACE = 120
const SPEEDS = [1, 4, 16]

const FILTERS = ['ALL', 'TOOL CALLS']

// The one wall-clock VALUE this feature displays — `recorded_at` is a recording timestamp, not
// sim-time, so it is labelled "recorded" wherever it appears and never fed through fmtSimClock.
// Plain string reshaping of the ISO string the backend already sent, not a `Date` object built
// from it — there is nothing here that could be mistaken for a live "now".
function fmtRecordedAt(iso) {
  return iso ? iso.replace('T', ' ').replace('Z', ' UTC') : '—'
}

// The replay player. Source: one `POST /runs/{id}/replay`
// recording, fetched once by `useReplay` and never polled — it is a frozen log, not live state.
// This window drives nothing but its own scroll position and playhead: it never touches
// `/world`, `/faults`, `/scenarios` or any other endpoint, so by construction it cannot affect
// the live simulation (task requirement: "replay must not touch the world").
export default function ReplayWindow({ runId }) {
  const { recording, error } = useReplay(runId)

  const [position, setPosition] = useState(0) // sim-seconds walked so far — NOT a sim_time off
  // some live clock; this window has no snapshot at all, it is the recording's own timeline.
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [filter, setFilter] = useState('ALL')

  const timerRef = useRef(null)
  const lastFrameRef = useRef(null)

  const log = recording?.log ?? []
  const lastSimTime = log.length > 0 ? log[log.length - 1].sim_time : 0

  useEffect(() => {
    setPosition(0)
    setPlaying(false)
  }, [runId])

  // The pacing loop — Invariant 1's one sanctioned wall-clock use ("wall-clock is allowed only
  // inside polling/animation timers"). `performance.now()` rather than `Date.now()`: it is
  // monotonic (immune to a system clock step) and, just as importantly, reads as an elapsed-
  // time measurement rather than a timestamp, which is the whole point of the distinction this
  // project draws — nothing computed from it is ever displayed, only `position`, which is
  // always formatted through `fmtSimClock` below.
  // Deliberately a 100ms interval rather than `requestAnimationFrame`. The playhead drives a
  // `setPosition`, and every commit re-filters the whole recording and re-renders every
  // revealed row — at 60fps against a 524-entry recording (RUN-062) that is tens of thousands
  // of element diffs a second, running *alongside* the 500ms snapshot poll and the deck's own
  // CSS animations. That is precisely the class of problem the performance rules here exist
  // to head off, and a dropped-frame demo is the failure mode this whole feature is insurance
  // against. 10Hz is imperceptible for a log playhead and a slowly-sweeping scrub bar, and it
  // costs ~6x less work per second. Elapsed time still comes from `performance.now()` deltas,
  // so the pacing stays correct even if a tick is late.
  useEffect(() => {
    if (!playing) return
    lastFrameRef.current = performance.now()
    timerRef.current = setInterval(() => {
      const now = performance.now()
      const deltaMs = now - lastFrameRef.current
      lastFrameRef.current = now
      setPosition((p) => {
        const next = p + (deltaMs / 1000) * speed * BASE_PACE
        if (next >= lastSimTime) {
          setPlaying(false)
          return lastSimTime
        }
        return next
      })
    }, 100)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [playing, speed, lastSimTime])

  function handlePlayPause() {
    if (position >= lastSimTime && lastSimTime > 0) setPosition(0) // replay from the top
    setPlaying((p) => !p)
  }
  function handleRestart() {
    setPlaying(false)
    setPosition(0)
  }
  function handleSeek(e) {
    setPlaying(false)
    setPosition(Number(e.target.value))
  }

  // Reveal only entries at or before the current playhead (task requirement, verbatim) — this
  // is the only place `position` is compared against log data; nothing else in this file reads
  // ahead of it.
  const revealed = log.filter((e) => e.sim_time <= position && (filter === 'ALL' || e.kind === 'TOOL_CALL'))
  const atEnd = lastSimTime > 0 && position >= lastSimTime

  // Auto-scroll to the newest revealed row unless the user has scrolled up — the same rule
  // the Agent Console follows, mirrored here rather than shared: that logic lives
  // inline inside AgentConsoleWindow.jsx (a `useLayoutEffect` plus a couple of refs, not a
  // hook of its own), and extracting it into a shared hook risked touching how the live
  // console's own autoscroll behaves, which is explicitly out of scope for this task.
  const scrollRef = useRef(null)
  const [atBottom, setAtBottom] = useState(true)
  const prevLenRef = useRef(0)
  useLayoutEffect(() => {
    const grew = revealed.length - prevLenRef.current
    prevLenRef.current = revealed.length
    if (grew <= 0) return
    const el = scrollRef.current
    if (atBottom && el) el.scrollTop = el.scrollHeight
  }, [revealed.length, atBottom])
  function handleScroll() {
    const el = scrollRef.current
    if (!el) return
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 24)
  }

  if (!recording) {
    return <div className="text-dim">{error ? 'replay unavailable' : 'loading recording…'}</div>
  }

  return (
    <div className="flex flex-col gap-1.5">
      {/* "A judge must never mistake a replay for a live run" — violet (harness/scenario
          chrome), deliberately not mint/amber/rose since those carry outcome meaning. */}
      <div className="w-fit rounded border border-violet/40 bg-violet/10 px-1.5 py-0.5 text-[11px] tracking-[0.14em] text-violet">
        ▶ REPLAY · RECORDED
      </div>

      <div className="flex flex-col gap-0.5">
        <div className="flex items-baseline justify-between">
          <span className="text-ink">{recording.run_id}</span>
          <span className="text-dim">{recording.scenario_id ?? '—'}</span>
        </div>
        <div className="flex items-baseline justify-between">
          <span className={`font-medium tracking-wide ${OUTCOME_TONE[recording.outcome] ?? 'text-ink'}`}>
            {recording.outcome}
          </span>
          <span className="text-[11px] text-dim">recorded {fmtRecordedAt(recording.recorded_at)}</span>
        </div>
      </div>

      <div className="border-t border-edge/70" />

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={handlePlayPause}
          className="rounded border border-ice/50 px-2 py-0.5 text-[11px] tracking-wide text-ice hover:bg-ice/10"
        >
          {playing ? '❙❙ PAUSE' : atEnd ? '▶ REPLAY' : '▶ PLAY'}
        </button>
        <button
          onClick={handleRestart}
          className="rounded border border-edge px-2 py-0.5 text-[11px] tracking-wide text-dim hover:text-ink"
        >
          ↺ RESTART
        </button>
        <div className="flex items-center gap-1">
          {SPEEDS.map((s) => (
            <button
              key={s}
              onClick={() => setSpeed(s)}
              className={`rounded border px-1.5 py-0.5 text-[11px] ${speed === s ? 'border-ice/60 text-ice' : 'border-edge text-dim hover:text-ink'}`}
            >
              ×{s}
            </button>
          ))}
        </div>
      </div>

      {/* Cheap scrub: a controlled range input over sim-seconds, since `position` is already
          the single source of truth the pacing loop writes to — no separate seek state. */}
      <input
        type="range"
        min={0}
        max={lastSimTime}
        step={1}
        value={Math.min(position, lastSimTime)}
        onChange={handleSeek}
        className="h-1 w-full accent-ice"
        aria-label="replay position"
      />
      <div className="flex items-baseline justify-between text-[11px] text-dim">
        <span className="tabular-nums">{fmtSimClock(position)} of {fmtSimClock(lastSimTime)}</span>
        {atEnd && <span className="text-ice">END OF RUN</span>}
      </div>

      <div className="border-t border-edge/70" />

      {/* 241 events to 11 tool calls in a typical recording (verified against RUN-066)
          — a plain filter toggle rather than relying on visual weighting alone, so
          a judge who wants straight to the bounded-autonomy proof (the tool calls) can get
          there without scrolling past hundreds of STATUS_NOTIFICATION rows. EVENT rows are
          still rendered dimmer and smaller than a ToolRow even in ALL mode (see EventRow
          below), so the toggle is a convenience on top of that, not the only defence. */}
      <div className="flex items-center gap-1">
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded border px-1.5 py-0.5 text-[11px] tracking-wide ${filter === f ? 'border-ice/60 text-ice' : 'border-edge text-dim hover:text-ink'}`}
          >
            {f}
          </button>
        ))}
      </div>

      {/* Same scroll cap as AgentConsoleWindow's own tool log — the log's scroll height is
          capped so a long run cannot grow the window down the screen. */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="relative flex max-h-64 flex-col gap-1 overflow-y-auto"
      >
        {revealed.length === 0 && <p className="py-2 text-[13px] text-dim">press play — nothing revealed before T+00:00:00</p>}
        {revealed.map((entry, i) => (
          entry.kind === 'TOOL_CALL'
            ? (entry.payload.tool === 'propose_resolution'
                ? <VerdictStrip key={i} entry={entry.payload} />
                : <ToolRow key={i} entry={entry.payload} />)
            : <EventRow key={i} event={entry.payload} simTime={entry.sim_time} />
        ))}
      </div>
    </div>
  )
}

// A compact, deliberately secondary row for one EVENT entry — dimmer and smaller than a
// ToolRow, since these are the pipeline's raw state-change record (`/events` is a display log
// only), not proof of anything the agent decided. sim-clock, type, source, and the
// previous->new transition when the payload actually carries both (many EVENT payloads, e.g.
// METER_VALUES, carry neither — verified against RUN-066's real log).
function EventRow({ event, simTime }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 py-0.5 pl-2 text-[11px] text-dim/60">
      <span className="tabular-nums">{fmtSimClock(simTime)}</span>
      <span>{event.type}</span>
      <span>{event.source}</span>
      {event.previous_state != null && event.new_state != null && (
        <span>{event.previous_state} → {event.new_state}</span>
      )}
    </div>
  )
}
