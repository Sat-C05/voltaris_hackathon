import { useLayoutEffect, useRef, useState } from 'react'
import { MAX_CONSECUTIVE_OBSERVATIONS, TOOL_CATEGORY } from '../../../contracts'
import { useAgentLog, useNewArrivals, entryIdentity } from './useAgentLog'
import { summarizeResult, primaryArg, formatPredicate } from './toolLogFormat'
import { fmtSimClock } from './format'
import { PALETTE } from '../../../palette'

// Category display — glyph + label + colour, one of the four existing tokens per
// `TOOL_CATEGORY` (OBSERVATION/DIAGNOSTIC/ACTION/ESCALATION — ice/violet/amber/rose,
// escalating in the same order the categories themselves escalate). This is presentation
// only, layered on top of `TOOL_CATEGORY` (the actual mirror of capabilities.json); `wait` and
// `propose_resolution` are not capabilities at all (confirmed against
// backend/data/capabilities.json), so they get their own entries here rather than a
// TOOL_CATEGORY lookup — unchanged behaviour, just now carrying `tint`/`wash` too so the row
// wrapper below has one place to read the whole category treatment from.
const CATEGORY_META = {
  OBSERVATION: { glyph: '◈', label: 'OBSERVE', className: 'text-ice', tint: 'ice', wash: 'bg-ice/5' },
  DIAGNOSTIC: { glyph: '◈', label: 'DIAGNOSE', className: 'text-violet', tint: 'violet', wash: 'bg-violet/5' },
  ACTION: { glyph: '✦', label: 'ACTION', className: 'text-amber', tint: 'amber', wash: 'bg-amber/5' },
  ESCALATION: { glyph: '⚑', label: 'ESCALATE', className: 'text-rose', tint: 'rose', wash: 'bg-rose/5' },
}
const WAIT_META = { glyph: '⧗', label: 'WAIT', className: 'text-dim', tint: null, wash: '' }

const OBSERVE_CATEGORIES = new Set(['OBSERVATION', 'DIAGNOSTIC'])

// The trailing run of OBSERVATION/DIAGNOSTIC-category calls since the last ACTION/ESCALATION/
// wait — a client-side count of the same thing MAX_CONSECUTIVE_OBSERVATIONS guards against.
// NOT sourced from the snapshot (nothing in `/world` or `GET /runs/{id}` carries the harness's
// own live counter) — derived from the tool_log's own categories, which is real data, just not
// the authoritative one. Spot-checked against a real guardrail trip (RUN-007, INC-001,
// the six tool_log entries immediately preceding the harness-forced
// propose_resolution were exactly six consecutive OBSERVATION-category calls, matching
// MAX_CONSECUTIVE_OBSERVATIONS — but that is one confirmed case, not a proof the counting rule
// matches the harness exactly (e.g. whether a rejected call still counts is unverified).
function observeStreak(toolLog) {
  let n = 0
  for (let i = toolLog.length - 1; i >= 0; i--) {
    const tool = toolLog[i].tool
    if (tool === 'propose_resolution') break
    const category = tool === 'wait' ? null : TOOL_CATEGORY[tool]
    if (category && OBSERVE_CATEGORIES.has(category)) n++
    else break
  }
  return n
}

function MeterBar({ label, used, max, warnAtRemaining = 1 }) {
  const pct = max > 0 ? Math.min(100, (used / max) * 100) : 0
  const warn = max - used <= warnAtRemaining
  return (
    <div className="flex flex-1 items-center gap-2">
      <span className="w-24 shrink-0 text-[11px] tracking-[0.1em] text-dim">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-sm border border-edge/70 bg-void">
        <div
          className={`h-full ${warn ? 'bg-amber' : 'bg-ice'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={`w-12 shrink-0 text-right text-[11px] ${warn ? 'text-amber' : 'text-dim'}`}>
        {used}/{max}
      </span>
    </div>
  )
}

// Row padding/gaps tightened (agent-window-size round: "make the window itself lighter, not
// just narrower") — `py-1` → `py-0.5`, no field removed, just less air between rows.
//
// Exported for ReplayWindow.jsx: a replay's TOOL_CALL log entry is field-for-field the same
// shape as a live `tool_log` entry (verified against a real recording), so the replay player
// reuses this row unchanged rather than writing a
// second renderer. Nothing about how it renders here for the live Agent Console changes.
export function ToolRow({ entry, isNew = false }) {
  const isWait = entry.tool === 'wait'
  const meta = entry.rejected
    ? { glyph: '✕', label: 'REJECTED', className: 'text-rose', tint: 'rose', wash: '' }
    : isWait
      ? WAIT_META
      : CATEGORY_META[TOOL_CATEGORY[entry.tool]] ?? { glyph: '•', label: entry.tool, className: 'text-ink/80', tint: null, wash: '' }

  // Row-tint precedence: rejected (policy stopped it) and forced (harness, not the agent, did
  // it) are both more important than which category the tool belongs to, so they override the
  // left-border colour; the category wash (a ~5% background tint) stays category-only, since a
  // rejected/forced row already carries its own dedicated badge/text and doesn't need the
  // border and the background making the same claim twice.
  const borderColor = entry.rejected ? PALETTE.rose : entry.forced ? PALETTE.violet : meta.tint ? PALETTE[meta.tint] : 'transparent'
  const rowClassName = [
    'voltaris-tool-row flex flex-col gap-0.5 border-l-2 py-0.5 pl-2',
    !entry.rejected && !entry.forced ? meta.wash : '',
    isNew ? 'voltaris-reveal' : '',
  ].filter(Boolean).join(' ')

  return (
    <div className={rowClassName} style={{ borderColor }}>
      {entry.forced && (
        <span className="w-fit rounded bg-violet/15 px-1 text-[11px] tracking-[0.12em] text-violet">
          ⚙ HARNESS
        </span>
      )}
      <div className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
        <span className="tabular-nums text-dim">{fmtSimClock(entry.sim_time)}</span>
        <span className={meta.className}>{meta.glyph} {meta.label}</span>
        <span className="text-ink">{entry.tool}</span>
        {!isWait && primaryArg(entry.args) && <span className="text-dim">{primaryArg(entry.args)}</span>}
      </div>

      {entry.rejected ? (
        // These rows are the proof of bounded autonomy — never collapse, truncate or hide
        // them. Reason in caps (already caps from the backend), message verbatim.
        <div className="pl-5 text-[13px]">
          <div className="text-rose">{entry.reason}</div>
          <div className="text-dim">{entry.message}</div>
        </div>
      ) : isWait ? (
        <div className="pl-5 text-[13px] text-dim">
          → {entry.args?.sim_seconds} sim-seconds → {typeof entry.result?.temperature_c === 'number' ? entry.result.temperature_c.toFixed(1) : '—'} °C
        </div>
      ) : (
        <div className="pl-5 text-[13px] text-dim">
          → {summarizeResult(entry.tool, entry.args, entry.result)}
        </div>
      )}
    </div>
  )
}

// Exported alongside ToolRow for the same reason — a replay's `propose_resolution` TOOL_CALL
// entry carries the same `result.passed`/`failed_predicates`/`forced` shape live verification
// does, so ReplayWindow.jsx reuses this verdict strip rather than re-deriving it.
export function VerdictStrip({ entry, isNew = false }) {
  const passed = !!entry.result?.passed
  const predicates = entry.result?.failed_predicates ?? []
  return (
    <div className={`flex flex-col gap-1 rounded border px-2 py-1.5 text-[13px] ${passed ? 'border-mint/40 bg-mint/10' : 'border-amber/40 bg-amber/10'} ${isNew ? 'voltaris-reveal' : ''}`}>
      {/* A verification can itself be harness-forced (verified live: a
          MAX_CONSECUTIVE_OBSERVATIONS guardrail runs propose_resolution on the agent's behalf
          before it force-escalates) — that is the system checking, not the agent asking, and
          losing that distinction would misrepresent what happened. */}
      {entry.forced && (
        <span className="w-fit rounded bg-violet/15 px-1 text-[11px] tracking-[0.12em] text-violet">
          ⚙ HARNESS
        </span>
      )}
      <div className={passed ? 'font-medium text-mint' : 'font-medium text-amber'}>
        ✔ propose_resolution → {passed ? 'VERIFIED BY SYSTEM' : 'NOT VERIFIED'}
      </div>
      {!passed && predicates.length > 0 && (
        <ul className="list-disc pl-5 text-dim">
          {predicates.map((p, i) => <li key={i}>{formatPredicate(p)}</li>)}
        </ul>
      )}
      <div className="text-[11px] italic text-dim">the agent cannot write this result</div>
    </div>
  )
}

// The Agent Console — the centrepiece. Sources: `snapshot.active_run` for live budgets (frozen at their
// last known value once the run ends and `active_run` goes null again) and `GET /runs/{id}` /
// its replay fallback for `tool_log`. Never renders anything but tool calls, arguments,
// results, verdicts and budgets — no model prose, no chain of thought.
export default function AgentConsoleWindow({ runId, stationId, budgets, incidentStatus, incidentEscalationReason }) {
  const isTerminal = incidentStatus != null && incidentStatus !== 'OPEN' && ['RESOLVED', 'ESCALATED', 'FAILED'].includes(incidentStatus)
  const { toolLog, isReplay } = useAgentLog(runId, isTerminal)
  // Keyed on `runId`, not on toolLog identity itself — a live→replay handover (404 fallback,
  // see useAgentLog) keeps the same runId while swapping the array's object references, and
  // content-identical entries there must NOT re-reveal (see useNewArrivals' doc comment).
  const revealed = useNewArrivals(toolLog, runId)

  const scrollRef = useRef(null)
  const [atBottom, setAtBottom] = useState(true)
  const [newSinceScroll, setNewSinceScroll] = useState(0)
  const prevLenRef = useRef(0)

  // Audited in detail after a report of the console not autoscrolling, without finding a
  // logic bug — the length/atBottom bookkeeping below was already correct. Switched
  // from `useEffect` to `useLayoutEffect` anyway: `useEffect` runs after the browser has
  // already painted the new row, so a scroll-to-bottom there can show as a visible one-frame
  // jump instead of an invisible, already-scrolled paint. `useLayoutEffect` runs synchronously
  // after the DOM update but before paint, which is the standard fix for this exact
  // autoscroll-to-bottom pattern. Left unverified beyond this: it is equally possible no
  // live run had yet produced enough rows to overflow the window, since before the left rail
  // was wired there was no way to inject a fault from the deck at all.
  useLayoutEffect(() => {
    const grew = toolLog.length - prevLenRef.current
    prevLenRef.current = toolLog.length
    if (grew <= 0) return
    const el = scrollRef.current
    if (atBottom && el) {
      el.scrollTop = el.scrollHeight
    } else if (grew > 0) {
      setNewSinceScroll((n) => n + grew)
    }
  }, [toolLog.length, atBottom])

  function handleScroll() {
    const el = scrollRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    setAtBottom(nearBottom)
    if (nearBottom) setNewSinceScroll(0)
  }

  function jumpToBottom() {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
    setNewSinceScroll(0)
    setAtBottom(true)
  }

  const guardrailBand = incidentEscalationReason
    ? `${incidentEscalationReason} → the harness took over and isolated the station.`
    : null

  const streak = observeStreak(toolLog)

  return (
    // Outer rhythm tightened from `gap-2` (agent-window-size round) — every field below is
    // still rendered, just with less air between the blocks that carry it.
    <div className="flex flex-col gap-1.5">
      {isReplay && (
        <div className="w-fit rounded border border-violet/40 bg-violet/10 px-1.5 py-0.5 text-[11px] tracking-wide text-violet">
          REPLAY — this run's live memory was cleared by a world reset
        </div>
      )}

      {budgets && (
        <div className="flex flex-col gap-1">
          <MeterBar label="STEPS" used={budgets.steps_used} max={budgets.max_steps} />
          <div className="flex flex-wrap items-center gap-3">
            <MeterBar label="ACTIONS" used={budgets.actions_used} max={budgets.max_actions} />
            <MeterBar label="OBSERVE STREAK" used={streak} max={MAX_CONSECUTIVE_OBSERVATIONS} />
          </div>
        </div>
      )}

      <div className="border-t border-edge/70" />

      {/* Scroll cap lowered from `max-h-72` (288px) to `max-h-64` (256px) — a long run's tool
          log no longer grows the window down the screen any more than it already didn't; this
          just keeps the box itself shorter and lighter (agent-window-size round). Nothing here
          is removed, only bounded — every row is still reachable by scrolling. */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="relative flex max-h-64 flex-col gap-1 overflow-y-auto"
      >
        {toolLog.length === 0 && <p className="py-2 text-[13px] text-dim">waiting for the first tool call…</p>}
        {toolLog.map((entry, i) => {
          // Identity, not array index: see useAgentLog's entryIdentity/useNewArrivals. Reused
          // here as the React key too, so a live→replay handover (same content, new object
          // references) doesn't force a spurious remount of rows that were already on screen.
          const id = entryIdentity(entry, i)
          const isNew = revealed.has(id)
          return entry.tool === 'propose_resolution'
            ? <VerdictStrip key={id} entry={entry} isNew={isNew} />
            : <ToolRow key={id} entry={entry} isNew={isNew} />
        })}
      </div>

      {!atBottom && newSinceScroll > 0 && (
        <button
          onClick={jumpToBottom}
          className="w-fit self-center rounded-full border border-ice/40 bg-ice/10 px-2.5 py-0.5 text-[11px] text-ice"
        >
          ▼ {newSinceScroll} new
        </button>
      )}

      {guardrailBand && (
        <div className="rounded border border-violet/40 bg-violet/10 px-2 py-1.5 text-[13px] text-violet">
          {guardrailBand}
        </div>
      )}
    </div>
  )
}
