import { useCallback, useEffect, useRef, useState } from 'react'
import Window from './Window'
import IncidentWindow from './IncidentWindow'
import AgentConsoleWindow from './AgentConsoleWindow'
import ScorecardWindow from './ScorecardWindow'
import ReplayWindow from './ReplayWindow'
import { ANCHORS, AGENT_WINDOW_WIDTH, widthFor, WINDOW_HEIGHT_ESTIMATE, candidateSlots } from './layout'
import { stationOfTarget } from '../../../lib/target'
import { PALETTE } from '../../../palette'

const GLYPH = { incident: '⚠', agent: '◆', scorecard: '▣', replay: '▶' }

// Rectangle-collision placement, lifted out of the spawn effect below so the
// focusReplay effect can use the identical logic to place a *first* open of a replay window —
// unlike Incident/Agent/Scorecard, a replay window has no snapshot-driven spawn trigger of its
// own, so its own effect has to do both "place it" and "raise it", and duplicating
// this search a second time would be the actual risk, not extracting it. Behaviour is
// unchanged: scripted anchor first (ring 0), then `candidateSlots`' nearby offsets, then the
// old +24/+24 cascade if every candidate collides.
function computeAnchor(kind, existingWindows, boxW, boxH) {
  const width = widthFor(kind)
  const height = WINDOW_HEIGHT_ESTIMATE[kind] ?? 240
  const rectsIntersect = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  const existing = Object.values(existingWindows)
    .filter((w) => !w.hidden)
    .map((w) => ({ x: w.x, y: w.y, w: widthFor(w.type), h: WINDOW_HEIGHT_ESTIMATE[w.type] ?? 240 }))

  for (const c of candidateSlots(kind, boxW, boxH)) {
    const rect = { x: c.x, y: c.y, w: width, h: height }
    if (!existing.some((r) => rectsIntersect(rect, r))) return c
  }

  // Fallback: every generated candidate collided — cascade off the scripted anchor.
  let { x, y } = ANCHORS[kind](boxW, boxH)
  const taken = new Set(existing.map((r) => `${r.x},${r.y}`))
  while (taken.has(`${x},${y}`)) { x += 24; y += 24 }
  return { x, y }
}
// A Scorecard spawns once its run's incident reaches a terminal status *and*
// it had a scenario — but the incident's own `scenario_id` isn't in the snapshot, only the
// evaluation response has it, and fetching that just to decide whether to spawn would mean a
// second unconditional fetch per incident. Spawning on terminal status alone (dropping the "and
// it had a scenario" gate) is the cheaper, harmless choice: ScorecardWindow already renders the
// designed "— no scenario · counts only" fallback for a manual fault's evaluation, so a
// manual-fault Scorecard is still correct content, just for a run nobody expected a scorecard on.
const TERMINAL_STATUSES = new Set(['RESOLVED', 'ESCALATED', 'FAILED'])
const PILLAR_H = 160 // matches StationPillar.jsx's own `h` — the pillar's local coordinate height

// The window layer: spawn-on-incident / spawn-on-run, drag/raise/close,
// and the leader line tethering each window to its station. Lives inside Deck.jsx because it
// needs both the computed station layout and the deck's own <svg> (for `getScreenCTM()`, which
// maps a station's viewBox position to real container pixels regardless of how the viewBox is
// scaled/cropped — see Deck.jsx's `preserveAspectRatio="xMidYMid slice"`).
//
// `layout` is the map from `computeStationLayout` — station positions are
// no longer a hardcoded four-entry map. `focusIncident` is how the right rail
// review) reopens/raises a closed Incident window — `{incidentId, token}`, token just a nonce
// so clicking the same row twice still re-triggers the effect.
export default function WindowLayer({ snapshot, svgRef, containerRef, layout, focusIncident, focusReplay }) {
  const [windows, setWindows] = useState({}) // id -> {type, ..., x, y, hidden}
  const [zOrder, setZOrder] = useState([]) // ids, most-recent last
  const [leaderPaths, setLeaderPaths] = useState({})
  const seenIncidentIds = useRef(new Set())
  const seenRunIds = useRef(new Set())
  const seenScorecardRunIds = useRef(new Set())
  const lastSimTime = useRef(0)
  const nodeRefs = useRef({}) // id -> {current: HTMLElement|null}
  const rafRef = useRef(null)

  function refFor(id) {
    if (!nodeRefs.current[id]) nodeRefs.current[id] = { current: null }
    return nodeRefs.current[id]
  }

  // Spawn: one Incident window per incident id, one Agent Console per run id, neither seen
  // before. Anchored from the layout map, never a random point; +24/+24 if
  // that anchor is already taken by a visible window.
  useEffect(() => {
    if (!snapshot) return

    // A world reset restarts incident/run ids at *-001, which this layer has already "seen" —
    // without this, nothing would ever spawn again after a reset (found in review).
    if (snapshot.sim_time < lastSimTime.current - 1) {
      seenIncidentIds.current = new Set()
      seenRunIds.current = new Set()
      seenScorecardRunIds.current = new Set()
      nodeRefs.current = {}
      // A replay window SURVIVES a world reset, unlike every other kind. Golden recordings are
      // deliberately kept in their own store precisely so they outlive `POST /world/reset`, and
      // a replay renders from its frozen recording rather than from `snapshot` — it has no
      // live incident, run or station to go stale. It is also the one window most likely to be
      // open *because* the live demo went wrong and someone is about to reset the world to
      // recover it; wiping the fallback at that exact moment is the worst possible time to
      // lose it. Everything snapshot-derived is still cleared.
      setWindows((prev) => Object.fromEntries(Object.entries(prev).filter(([, w]) => w.type === 'replay')))
      setZOrder((prev) => prev.filter((wid) => wid.startsWith('replay:')))
      setLeaderPaths({})
    }
    lastSimTime.current = snapshot.sim_time

    const freshIncidents = (snapshot.incidents ?? []).filter((inc) => !seenIncidentIds.current.has(inc.incident_id))
    const activeRun = snapshot.active_run
    const freshRun = activeRun && !seenRunIds.current.has(activeRun.run_id) ? activeRun : null
    // Scorecard spawn rule: one per run id, the moment an
    // incident carries an `agent_run_id` and has reached a terminal status. Read off the live
    // incident list rather than `active_run` — the run is no longer active by the time it's
    // terminal, so `active_run`-based `freshRun` above can never see it.
    const freshScorecardIncidents = (snapshot.incidents ?? []).filter((inc) =>
      inc.agent_run_id && TERMINAL_STATUSES.has(inc.status) && !seenScorecardRunIds.current.has(inc.agent_run_id))
    if (freshIncidents.length === 0 && !freshRun && freshScorecardIncidents.length === 0) return

    const rect = containerRef.current?.getBoundingClientRect()
    const boxW = rect?.width ?? 1200
    const boxH = rect?.height ?? 700
    const newIds = []

    setWindows((prev) => {
      const next = { ...prev }
      // Real non-overlapping placement — the old logic only cascaded when a new anchor was byte-identical
      // to an existing one, so two different-kind windows, or one the user had dragged, would
      // happily overlap). Each open, non-hidden window becomes a rectangle from its committed
      // x/y plus its known width and a per-kind estimated height (the real height isn't known
      // at spawn time); `candidateSlots` yields that kind's scripted anchor first, then nearby
      // offsets, all pre-filtered clear of both rails, and this picks the first one whose
      // rectangle doesn't intersect any existing window. Only if every candidate collides does
      // it fall back to the old +24/+24 cascade off the scripted anchor.
      const anchorFor = (kind) => computeAnchor(kind, next, boxW, boxH)

      for (const inc of freshIncidents) {
        seenIncidentIds.current.add(inc.incident_id)
        const wid = `incident:${inc.incident_id}`
        if (next[wid]) continue
        const { x, y } = anchorFor('incident')
        next[wid] = { type: 'incident', incidentId: inc.incident_id, stationId: stationOfTarget(inc.target), x, y, hidden: false }
        newIds.push(wid)
      }

      if (freshRun) {
        seenRunIds.current.add(freshRun.run_id)
        const wid = `agent:${freshRun.run_id}`
        if (!next[wid]) {
          const incident = (snapshot.incidents ?? []).find((inc) => inc.incident_id === freshRun.incident_id)
          const { x, y } = anchorFor('agent')
          next[wid] = {
            type: 'agent',
            runId: freshRun.run_id,
            incidentId: freshRun.incident_id,
            stationId: incident ? stationOfTarget(incident.target) : null,
            x, y, hidden: false,
            // Budgets live here, refreshed every poll while this run is `snapshot.active_run`
            // (below) and simply left at their last value once the run ends and active_run
            // goes null again — the Agent Console "stays open after the run ends" but the
            // live budget source disappears with it, so freezing is the only honest option.
            budgets: { steps_used: freshRun.steps_used, max_steps: freshRun.max_steps, actions_used: freshRun.actions_used, max_actions: freshRun.max_actions },
          }
          newIds.push(wid)
        }
      }

      for (const inc of freshScorecardIncidents) {
        seenScorecardRunIds.current.add(inc.agent_run_id)
        const wid = `scorecard:${inc.agent_run_id}`
        if (next[wid]) continue
        const { x, y } = anchorFor('scorecard')
        next[wid] = { type: 'scorecard', runId: inc.agent_run_id, incidentId: inc.incident_id, stationId: stationOfTarget(inc.target), x, y, hidden: false }
        newIds.push(wid)
      }

      return next
    })
    if (newIds.length > 0) setZOrder((prev) => [...prev, ...newIds])
  }, [snapshot, containerRef])

  // Keep a live agent window's budgets in sync with `snapshot.active_run` every poll, while it
  // is still the active run. This is a plain field update, not a spawn, so it's a separate,
  // smaller effect.
  useEffect(() => {
    const activeRun = snapshot?.active_run
    if (!activeRun) return
    const wid = `agent:${activeRun.run_id}`
    setWindows((prev) => {
      if (!prev[wid]) return prev
      const b = prev[wid].budgets
      if (b && b.steps_used === activeRun.steps_used && b.actions_used === activeRun.actions_used) return prev
      return { ...prev, [wid]: { ...prev[wid], budgets: { steps_used: activeRun.steps_used, max_steps: activeRun.max_steps, actions_used: activeRun.actions_used, max_actions: activeRun.max_actions } } }
    })
  }, [snapshot])

  // Reopen/raise from the right rail.
  useEffect(() => {
    if (!focusIncident) return
    const wid = `incident:${focusIncident.incidentId}`
    setWindows((prev) => (prev[wid] ? { ...prev, [wid]: { ...prev[wid], hidden: false } } : prev))
    setZOrder((prev) => (prev.includes(wid) ? [...prev.filter((w) => w !== wid), wid] : [...prev, wid]))
  }, [focusIncident])

  // Open/reopen/raise a golden-run replay from the Scenarios rail's clickable table.
  // Same `{runId, token}` nonce pattern `focusIncident` uses (a fresh object on every
  // click, even for the same run, so the effect re-fires and re-raises it) — but unlike
  // focusIncident, which only ever raises a window some other effect already spawned from the
  // snapshot, a replay window has no snapshot-driven spawn of its own, so this effect also has
  // to place it on a run's *first* open (`computeAnchor`, shared with the spawn effect above).
  // The deterministic `replay:${runId}` id is what keeps a second click from spawning a
  // duplicate — it always resolves to the one existing entry for that run.
  useEffect(() => {
    if (!focusReplay) return
    const wid = `replay:${focusReplay.runId}`
    const rect = containerRef.current?.getBoundingClientRect()
    const boxW = rect?.width ?? 1200
    const boxH = rect?.height ?? 700
    setWindows((prev) => {
      if (prev[wid]) return { ...prev, [wid]: { ...prev[wid], hidden: false } }
      const { x, y } = computeAnchor('replay', prev, boxW, boxH)
      // stationId: null — a replay is not tethered to any station (a window with no station
      // subject has no leader line), and it renders from its own frozen recording, not from
      // `snapshot`, so there is nothing live to tether it to anyway.
      return { ...prev, [wid]: { type: 'replay', runId: focusReplay.runId, stationId: null, x, y, hidden: false } }
    })
    setZOrder((prev) => (prev.includes(wid) ? [...prev.filter((w) => w !== wid), wid] : [...prev, wid]))
  }, [focusReplay, containerRef])

  // Leader line: from the window's bottom-centre to the station's top, in container-pixel
  // space. `getScreenCTM()` maps a point in the deck SVG's viewBox to real screen pixels
  // exactly as the browser is currently rendering it — correct under any preserveAspectRatio,
  // any crop, any window resize, with no geometry duplicated here.
  const recomputeLeaders = useCallback(() => {
    const svg = svgRef.current
    const container = containerRef.current
    if (!svg || !container || typeof svg.getScreenCTM !== 'function') return
    const ctm = svg.getScreenCTM()
    if (!ctm) return
    const containerRect = container.getBoundingClientRect()
    setLeaderPaths(() => {
      const next = {}
      for (const [wid, win] of Object.entries(windows)) {
        if (win.hidden || !win.stationId) continue
        const stationLayout = layout[win.stationId]
        const node = nodeRefs.current[wid]?.current
        if (!stationLayout || !node) continue
        const pt = svg.createSVGPoint()
        pt.x = stationLayout.x
        pt.y = stationLayout.y - PILLAR_H * stationLayout.scale
        const screenPt = pt.matrixTransform(ctm)
        const stationX = screenPt.x - containerRect.left
        const stationY = screenPt.y - containerRect.top
        const wRect = node.getBoundingClientRect()
        const winX = wRect.left + wRect.width / 2 - containerRect.left
        const winY = wRect.bottom - containerRect.top
        next[wid] = `M ${winX.toFixed(1)} ${winY.toFixed(1)} L ${stationX.toFixed(1)} ${stationY.toFixed(1)}`
      }
      return next
    })
  }, [windows, svgRef, containerRef, layout])

  // Recomputed on every poll (cheap — the station never moves, so in practice this only ever
  // changes anything right after a spawn/close/drag-commit) and, during an active drag, once
  // per animation frame instead of once per pointermove.
  useEffect(() => { recomputeLeaders() }, [snapshot, windows, recomputeLeaders])

  function handleDragFrame() {
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      recomputeLeaders()
    })
  }

  function handleRaise(id) {
    setZOrder((prev) => (prev[prev.length - 1] === id ? prev : [...prev.filter((w) => w !== id), id]))
  }

  // Close hides; it does not delete the window's state — so reopening it (from
  // the right rail) restores it with the same position and content.
  function handleClose(id) {
    setWindows((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], hidden: true } } : prev))
  }

  // The one and only place `x`/`y` change after spawn — the pointerup commit. Nothing here
  // ever repositions a window the user has already placed.
  function handleDragEnd(id, pos) {
    setWindows((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], x: pos.x, y: pos.y } } : prev))
  }

  const visible = Object.entries(windows).filter(([, w]) => !w.hidden)

  return (
    <>
      {/* Leader lines: an SVG layer behind the windows, in front of the deck grid. */}
      <svg className="pointer-events-none absolute inset-0 z-30 h-full w-full" aria-hidden="true">
        {visible.map(([wid]) => leaderPaths[wid] && (
          <path
            key={wid}
            d={leaderPaths[wid]}
            className="voltaris-leader-line"
            fill="none"
            stroke={PALETTE.ice}
            strokeWidth="1"
            strokeOpacity="0.55"
          />
        ))}
      </svg>

      {visible.map(([wid, win]) => {
        if (win.type === 'incident') {
          const incident = (snapshot?.incidents ?? []).find((inc) => inc.incident_id === win.incidentId)
          if (!incident) return null // e.g. right after /world/reset, before the window is closed too
          const headerTone = incident.status === 'RESOLVED' ? 'mint'
            : incident.status === 'ESCALATED' ? 'amber'
            : incident.status === 'FAILED' ? 'rose'
            : 'default'
          return (
            <Window
              key={wid}
              id={wid}
              title={`INCIDENT · ${incident.incident_id}`}
              glyph={GLYPH.incident}
              x={win.x}
              y={win.y}
              z={40 + zOrder.indexOf(wid)}
              headerTone={headerTone}
              onRaise={handleRaise}
              onClose={handleClose}
              onDragEnd={handleDragEnd}
              onDragFrame={handleDragFrame}
              containerRef={containerRef}
              nodeRef={refFor(wid)}
            >
              <IncidentWindow incident={incident} />
            </Window>
          )
        }

        if (win.type === 'agent') {
          // The incident may have gone terminal, or even be gone from the live list's
          // `agent_run_id` linkage after a reset — but this window stays open regardless
          // (it stays open after the run ends), it just loses its incident-derived context.
          const incident = (snapshot?.incidents ?? []).find((inc) => inc.agent_run_id === win.runId)
          const headerTone = incident?.status === 'RESOLVED' ? 'mint'
            : incident?.status === 'ESCALATED' ? 'amber'
            : incident?.status === 'FAILED' ? 'rose'
            : 'default'
          return (
            <Window
              key={wid}
              id={wid}
              title={`AGENT · ${win.runId}${win.stationId ? ' · ' + win.stationId : ''}`}
              glyph={GLYPH.agent}
              x={win.x}
              y={win.y}
              z={40 + zOrder.indexOf(wid)}
              headerTone={headerTone}
              onRaise={handleRaise}
              onClose={handleClose}
              onDragEnd={handleDragEnd}
              onDragFrame={handleDragFrame}
              containerRef={containerRef}
              nodeRef={refFor(wid)}
              width={AGENT_WINDOW_WIDTH}
            >
              <AgentConsoleWindow
                runId={win.runId}
                stationId={win.stationId}
                budgets={win.budgets}
                incidentStatus={incident?.status ?? null}
                incidentEscalationReason={incident?.escalation_reason ?? null}
              />
            </Window>
          )
        }

        if (win.type === 'scorecard') {
          // Same header-tone mapping the incident/agent branches use — read straight off the
          // live incident, falling back to 'default' once the incident is gone from the
          // snapshot (e.g. after a reset, same as the agent branch above).
          const incident = (snapshot?.incidents ?? []).find((inc) => inc.incident_id === win.incidentId)
          const headerTone = incident?.status === 'RESOLVED' ? 'mint'
            : incident?.status === 'ESCALATED' ? 'amber'
            : incident?.status === 'FAILED' ? 'rose'
            : 'default'
          return (
            <Window
              key={wid}
              id={wid}
              title={`EVALUATION · ${win.runId}`}
              glyph={GLYPH.scorecard}
              x={win.x}
              y={win.y}
              z={40 + zOrder.indexOf(wid)}
              headerTone={headerTone}
              onRaise={handleRaise}
              onClose={handleClose}
              onDragEnd={handleDragEnd}
              onDragFrame={handleDragFrame}
              containerRef={containerRef}
              nodeRef={refFor(wid)}
            >
              <ScorecardWindow runId={win.runId} />
            </Window>
          )
        }

        if (win.type === 'replay') {
          // No headerTone lookup here (unlike incident/agent/scorecard above): the recording's
          // outcome lives inside the fetched replay payload, not the live snapshot, and
          // WindowLayer never fetches it itself — duplicating that POST just to tint a
          // titlebar would be a second fetch for a cosmetic. ReplayWindow's own content (the
          // REPLAY badge plus the toned outcome row) already carries that colour.
          return (
            <Window
              key={wid}
              id={wid}
              title={`REPLAY · ${win.runId}`}
              glyph={GLYPH.replay}
              x={win.x}
              y={win.y}
              z={40 + zOrder.indexOf(wid)}
              onRaise={handleRaise}
              onClose={handleClose}
              onDragEnd={handleDragEnd}
              onDragFrame={handleDragFrame}
              containerRef={containerRef}
              nodeRef={refFor(wid)}
              width={AGENT_WINDOW_WIDTH}
            >
              <ReplayWindow runId={win.runId} />
            </Window>
          )
        }

        return null
      })}
    </>
  )
}
