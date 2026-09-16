import { createContext, createElement, useCallback, useContext, useEffect, useReducer, useRef } from 'react'
import { PHASE } from './lib/phase'
import { stationOfTarget } from './lib/target'

// ------------------------------------------------------------------------------------------
// P4 — One-Click Demo Director.
//
// Drives: POST /world/reset -> POST /scenarios/run -> select the incident's target station on
// the deck -> raise its incident window -> follow the agent -> land on a terminal status.
// The scorecard needs no separate step: `WindowLayer` already spawns one the instant a
// terminal incident carries an `agent_run_id` (see its own `freshScorecardIncidents`), so once
// this director reaches a terminal status the scorecard is already on screen — adding a second
// mechanism to "open" it would be exactly the parallel-focus-mechanism trap the brief warns
// against.
//
// SEQUENCING (Invariant 1): every transition below is driven by the `snapshot` prop this hook
// is handed — the same object `useSnapshot()` produces in `DeckApp` and passes to `Deck`/
// `WindowLayer` — never a second poller, never `/events`. "Waiting" means "re-examine the next
// snapshot that arrives", not counting down a clock.
//
// TERMINAL VOCABULARY (Invariant 2): `RESOLVED` / `ESCALATED` / `FAILED`, taken from
// `PHASE.RESOLVED`/`PHASE.ESCALATED`/`PHASE.FAILED` in `lib/phase.js` (itself copied verbatim
// from `backend/pipeline/incident.py`'s `TERMINAL_STATUSES`, and the same three strings
// `StatusBar.jsx`'s `TERMINAL_INCIDENT_STATUSES` and `WindowLayer.jsx`'s `TERMINAL_STATUSES`
// already use) — imported, not re-typed a fourth time.
//
// FOCUS MECHANISM (the brief's central trap): step 3+4 ("select the station, raise the
// incident window") is done by calling `onFocusIncident`, which `DeckApp` wires straight to its
// existing `handleSelectIncident` — the exact function the right rail's incident list already
// uses. That function already does `setSelectedStationId` + bumps `focusTokenRef` +
// `setFocusIncident({incidentId, token})`. This hook never touches window state, never invents
// its own `{id, token}` pair, and never imports `WindowLayer` — it only ever calls the one
// function DeckApp already had.
//
// BOUNDED WAITS, NOT GUESSED DURATIONS: every `setTimeout` below is armed the moment a phase is
// entered and cleared the moment that phase's expected snapshot condition is observed. None of
// them ever *advance* the state machine — only a real snapshot match does that. A timeout firing
// only ever means "give up and fail soft", never "assume enough time has passed". They exist
// solely because the world clock is scaled and the local model's pace is unknown, so an
// unbounded wait could hang forever in front of judges (Invariant 10). None of these values are
// ever rendered — `snapshot.sim_time` stays the only clock on screen (Invariant 3).
// ------------------------------------------------------------------------------------------

const RESET_CONFIRM_TIMEOUT_MS = 5_000 // world/reset ack -> a snapshot that actually reflects it
const FAULT_TIMEOUT_MS = 60_000 // scenario scheduled -> its incident opens
const AGENT_TIMEOUT_MS = 240_000 // incident opens -> a terminal status

// Copied, not re-derived: the same three values `PHASE` names for a terminal incident.
const TERMINAL_STATUSES = new Set([PHASE.RESOLVED, PHASE.ESCALATED, PHASE.FAILED])

export const DIRECTOR_PHASE = Object.freeze({
  IDLE: 'IDLE',
  RESETTING: 'RESETTING',
  CONFIRMING_RESET: 'CONFIRMING_RESET',
  LAUNCHING: 'LAUNCHING',
  AWAITING_INCIDENT: 'AWAITING_INCIDENT',
  FOLLOWING: 'FOLLOWING',
  DONE: 'DONE',
  FAILED: 'FAILED',
})

// Phases `start()` may be called from — i.e. "nothing is running right now". Guards against a
// second run stacking on top of one already in flight.
const IDLE_LIKE = new Set([DIRECTOR_PHASE.IDLE, DIRECTOR_PHASE.DONE, DIRECTOR_PHASE.FAILED])

const initialState = {
  phase: DIRECTOR_PHASE.IDLE,
  scenarioId: null,
  faultTarget: null,
  incidentId: null,
  outcome: null,
  message: null,
}

function reducer(state, action) {
  switch (action.type) {
    case 'START':
      return { ...initialState, phase: DIRECTOR_PHASE.RESETTING, scenarioId: action.scenarioId }
    case 'RESET_OK':
      return { ...state, phase: DIRECTOR_PHASE.CONFIRMING_RESET }
    case 'RESET_CONFIRMED':
      return { ...state, phase: DIRECTOR_PHASE.LAUNCHING }
    case 'AWAITING_INCIDENT':
      return { ...state, phase: DIRECTOR_PHASE.AWAITING_INCIDENT, faultTarget: action.faultTarget }
    case 'INCIDENT_FOUND':
      return { ...state, phase: DIRECTOR_PHASE.FOLLOWING, incidentId: action.incidentId }
    case 'DONE':
      return { ...state, phase: DIRECTOR_PHASE.DONE, outcome: action.outcome, message: null }
    case 'FAIL':
      return { ...state, phase: DIRECTOR_PHASE.FAILED, message: action.message }
    case 'ABORT':
      return { ...initialState, message: 'stopped — world left as-is' }
    case 'DISMISS':
      return { ...initialState }
    default:
      return state
  }
}

/**
 * The state machine itself. `snapshot` is the live `/world` poll already flowing through
 * `DeckApp`; `onFocusIncident` is `DeckApp`'s existing `handleSelectIncident`. Returned object
 * is what `ScenariosPanel` renders and drives.
 */
function useDemoDirectorState(snapshot, onFocusIncident) {
  const [state, dispatch] = useReducer(reducer, initialState)
  const abortedRef = useRef(false)
  const timeoutRef = useRef(null)
  const controllerRef = useRef(null)
  const phaseRef = useRef(state.phase)
  phaseRef.current = state.phase

  const clearBoundedTimeout = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
  }, [])

  // Arms exactly one pending bound at a time (any earlier one is implicitly replaced). Firing
  // it only ever calls `onTimeout` — the caller decides that means "fail soft", never
  // "proceed as if the state had arrived".
  const armTimeout = useCallback((ms, onTimeout) => {
    clearBoundedTimeout()
    timeoutRef.current = setTimeout(() => {
      timeoutRef.current = null
      if (abortedRef.current) return
      onTimeout()
    }, ms)
  }, [clearBoundedTimeout])

  useEffect(() => () => {
    clearBoundedTimeout()
    controllerRef.current?.abort()
  }, [clearBoundedTimeout])

  const launchScenario = useCallback(async (scenarioId) => {
    try {
      const res = await fetch('/scenarios/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario_id: scenarioId }),
        signal: controllerRef.current?.signal,
      })
      if (abortedRef.current) return
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        dispatch({ type: 'FAIL', message: `scenario launch rejected: ${data.detail ?? res.status}` })
        return
      }
      const data = await res.json()
      if (abortedRef.current) return
      dispatch({ type: 'AWAITING_INCIDENT', faultTarget: data.fault_target })
      armTimeout(FAULT_TIMEOUT_MS, () => dispatch({
        type: 'FAIL',
        message: `no incident opened within ${FAULT_TIMEOUT_MS / 1000}s of the scheduled fault — run manually`,
      }))
    } catch (e) {
      if (abortedRef.current) return
      dispatch({ type: 'FAIL', message: `scenario launch failed: ${e.message}` })
    }
  }, [armTimeout])

  // Snapshot-watching effect: one branch per waiting phase. Every branch clears the pending
  // bound BEFORE dispatching a transition, so a timeout that was already in flight can never
  // fire spuriously against a phase the machine has since left.
  useEffect(() => {
    if (abortedRef.current || !snapshot) return

    if (state.phase === DIRECTOR_PHASE.CONFIRMING_RESET) {
      // A world reset is a wholesale, synchronous state replace on the backend
      // (`app.state.core = new_state` inside `POST /world/reset`, before it responds) — but the
      // very next `/world` poll in flight when we called it may still have been issued against
      // the PRE-reset world. Waiting for one snapshot that actually shows the reset (empty
      // incidents, no active run) before trusting anything in `snapshot.incidents` is what
      // keeps this director from racing `WindowLayer`'s own reset detection: if we started
      // matching incidents against a stale, pre-reset snapshot, a leftover terminal incident
      // from the previous demo run could be mistaken for this run's own fault firing.
      const incidentsEmpty = (snapshot.incidents ?? []).length === 0
      const noActiveRun = !snapshot.active_run
      if (!incidentsEmpty || !noActiveRun) return
      clearBoundedTimeout()
      dispatch({ type: 'RESET_CONFIRMED' })
      launchScenario(state.scenarioId)
      return
    }

    if (state.phase === DIRECTOR_PHASE.AWAITING_INCIDENT) {
      const wantStation = stationOfTarget(state.faultTarget)
      const match = (snapshot.incidents ?? []).find((inc) => stationOfTarget(inc.target) === wantStation)
      if (!match) return
      clearBoundedTimeout()
      // Reuses DeckApp's existing handleSelectIncident — the same function the right rail's
      // incident list calls, which both selects the station AND raises/opens its window via
      // the existing `{incidentId, token}` focusIncident nonce. No parallel mechanism here.
      onFocusIncident(match)
      dispatch({ type: 'INCIDENT_FOUND', incidentId: match.incident_id })
      armTimeout(AGENT_TIMEOUT_MS, () => dispatch({
        type: 'FAIL',
        message: `no terminal status within ${Math.round(AGENT_TIMEOUT_MS / 1000)}s — keep following manually`,
      }))
      return
    }

    if (state.phase === DIRECTOR_PHASE.FOLLOWING) {
      const incident = (snapshot.incidents ?? []).find((inc) => inc.incident_id === state.incidentId)
      if (!incident) {
        // Only reachable if the world was reset out from under a live directed run (e.g. the
        // operator hit the manual reset button mid-demo) — never blank anything, just stop and
        // say so; the manual controls were never disabled, so the operator is already free to
        // drive from here.
        clearBoundedTimeout()
        dispatch({ type: 'FAIL', message: 'the incident left the snapshot — the world may have been reset manually' })
        return
      }
      if (TERMINAL_STATUSES.has(incident.status)) {
        clearBoundedTimeout()
        // No further action: WindowLayer spawns the scorecard itself the instant a terminal
        // incident carries an agent_run_id, off the same snapshot this effect just read.
        dispatch({ type: 'DONE', outcome: incident.status })
      }
      return
    }
  }, [snapshot, state.phase, state.faultTarget, state.incidentId, state.scenarioId, launchScenario, onFocusIncident, clearBoundedTimeout, armTimeout])

  const start = useCallback((scenarioId) => {
    if (!IDLE_LIKE.has(phaseRef.current) || !scenarioId) return
    abortedRef.current = false
    controllerRef.current = typeof AbortController !== 'undefined' ? new AbortController() : null
    dispatch({ type: 'START', scenarioId })
    // Optimistic — set ahead of the render this dispatch will cause, so a second `start()` call
    // in the same tick (e.g. a double-click before React repaints) is still blocked by the
    // IDLE_LIKE guard above rather than firing a second reset.
    phaseRef.current = DIRECTOR_PHASE.RESETTING
    ;(async () => {
      try {
        const res = await fetch('/world/reset', { method: 'POST', signal: controllerRef.current?.signal })
        if (abortedRef.current) return
        if (!res.ok) {
          dispatch({ type: 'FAIL', message: `world reset rejected (${res.status})` })
          return
        }
      } catch (e) {
        if (abortedRef.current) return
        dispatch({ type: 'FAIL', message: `world reset failed: ${e.message}` })
        return
      }
      dispatch({ type: 'RESET_OK' })
      armTimeout(RESET_CONFIRM_TIMEOUT_MS, () => dispatch({
        type: 'FAIL',
        message: 'world did not confirm the reset in time — try again or run manually',
      }))
    })()
  }, [armTimeout])

  // Abortable mid-sequence, per the brief: stop watching, stop waiting, never issue another
  // `/world/reset` on the way out. Whatever the world happens to be at the moment of abort is
  // exactly what it stays — no cleanup reset, no extra call of any kind.
  const abort = useCallback(() => {
    if (IDLE_LIKE.has(phaseRef.current)) return
    abortedRef.current = true
    clearBoundedTimeout()
    controllerRef.current?.abort()
    dispatch({ type: 'ABORT' })
  }, [clearBoundedTimeout])

  const dismiss = useCallback(() => {
    if (!IDLE_LIKE.has(phaseRef.current)) return
    dispatch({ type: 'DISMISS' })
  }, [])

  return { ...state, start, abort, dismiss, isRunning: !IDLE_LIKE.has(state.phase) }
}

// Context so ScenariosPanel (nested three levels down: DeckApp -> LeftRail -> ScenariosPanel)
// can reach this without DeckApp having to plumb new props through LeftRail.jsx — a file P14 is
// editing in parallel right now and this package does not own. Context crosses that boundary
// without touching it: LeftRail keeps rendering `<ScenariosPanel onOpenReplay={...} />` exactly
// as it does today: this line does not become a diff LeftRail even to see land.
const DemoDirectorContext = createContext(null)

// `createElement`, not JSX — this file is `.js` (a hook module, matching every other
// `use*.js` in this directory), and the build's JSX transform only runs on `.jsx`/`.tsx`.
export function DemoDirectorProvider({ snapshot, onFocusIncident, children }) {
  const director = useDemoDirectorState(snapshot, onFocusIncident)
  return createElement(DemoDirectorContext.Provider, { value: director }, children)
}

// Inert stand-in for any consumer that somehow renders outside the provider (there is none
// today — ScenariosPanel only ever mounts under DeckApp — but a hook that can throw on a
// missing provider is exactly the kind of blank-panel risk Invariant 10 exists to rule out).
const INERT_DIRECTOR = {
  ...initialState,
  start: () => {},
  abort: () => {},
  dismiss: () => {},
  isRunning: false,
}

export function useDemoDirector() {
  const ctx = useContext(DemoDirectorContext)
  return ctx ?? INERT_DIRECTOR
}
