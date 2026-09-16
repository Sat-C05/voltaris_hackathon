import { useEffect, useRef, useState } from 'react'
import { COMPONENTS } from './contracts'
import { PHASE } from './lib/phase'
import { stationOfTarget } from './lib/target'

/**
 * P8 + P6 — the two things on the deck that are driven by the DIFFERENCE between two snapshots
 * rather than by a snapshot on its own.
 *
 * **This reads `/world` and nothing else.** Invariant 1 names `/events` as display-only ticker
 * text that must never feed a component which also renders from `/world`, and a change ping is
 * exactly the shape of thing that tempts you to use it — `/events` literally emits
 * "STATION_FAULTED". Don't. The event stream and the snapshot can disagree about ordering (one
 * is a since-cursor log, the other is 500ms state-of-the-world), and a ping driven by the log
 * would fire at a pillar whose colour has not changed yet. Diffing successive snapshots means
 * the ping and the colour it is announcing are, by construction, the same fact.
 *
 * This is also the same technique `useTempHistory` already uses, and the one `CLAUDE.md §2`
 * points at before anyone considers a BACKEND ASK: history, rates and deltas are all derivable
 * from successive snapshots client-side.
 *
 * It decides nothing (Invariant 2). A ping means "these fields are not what they were"; a
 * verdict means "`incident.status` is now one of the backend's own terminal values". Neither
 * infers an outcome, and the tone of both is looked up from state that is already on screen.
 */

// A ping fires when a station's *tone-relevant* state changes — i.e. exactly the fields that can
// repaint the pillar. The plan named `status`, component `health` and `communication_state`;
// connector status is in here too because `StationPillar`'s own `classify()` reads it (a
// connector going FAULTED turns the pillar rose on its own), and a ping that did not fire for
// the most dramatic recolour on the deck would be the one people notice missing.
// `maintenance_hold` is in for the same reason: it is what makes a pillar read as isolated.
// Telemetry is deliberately NOT: temperature moves every single poll, and a ping per poll is
// not a ping, it is a strobe.
function stationSignature(station) {
  return [
    station.status,
    station.communication_state,
    station.maintenance_hold ? 'hold' : '-',
    Object.keys(station.connectors).sort().map((c) => station.connectors[c].status).join('/'),
    COMPONENTS.map((c) => station.components[c]?.health ?? '-').join('/'),
  ].join('|')
}

const TERMINAL_STATUSES = [PHASE.RESOLVED, PHASE.ESCALATED, PHASE.FAILED]

export const PING_MS = 700
export const VERDICT_MS = 900

export function useDeckTransitions(snapshot) {
  const [pings, setPings] = useState([])
  const [verdicts, setVerdicts] = useState([])

  // Previous state, kept in refs rather than state: these exist to be COMPARED against, never
  // rendered, and putting them in state would schedule a second render per poll for nothing.
  const prevStations = useRef(null)
  const prevIncidentStatus = useRef(new Map())
  const prevSimTime = useRef(null)
  const seq = useRef(0)

  useEffect(() => {
    if (!snapshot) return

    // Two cases that must SEED silently rather than emit, or the demo opens with a burst:
    //  1. The first snapshot. Every station and every pre-existing incident would otherwise
    //     read as "just changed" the moment the page loads.
    //  2. A world reset. `POST /world/reset` rebuilds the twin, so sim_time jumps BACKWARDS and
    //     every station flips back to AVAILABLE at once — four simultaneous pings announcing
    //     nothing that happened. Detecting it on the clock (rather than on, say, an empty
    //     incident list) is the one signal that cannot be confused with normal play, since
    //     `snapshot.sim_time` only ever advances within a world (Invariant 3 — it is also the
    //     only clock we are allowed to read).
    const reset = prevSimTime.current !== null && snapshot.sim_time < prevSimTime.current
    prevSimTime.current = snapshot.sim_time

    if (prevStations.current === null || reset) {
      prevStations.current = new Map(
        Object.entries(snapshot.stations).map(([id, s]) => [id, stationSignature(s)]),
      )
      prevIncidentStatus.current = new Map(
        (snapshot.incidents ?? []).map((i) => [i.incident_id, i.status]),
      )
      if (reset) { setPings([]); setVerdicts([]) }
      return
    }

    const nextPings = []
    const nextSignatures = new Map()
    for (const [id, station] of Object.entries(snapshot.stations)) {
      const sig = stationSignature(station)
      nextSignatures.set(id, sig)
      const before = prevStations.current.get(id)
      // `before === undefined` is a station that was not in the previous snapshot at all (the
      // station set changed). That is an arrival, not a change — no ping, just adopt it.
      if (before !== undefined && before !== sig) {
        nextPings.push({ key: `ping-${id}-${seq.current++}`, id })
      }
    }
    prevStations.current = nextSignatures

    const nextVerdicts = []
    const nextIncidentStatus = new Map()
    for (const incident of snapshot.incidents ?? []) {
      nextIncidentStatus.set(incident.incident_id, incident.status)
      const before = prevIncidentStatus.current.get(incident.incident_id)
      // Fires on the EDGE into terminal, once. `incident_store.all()` keeps terminal incidents
      // in the snapshot forever, so a "status is terminal" test would re-fire on every one of
      // the ~2 polls per second for the rest of the demo. It also cannot fire for an incident
      // that was already terminal when we first saw it (`before === undefined`), which is what
      // stops a page reload from replaying a verdict that landed minutes ago.
      if (before !== undefined && before !== incident.status && TERMINAL_STATUSES.includes(incident.status)) {
        nextVerdicts.push({
          key: `verdict-${incident.incident_id}-${incident.status}`,
          id: stationOfTarget(incident.target),
          status: incident.status,
        })
      }
    }
    prevIncidentStatus.current = nextIncidentStatus

    if (nextPings.length) setPings((p) => [...p, ...nextPings])
    if (nextVerdicts.length) setVerdicts((v) => [...v, ...nextVerdicts])
  }, [snapshot])

  // Expiry. Each effect below owns exactly the entries present when it ran, and clears them by
  // key — never `setPings([])`, which would cut short a ping that arrived in a later poll while
  // this timer was still running.
  useEffect(() => {
    if (!pings.length) return
    const keys = new Set(pings.map((p) => p.key))
    const t = setTimeout(() => setPings((cur) => cur.filter((p) => !keys.has(p.key))), PING_MS + 80)
    return () => clearTimeout(t)
  }, [pings])

  useEffect(() => {
    if (!verdicts.length) return
    const keys = new Set(verdicts.map((v) => v.key))
    const t = setTimeout(() => setVerdicts((cur) => cur.filter((v) => !keys.has(v.key))), VERDICT_MS + 120)
    return () => clearTimeout(t)
  }, [verdicts])

  return { pings, verdicts }
}
