import { useEffect, useRef, useState } from 'react'
import { useRunWithStatus } from '../../../useRun'

const STABLE_POLLS_BEFORE_STOP = 2

// --- Reveal-on-arrival identity -------------------------------------------------------------
//
// Stable identity for one tool_log entry. Used both as the React list key and to detect
// genuinely new arrivals across polls (see useNewArrivals below). tool_log is append-only and
// entries are never edited or reordered once appended (confirmed against
// backend/agent/harness.py: every entry is built as a complete dict and pushed with a single
// `.append` call, never mutated afterward) — but no entry carries its own id, and
// `useRunWithStatus` re-parses fresh JSON on every 500ms poll, so object identity is useless:
// a byte-for-byte-unchanged log still hands back brand-new array and object references every
// time. tool+sim_time is enough to identify a call in practice; the index is only a
// tie-breaker for two calls that land in the same tick (e.g. two get_telemetry reads before
// sim time advances), and is safe to use this way — never as the identity on its own — only
// because the log is append-only: a given logical entry keeps the same index for the rest of
// its life once written.
export function entryIdentity(entry, index) {
  return `${index}:${entry.tool}:${entry.sim_time}`
}

// Diffs the current log against a length watermark to find entries appended since the
// watermark was last advanced. Because tool_log only ever grows from the end, "new since the
// watermark" is exactly the tail slice past it — no per-entry reference comparison needed,
// which matters because references are never stable across polls (see entryIdentity above).
// An unchanged log (same length) always returns [].
export function computeNewIdentities(toolLog, knownLength) {
  if (toolLog.length <= knownLength) return []
  return toolLog.slice(knownLength).map((entry, i) => entryIdentity(entry, knownLength + i))
}

// Tracks which tool_log identities have arrived since this console started watching
// `resetKey` (the run id), so the caller can reveal exactly those rows once and never again —
// including across a poll that returns a completely unchanged log: the everyday case is
// computeNewIdentities returning [], which this hook short-circuits on without even calling
// setState, so no row's className ever regains `voltaris-reveal` and no re-render happens at
// all for a no-op poll.
//
// The watermark seeds to the log's length as of the first render for a given run, so a
// console opened mid-run does not burst-reveal history it never watched arrive — only entries
// appended after that point animate. Switching `resetKey` (a new run) re-seeds from scratch so
// a shorter new run's early entries are never mistaken for "already seen" against a longer
// previous run's watermark.
export function useNewArrivals(toolLog, resetKey) {
  const [revealed, setRevealed] = useState(() => new Set())
  const watermarkRef = useRef(null)
  const resetKeyRef = useRef(null)

  useEffect(() => {
    if (resetKeyRef.current !== resetKey) {
      resetKeyRef.current = resetKey
      watermarkRef.current = toolLog.length
      setRevealed(new Set())
      return
    }
    const freshIds = computeNewIdentities(toolLog, watermarkRef.current ?? 0)
    if (freshIds.length === 0) return
    watermarkRef.current = toolLog.length
    setRevealed((prev) => {
      const next = new Set(prev)
      freshIds.forEach((id) => next.add(id))
      return next
    })
  }, [toolLog, resetKey])

  return revealed
}
// -------------------------------------------------------------------------------------------

// Sources the Agent Console's tool log: `GET /runs/{id}` while live, falling back to
// `POST /runs/{id}/replay` once the id is confirmed 404 ("after a
// reset, GET /runs/{id} 404s but replay still works... on a 404 for a run that has a golden
// recording, fall back to the replay log (log[].kind === 'TOOL_CALL')"). Also implements the
// "stop polling /runs/{id} once the incident is terminal and the log stopped growing".
export function useAgentLog(runId, incidentTerminal) {
  const [stopped, setStopped] = useState(false)
  const stableRef = useRef(0)
  const prevLenRef = useRef(-1)
  const replayTriedRef = useRef(null)
  const [replay, setReplay] = useState(null)

  const { run, notFound } = useRunWithStatus(runId, 500, !stopped)

  useEffect(() => {
    setStopped(false)
    stableRef.current = 0
    prevLenRef.current = -1
    setReplay(null)
    replayTriedRef.current = null
  }, [runId])

  // A confirmed 404 means the run is gone from live memory for good (a `/world/reset`
  // happened) — no point continuing to poll it, and this is exactly the replay signal.
  useEffect(() => {
    if (notFound) setStopped(true)
  }, [notFound])

  useEffect(() => {
    if (!notFound || !runId || replayTriedRef.current === runId) return
    replayTriedRef.current = runId
    fetch(`/runs/${runId}/replay`, { method: 'POST' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (data) setReplay(data) })
      .catch(() => {})
  }, [notFound, runId])

  const liveLog = run?.tool_log ?? null
  const replayToolLog = replay
    ? replay.log.filter((e) => e.kind === 'TOOL_CALL').map((e) => e.payload)
    : null

  const toolLog = liveLog ?? replayToolLog ?? []
  const status = run?.status ?? replay?.outcome ?? null
  const isReplay = !liveLog && !!replayToolLog

  useEffect(() => {
    if (!incidentTerminal || isReplay) { stableRef.current = 0; prevLenRef.current = toolLog.length; return }
    if (toolLog.length === prevLenRef.current) {
      stableRef.current += 1
      if (stableRef.current >= STABLE_POLLS_BEFORE_STOP) setStopped(true)
    } else {
      stableRef.current = 0
      prevLenRef.current = toolLog.length
    }
  }, [toolLog.length, incidentTerminal, isReplay])

  return { toolLog, status, isReplay }
}
