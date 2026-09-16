import { TOOL_CATEGORY } from '../contracts'

// ------------------------------------------------------------------------------------------
// Pipeline phase derivation — the ONE place that maps the README pipeline (Fault -> Detection
// -> Investigation -> Diagnosis -> Action -> Verification -> Recovery/Escalation) onto data
// already rendered elsewhere on screen. Pure and total: every input combination below produces
// exactly one PHASE value, including two explicit, named fallbacks. Nothing here reads a
// threshold, infers an outcome, or guesses — see the table below and the invariant note at the
// bottom of this file.
//
// Fields read, and nowhere else:
//   - snapshot.incidents[].status / .opened_sim_time / .incident_id / .agent_run_id
//   - snapshot.active_run.run_id / .incident_id
//   - run.tool_log[].tool                          (run == useRun(runId) result, StatusBar.jsx)
//   - TOOL_CATEGORY (src/contracts.js)              (mirrors backend/data/capabilities.json)
//
// Incident-selection rule is copied verbatim from the one already live in two other files
// (frontend/src/App.jsx and components/deck/windows/WindowLayer.jsx): prefer the incident
// behind `snapshot.active_run`, else the most recently opened incident in
// `snapshot.incidents` — so a just-finished run's RESOLVED/ESCALATED outcome stays on screen
// instead of the strip going blank the instant `active_run` clears. This file is now the only
// place that rule lives for phase purposes; it does not change App.jsx/WindowLayer.jsx's own
// copies.
//
// Backend status vocabulary — verbatim from backend/pipeline/incident.py:
//   NON_TERMINAL_STATUSES = ('OPEN', 'INVESTIGATING', 'RECOVERING', 'VERIFYING')
//   TERMINAL_STATUSES     = ('RESOLVED', 'ESCALATED', 'FAILED')
//
// There is no backend status for "diagnosing" vs "acting" — both can happen while the incident
// carries a single status value. Traced directly from backend/agent/harness.py (and mirrored by
// the scripted backend/agent/stub_agent.py):
//   - a fresh incident opens at status 'OPEN' (backend/pipeline/incident.py, on_trigger)
//   - the harness sets 'INVESTIGATING' the moment a run starts, before any tool call
//     (stub_agent.py:124; harness.py's own setup does the same)
//   - status becomes 'RECOVERING' only when the first ACTION-category tool is applied:
//     harness.py — `if category == "ACTION": ... if incident.status == "INVESTIGATING":
//     self.incidents.advance(incident, "RECOVERING", ...)`. Consequently a DIAGNOSTIC-category
//     call (the only DIAGNOSTIC tool is `run_diagnostic`) can only ever be logged while status
//     is still 'INVESTIGATING' — that is the one bit this file reads out of `tool_log` to split
//     INVESTIGATE from DIAGNOSE.
//   - 'VERIFYING' is set inside `_handle_propose_resolution`, then either 'RESOLVED' or back to
//     'RECOVERING' (the retry loop) depending on the verifier's verdict.
//   - 'ESCALATED'/'FAILED' are written directly by the harness (the agent's own ESCALATION-tool
//     call, a guardrail breach via `_run_forced_escalation`, or an unrecoverable harness error)
//     and, by that same code, can be reached from ANY non-terminal status — a guardrail can fire
//     before the agent ever diagnoses or acts. That is exactly why this file does not try to
//     reconstruct "which earlier segments were passed through" for a terminal phase — see the
//     invariant note below.
//
// PHASE TABLE — inputs -> output, total:
//
//   incident selected?   status           hasDiagnosticToolLogEntry   -> PHASE
//   -------------------  ---------------  --------------------------  -----------
//   no                   —                —                           IDLE
//   yes                  'OPEN'           —                           DETECT
//   yes                  'INVESTIGATING'  false                       INVESTIGATE
//   yes                  'INVESTIGATING'  true                        DIAGNOSE
//   yes                  'RECOVERING'     —                           ACT
//   yes                  'VERIFYING'      —                           VERIFY
//   yes                  'RESOLVED'       —                           RESOLVED
//   yes                  'ESCALATED'      —                           ESCALATED
//   yes                  'FAILED'         —                           FAILED
//   yes                  <anything else>  —                           UNKNOWN
//
// `hasDiagnosticToolLogEntry` = run?.tool_log some entry whose TOOL_CATEGORY[entry.tool] ===
// 'DIAGNOSTIC'. A missing/not-yet-loaded `run` (useRun poll hasn't returned, or there is no
// run for this incident yet) reads as `false`, which lands on INVESTIGATE — the honest reading
// (no diagnostic call is known to have happened), never a guess at DIAGNOSE.
//
// IDLE and UNKNOWN are named fallbacks, not guesses at one of the six pipeline phases: IDLE
// means "no incident to derive a phase from at all" (quiet NOC); UNKNOWN means "an incident
// exists but its status isn't one this table recognises" (defensive against a future backend
// status this file hasn't been updated for). Both render as "no segment lit" in StatusBar —
// see the invariant note.
//
// INVARIANT 2 NOTE — why the strip lights only the current segment, never a filled trail:
// A progress-bar rendering ("light every segment up to and including the current one") would be
// a safe, code-guaranteed reading for the five non-terminal phases (the harness's own state
// machine, traced above, never skips DETECT -> INVESTIGATE -> DIAGNOSE -> ACT -> VERIFY out of
// order). It is NOT safe for the terminal phases: ESCALATED/FAILED can be written from any
// non-terminal status, so "fill in DIAGNOSE/ACT/VERIFY too" would assert those segments were
// reached when the data does not say so. Rather than special-case terminal vs non-terminal
// fill behaviour, this file (and StatusBar) light exactly the one PHASE segment `derivePhase`
// returns and nothing else — a single indicator that advances one segment at a time, always
// backed by a field this file can name.
// ------------------------------------------------------------------------------------------

// ⚠ LOAD-BEARING COUPLING — do not rename the last three values.
//
// `RESOLVED`, `ESCALATED` and `FAILED` are not merely display labels: their STRING VALUES are
// deliberately identical to backend/pipeline/incident.py's
// `TERMINAL_STATUSES = ("RESOLVED", "ESCALATED", "FAILED")`, and `useDemoDirector.js` builds its
// own terminal set directly from them to decide when a directed run has finished. Renaming one
// for display purposes (say RESOLVED -> "RECOVERED") would not raise any error anywhere — the
// demo director would simply never observe a run reaching terminal, and would sit waiting until
// its bounded timeout expired, in front of judges. If a different on-screen wording is ever
// wanted, change the LABEL at the render site, never these values.
export const PHASE = Object.freeze({
  DETECT: 'DETECT',
  INVESTIGATE: 'INVESTIGATE',
  DIAGNOSE: 'DIAGNOSE',
  ACT: 'ACT',
  VERIFY: 'VERIFY',
  RESOLVED: 'RESOLVED',
  ESCALATED: 'ESCALATED',
  FAILED: 'FAILED',
  IDLE: 'IDLE', // fallback: no incident selected
  UNKNOWN: 'UNKNOWN', // fallback: incident status not in the table above
})

// The six displayed segments, in pipeline order. `matches` lists every PHASE value that lights
// this box. The terminal box's `matches` covers all three terminal statuses — StatusBar picks
// the tone (mint/amber/rose) and label word from the actual phase, never a fourth guessed one.
export const PHASE_SEGMENTS = [
  { key: 'DETECT', label: 'DETECT', matches: [PHASE.DETECT] },
  { key: 'INVESTIGATE', label: 'INVESTIGATE', matches: [PHASE.INVESTIGATE] },
  { key: 'DIAGNOSE', label: 'DIAGNOSE', matches: [PHASE.DIAGNOSE] },
  { key: 'ACT', label: 'ACT', matches: [PHASE.ACT] },
  { key: 'VERIFY', label: 'VERIFY', matches: [PHASE.VERIFY] },
  {
    key: 'TERMINAL',
    label: 'RESOLVED/ESCALATED',
    matches: [PHASE.RESOLVED, PHASE.ESCALATED, PHASE.FAILED],
  },
]

// Same incident-selection rule as App.jsx / WindowLayer.jsx (see file header). Returns `null`
// when there is nothing to select — the IDLE row of the table above.
export function selectIncident(snapshot) {
  const incidents = snapshot?.incidents ?? []
  if (incidents.length === 0) return null
  const mostRecent = [...incidents].sort((a, b) => b.opened_sim_time - a.opened_sim_time)[0]
  const activeIncidentId = snapshot?.active_run?.incident_id ?? null
  if (activeIncidentId) {
    const active = incidents.find((i) => i.incident_id === activeIncidentId)
    if (active) return active
  }
  return mostRecent ?? null
}

// Which run (if any) to pass to `useRun` for a given selected incident — `active_run.run_id`
// while the incident is the one currently running, else that incident's own `agent_run_id` so a
// terminal incident's tool_log (and therefore its DIAGNOSE/INVESTIGATE split) still resolves.
export function selectRunId(snapshot, incident) {
  return snapshot?.active_run?.run_id ?? incident?.agent_run_id ?? null
}

function hasDiagnosticEntry(toolLog) {
  if (!Array.isArray(toolLog)) return false
  return toolLog.some((entry) => TOOL_CATEGORY[entry?.tool] === 'DIAGNOSTIC')
}

// The pure, total mapping. `snapshot` and `run` are exactly `useSnapshot()`'s result and
// `useRun(runId)`'s result (may be `null`/stale — both are read defensively, never assumed
// present, per Invariant 10: a lagging/failed poll must fall back honestly, not crash or blank).
export function derivePhase(snapshot, run) {
  const incident = selectIncident(snapshot)
  if (!incident) return PHASE.IDLE

  switch (incident.status) {
    case 'OPEN':
      return PHASE.DETECT
    case 'INVESTIGATING':
      return hasDiagnosticEntry(run?.tool_log) ? PHASE.DIAGNOSE : PHASE.INVESTIGATE
    case 'RECOVERING':
      return PHASE.ACT
    case 'VERIFYING':
      return PHASE.VERIFY
    case 'RESOLVED':
      return PHASE.RESOLVED
    case 'ESCALATED':
      return PHASE.ESCALATED
    case 'FAILED':
      return PHASE.FAILED
    default:
      return PHASE.UNKNOWN
  }
}
