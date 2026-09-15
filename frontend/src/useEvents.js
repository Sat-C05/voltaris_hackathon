import { useCallback, useEffect, useRef, useState } from 'react'
import { TICK_SIM_SECONDS } from './contracts'

/**
 * The event log — append-only, display only, no bearing on rendering.
 * Kept entirely separate from `useSnapshot`: this hook only ever appends, `useSnapshot` only
 * ever replaces wholesale. Mixing them is exactly the "two rendering sources" mistake this
 * warns about, so this hook's output must never feed a component that also reads `/world`.
 *
 * Two defects were fixed here, both reported as "the event ticker is not updating
 * live", both real:
 *
 * 1. THE TICKER DIED AFTER EVERY RESET. The `since` cursor is a sim_time, and a reset restarts
 *    the world's clock at 0 — so a cursor left at t=70000 asks for events past a time the new
 *    world will never reach, and the ticker goes silent forever. The old hook expected its
 *    caller to call `reset()`; the classic page did, the deck never did, and `POST /scenarios/run`
 *    resets the world too, so even wiring the reset button would not have covered it. The hook
 *    now detects a reset itself, from `simTime` going backwards — the same signal the rest of
 *    the deck already uses, and the only one that catches every path.
 *
 * 2. IT SILENTLY DROPPED EVENTS. `EventStore.since()` is `sim_time > ?`, strictly greater, and
 *    the cursor was set to the last event's sim_time — so every *other* event sharing that tick
 *    was skipped and never displayed. Events routinely share a tick (one fault firing emits
 *    several). The cursor now rewinds one tick on every poll and the overlap is de-duplicated by
 *    `event_id`, which is exact rather than approximate.
 */
export function useEvents(simTime, intervalMs = 500, limit = 200) {
  const [events, setEvents] = useState([])
  const sinceRef = useRef(0)
  const seenIds = useRef(new Set())
  const lastSimTime = useRef(0)

  const reset = useCallback(() => {
    sinceRef.current = 0
    seenIds.current = new Set()
    setEvents([])
  }, [])

  // Reset detection. `simTime` comes from the snapshot the caller is already polling — this
  // hook deliberately does not fetch `/world` itself — one rendering source.
  useEffect(() => {
    if (typeof simTime !== 'number') return
    if (simTime < lastSimTime.current - 1) reset()
    lastSimTime.current = simTime
  }, [simTime, reset])

  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      try {
        const res = await fetch(`/events?since=${sinceRef.current}`)
        if (!res.ok) return
        const batch = await res.json()
        if (cancelled || batch.length === 0) return
        // Rewind one tick so the next poll re-reads the tick we just consumed; `event_id`
        // de-duplication is what makes the overlap free.
        sinceRef.current = Math.max(0, batch[batch.length - 1].sim_time - TICK_SIM_SECONDS)
        const fresh = batch.filter((e) => !seenIds.current.has(e.event_id))
        if (fresh.length === 0) return
        for (const e of fresh) seenIds.current.add(e.event_id)
        setEvents((prev) => [...prev, ...fresh].slice(-limit))
      } catch {
        // transient fetch failure — next poll retries; the event log is display-only.
      }
    }
    poll()
    const id = setInterval(poll, intervalMs)
    return () => { cancelled = true; clearInterval(id) }
  }, [intervalMs, limit])

  return { events, reset }
}
