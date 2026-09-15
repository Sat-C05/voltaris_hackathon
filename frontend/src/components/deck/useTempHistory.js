import { useRef } from 'react'

const RING_SIZE = 60

// Client-side ring buffer of the last 60 polled temperature_c values per station, for the
// hover card's sparkline only. The snapshot has no
// history — this is derived display state, never a rendering input for anything but the
// sparkline itself, so Invariant 9 ("render only from /world") still holds: every value in the
// buffer came from a real /world poll.
//
// Cleared on a world reset. A reset shows up as sim_time going backwards (a fresh world starts
// its clock at 0 again), which is the only signal available without touching the backend.
export function useTempHistory() {
  const buffers = useRef({}) // stationId -> number[]
  const lastSimTime = useRef(0)

  // Call from an effect keyed on the snapshot — this mutates a ref, not React state, on
  // purpose: a sparkline redraw does not need to fight the 500ms poll with its own re-render.
  function record(snapshot) {
    if (!snapshot) return
    if (snapshot.sim_time < lastSimTime.current - 1) {
      buffers.current = {}
    }
    lastSimTime.current = snapshot.sim_time

    for (const [id, station] of Object.entries(snapshot.stations)) {
      const arr = buffers.current[id] ?? []
      const temp = station.telemetry.temperature_c
      if (arr[arr.length - 1] !== temp) {
        const next = [...arr, temp]
        if (next.length > RING_SIZE) next.shift()
        buffers.current[id] = next
      } else if (arr.length === 0) {
        buffers.current[id] = [temp]
      }
    }
  }

  function get(id) {
    return buffers.current[id] ?? []
  }

  return { record, get }
}
