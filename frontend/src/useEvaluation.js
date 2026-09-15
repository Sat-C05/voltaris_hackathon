import { useEffect, useState } from 'react'

const MAX_ATTEMPTS = 6
const RETRY_MS = 500

/**
 * The Scorecard's source: `GET /evaluation/{run_id}`, fetched **once** when `enabled` flips
 * true (the incident has reached a terminal status) — not on an interval like `useRun`/
 * `useSnapshot`. The evaluation is a one-shot summary of a finished run, not live state, so
 * there is nothing to poll for.
 *
 * Same try/catch-keeps-last-good-state rule as every other hook here: a failed fetch leaves
 * `evaluation` at whatever it last was (null, if this is the first attempt) rather than
 * blanking the window, and simply flags `error` so the caller can render its own quiet
 * placeholder instead of pretending nothing is wrong.
 */
export function useEvaluation(runId, enabled) {
  const [evaluation, setEvaluation] = useState(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!runId) { setEvaluation(null); setError(false) }
  }, [runId])

  useEffect(() => {
    if (!runId || !enabled) return
    let cancelled = false
    let attempts = 0
    let timer = null

    // Bounded retry, not a poll. One SUCCESSFUL fetch is all this hook ever wants ("once,
    // on terminal") — but a single attempt that fails leaves the Scorecard permanently empty
    // with nothing to re-trigger it, which is precisely the blank-screen-in-front-of-judges
    // case the once-only rule exists to prevent. So a failure (transient fetch error, or a 404 from an
    // evaluation the backend has not finished writing) is retried a few times and then given
    // up on; a success stops immediately and nothing further is requested.
    const attempt = async () => {
      attempts += 1
      try {
        const res = await fetch(`/evaluation/${runId}`)
        if (res.ok) {
          const data = await res.json()
          if (!cancelled) { setEvaluation(data); setError(false) }
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
  }, [runId, enabled])

  return { evaluation, error }
}
