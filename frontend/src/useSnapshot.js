import { useEffect, useState } from 'react'

/**
 * The ONLY rendering input.
 *
 * The snapshot is complete on every poll, never a delta — replace state wholesale and let
 * React diff it. Never merge, never patch from /events: two rendering sources means two
 * views that can disagree.
 */
export function useSnapshot(intervalMs = 500) {
  const [snapshot, setSnapshot] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      try {
        const res = await fetch('/world')
        if (!res.ok) throw new Error(`/world returned ${res.status}`)
        const data = await res.json()
        if (!cancelled) { setSnapshot(data); setError(null) }
      } catch (e) {
        if (!cancelled) setError(e.message)
      }
    }
    poll()
    const id = setInterval(poll, intervalMs)
    return () => { cancelled = true; clearInterval(id) }
  }, [intervalMs])

  return { snapshot, error }
}
