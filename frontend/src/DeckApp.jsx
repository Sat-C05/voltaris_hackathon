import { useEffect, useRef, useState } from 'react'
import { useSnapshot } from './useSnapshot'
import StatusBar from './components/StatusBar'
import LeftRail from './components/rails/LeftRail'
import RightRail from './components/rails/RightRail'
import Deck from './components/deck/Deck'
import { useTempHistory } from './components/deck/useTempHistory'
import { stationOfTarget } from './lib/target'

// The deck UI. `?classic=1` still renders the classic App untouched
// (see main.jsx). `selectedStationId` and `focusIncident` are owned here, one level above
// Deck and the right rail, because clicking an incident row in the right rail (a sibling of
// Deck) needs to both select a station on the deck and reopen/raise a window inside it —
// without this, closing a window left no way to open it again. `hoveredId` and
// `tempHistory` live up here too: the hover card renders inside
// `RightRail`, a sibling of `Deck`, not inside `Deck` itself, so both need to live above both.
// `selectedStationId` now ALSO feeds `RightRail` directly (hover/pin round): clicking a station
// already toggles this exact piece of state via `Deck`'s own `onClick` — that toggle IS the
// "pin" the vitals card uses, so RightRail falls back to it whenever nothing is being hovered,
// with no second, parallel "pinned" state introduced anywhere.
export default function DeckApp() {
  const { snapshot, error } = useSnapshot()
  const [selectedStationId, setSelectedStationId] = useState(null)
  const [focusIncident, setFocusIncident] = useState(null) // { incidentId, token }
  const [focusReplay, setFocusReplay] = useState(null) // { runId, token }
  const [hoveredId, setHoveredId] = useState(null)
  const tempHistory = useTempHistory()
  const focusTokenRef = useRef(0)
  const replayTokenRef = useRef(0)

  useEffect(() => {
    tempHistory.record(snapshot)
  }, [snapshot])

  function handleSelectIncident(incident) {
    setSelectedStationId(stationOfTarget(incident.target))
    focusTokenRef.current += 1
    setFocusIncident({ incidentId: incident.incident_id, token: focusTokenRef.current })
  }

  // Golden-run replay: the Scenarios rail's table lives in
  // LeftRail, a sibling of Deck, so opening a run's replay window has to bubble up here and
  // back down to Deck's WindowLayer — the exact same {id, token} nonce shape and one-level-up
  // ownership `handleSelectIncident`/`focusIncident` already use, not a new mechanism.
  function handleOpenReplay(runId) {
    replayTokenRef.current += 1
    setFocusReplay({ runId, token: replayTokenRef.current })
  }

  // Passed straight through to StationPillar via Deck exactly as it was called before this
  // rework — a plain setter for hover, and the "only clear if this station is still the one
  // that's hovered" guard for leave (unchanged logic, just relocated).
  function handleLeaveStation(id) {
    setHoveredId((cur) => (cur === id ? null : cur))
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-void font-mono text-ink">
      <StatusBar snapshot={snapshot} error={error} />
      {/* The deck fills the whole area and the rails float ON it. The pillars sit between
          30% and 70% of the viewBox width,
          so the rails never cover one. */}
      <div className="relative min-h-0 flex-1">
        <Deck
          snapshot={snapshot}
          selectedId={selectedStationId}
          onSelect={setSelectedStationId}
          focusIncident={focusIncident}
          focusReplay={focusReplay}
          hoveredId={hoveredId}
          onHover={setHoveredId}
          onLeave={handleLeaveStation}
        />
        <LeftRail snapshot={snapshot} onOpenReplay={handleOpenReplay} />
        <RightRail
          snapshot={snapshot}
          onSelectIncident={handleSelectIncident}
          hoveredId={hoveredId}
          selectedStationId={selectedStationId}
          tempHistory={tempHistory}
        />
      </div>
    </div>
  )
}
