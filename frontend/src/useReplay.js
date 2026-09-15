import { useEffect, useState } from 'react'

const MAX_ATTEMPTS = 6
const RETRY_MS = 500

/**
 * The golden-run replay player: the recording behind
 * one run id, from `POST /runs/{run_id}/replay`. Same bounded-retry, try/catch-keeps-last-good-
 * state discipline as `useEvaluation.js` — 6 attempts, 500ms apart, then an honest `error` flag
 * rather than a blank window. Unlike `useEvaluation`, there is no `enabled` gate: a Replay
 * window only ever mounts once the user has explicitly opened it (the clickable golden-run
 * row), so there is no "not yet" state to wait out — it fetches as soon as it has a `runId`.
 *
 * The recording is a frozen, already-recorded log (Contract-shaped, same as a live tool_log
 * entry per run — see ReplayWindow.jsx) — it never changes after being written, so this is a
 * one-shot fetch, never a poll (nothing polls this; a replay is explicitly not
 * one of the intervals listed there).
 */
export function useReplay(runId) {
  const [recording, setRecording] = useState(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!runId) { setRecording(null); setError(false) }
  }, [runId])

  useEffect(() => {
    if (!runId) return
    let cancelled = false
    let attempts = 0
    let timer = null

    const attempt = async () => {
      attempts += 1
      try {
        const res = await fetch(`/runs/${runId}/replay`, { method: 'POST' })
        if (res.ok) {
          const data = await res.json()
          if (!cancelled) { setRecording(data); setError(false) }
          return
        }
      } catch {
        // fall through to the retry/give-up path below.
      }
      if (cancelled) return
      if (attempts >= MAX_ATTEMPTS) { setError(true); return }
      timer = setTimeout(attempt, RETRY_MS)
    }
    attempt()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [runId])

  return { recording, error }
}
