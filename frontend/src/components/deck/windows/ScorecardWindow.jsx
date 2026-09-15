import { useEvaluation } from '../../../useEvaluation'
import { fmtSimDuration } from './format'

const OUTCOME_TONE = {
  RESOLVED: 'text-mint',
  ESCALATED: 'text-amber', // Invariant 8: escalation is a success — never rose here.
  FAILED: 'text-rose',
}

// The Scorecard's content. Source is `GET /evaluation/{run_id}` alone (fetched once, on
// terminal — `useEvaluation` does the one-shot fetch, this component only renders what comes
// back). Chrome (border/titlebar/✕) is `<Window>`'s, exactly as IncidentWindow leaves it.
export default function ScorecardWindow({ runId }) {
  // The window only spawns once the incident is already terminal (WindowLayer's spawn rule),
  // so there is no "not yet enabled" state to gate on here — always on, same as AgentConsoleWindow
  // reading its own runId prop straight into its hook.
  const { evaluation, error } = useEvaluation(runId, true)

  if (!evaluation) {
    return (
      <div className="text-dim">{error ? 'evaluation unavailable' : 'loading…'}</div>
    )
  }

  const hasScenario = evaluation.scenario_id != null
  const outcomeClass = OUTCOME_TONE[evaluation.outcome] ?? 'text-ink'
  // A GUARDRAIL_* reason is the harness taking over, not the agent choosing to escalate — call
  // that out in violet (AgentConsoleWindow uses the same colour for its "⚙ HARNESS" rows) so a
  // judge can tell the two apart at a glance, the same distinction scored under `recovery`.
  const isGuardrail = typeof evaluation.escalation_reason === 'string' && evaluation.escalation_reason.startsWith('GUARDRAIL_')

  return (
    <div className="flex flex-col gap-2">
      {hasScenario && (
        <div className="flex items-baseline justify-between">
          <span className="text-dim tracking-wide">scenario</span>
          <span className="text-ink">{evaluation.scenario_id}</span>
        </div>
      )}

      <div className="flex flex-col gap-0.5">
        <div className="flex items-baseline justify-between">
          <span className="text-dim tracking-wide">outcome</span>
          <span className={`text-[13px] font-medium tracking-wide ${outcomeClass}`}>{evaluation.outcome}</span>
        </div>
        {evaluation.escalation_reason && (
          <div className={`text-[11px] ${isGuardrail ? 'text-violet' : 'text-dim'}`}>
            {isGuardrail ? '⚙ ' : ''}{evaluation.escalation_reason}
          </div>
        )}
      </div>

      <div className="border-t border-edge/70" />

      {hasScenario ? (
        <div className="flex flex-col gap-1">
          <ScoreRow
            label="DETECTION"
            ok={evaluation.detection}
            annotation={evaluation.detection_latency_sim_seconds != null ? fmtSimDuration(evaluation.detection_latency_sim_seconds) : null}
          />
          <ScoreRow
            label="ACTION SAFETY"
            ok={evaluation.action_safety}
            annotation={`${evaluation.forbidden_actions_attempted?.length ?? 0} forbidden`}
          />
          <ScoreRow
            label="RECOVERY"
            ok={evaluation.recovery}
            annotation={
              evaluation.outcome === 'ESCALATED'
                ? (isGuardrail ? 'guardrail escalation' : 'agent escalation')
                : null
            }
          />
          <DiagnosticRow evaluation={evaluation} />
        </div>
      ) : (
        // A manual fault has no scenario — show `— no scenario · counts only` rather
        // than fake ✓s." No ScoreRow is rendered at all in this branch.
        <div className="text-dim">— no scenario · counts only</div>
      )}

      <div className="border-t border-edge/70" />

      <div className="flex flex-col gap-0.5 text-dim">
        <div>
          tool calls {evaluation.tool_calls} · actions {evaluation.recovery_actions}
          {hasScenario && evaluation.reference_action_count != null && <> (ref {evaluation.reference_action_count})</>}
        </div>
        <div>
          policy rejections {evaluation.policy_rejections} · guardrail {evaluation.guardrail_fired ? 'FIRED' : '—'}
        </div>
      </div>
    </div>
  )
}

// One score line: label, ✓/✗ glyph in mint/rose, and a short right-hand annotation. Diagnostic's
// three-valued case has its own component below rather than a `notAssessable` flag threaded
// through here, since "null" only ever applies to that one row.
function ScoreRow({ label, ok, annotation }) {
  return (
    <div className="flex items-baseline justify-between text-[13px]">
      <span className="tracking-wide text-dim">{label}</span>
      <span className="flex items-baseline gap-2">
        <span className={ok ? 'text-mint' : 'text-rose'}>{ok ? '✓' : '✗'}</span>
        {annotation && <span className="text-[11px] text-dim">{annotation}</span>}
      </span>
    </div>
  )
}

// DIAGNOSTIC is three-valued (`score_scenario`'s `diagnostic_accuracy`): true, false, or null
// when the scenario gives the scorer nothing to check the agent's first action against. Null is
// "not assessable", never a ✗ — collapsing it to false would score an unscoreable run as wrong.
function DiagnosticRow({ evaluation }) {
  const { diagnostic_accuracy: accuracy, first_action_tool, first_action_component } = evaluation
  if (accuracy == null) { // `== null` catches an absent field too, not just an explicit JSON null
    return (
      <div className="flex items-baseline justify-between text-[13px]">
        <span className="tracking-wide text-dim">DIAGNOSTIC</span>
        <span className="flex items-baseline gap-2">
          <span className="text-dim">—</span>
          <span className="text-[11px] text-dim">not assessable</span>
        </span>
      </div>
    )
  }
  const annotation = first_action_tool
    ? `${first_action_tool}${first_action_component ? ' · ' + first_action_component : ''}`
    : null
  return <ScoreRow label="DIAGNOSTIC" ok={accuracy} annotation={annotation} />
}
