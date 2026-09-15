import { useEffect, useState } from 'react'

/**
 * The agent timeline for one run (`GET /runs/{id}`) — sim_time, tool call,
 * result, policy verdict. Never raw model reasoning; the backend's tool_log already
 * omits that, so this hook is a plain, dumb poller.
 *
 * Kept byte-for-byte compatible with its original return shape (a bare `run` object, not
 * `{run, ...}`) — the classic `AgentTimeline.jsx` calls `const run = useRun(runId)` and
 * must not be touched. The Agent Console's extra needs (stop-polling, 404 tracking) are added below as a
 * second hook that reuses this one, rather than changing this one's signature.
 */
export function useRun(runId, intervalMs = 500) {
  const [run, setRun] = useState(null)

  useEffect(() => {
    if (!runId) { setRun(null); return }
    let cancelled = false
    const poll = async () => {
      try {
        const res = await fetch(`/runs/${runId}`)
        if (!res.ok) return
        const data = await res.json()
        if (!cancelled) setRun(data)
      } catch {
        // transient fetch failure — next poll retries.
      }
    }
    poll()
    const id = setInterval(poll, intervalMs)
    return () => { cancelled = true; clearInterval(id) }
  }, [runId, intervalMs])

  return run
}

/**
 * The Agent Console needs two things `useRun` deliberately doesn't do, since doing them would
 * change what the classic view relies on:
 *  - stop polling once the caller says so (the incident is terminal and the log has stopped
 *    growing — a long demo otherwise accumulates dead timers), and
 *  - know for certain that `/runs/{id}` 404d (as opposed to "hasn't answered yet"), which is
 *    the Agent Console's signal to fall back to `POST /runs/{id}/replay` ("after a reset,
 *    GET /runs/{id} 404s but replay still works").
 *
 * This is `useRun` extended, not a third independent poller: same endpoint, same shape, same
 * try/catch-keeps-last-good-state rule — it only adds an `enabled` gate and a `notFound`
 * flag on top.
 */
export function useRunWithStatus(runId, intervalMs = 500, enabled = true) {
  const [run, setRun] = useState(null)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    if (!runId) { setRun(null); setNotFound(false) }
  }, [runId])

  useEffect(() => {
    if (!runId || !enabled) return
    let cancelled = false
    const poll = async () => {
      try {
        const res = await fetch(`/runs/${runId}`)
        if (res.status === 404) {
          if (!cancelled) setNotFound(true)
          return
        }
        if (!res.ok) return
        const data = await res.json()
        if (!cancelled) { setRun(data); setNotFound(false) }
      } catch {
        // transient fetch failure — next poll retries.
      }
    }
    poll()
    const id = setInterval(poll, intervalMs)
    return () => { cancelled = true; clearInterval(id) }
  }, [runId, intervalMs, enabled])

  return { run, notFound }
}
