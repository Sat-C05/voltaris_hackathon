import { useEffect, useRef, useState } from 'react'
import { useRunWithStatus } from '../../../useRun'

const STABLE_POLLS_BEFORE_STOP = 2

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
