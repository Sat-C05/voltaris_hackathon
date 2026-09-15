// Turns one tool_log entry's `result` into a short, literal summary — never inference, never
// the model's own words, just picking the fields of the tool's own return value that matter.
// Verified field-by-field against real `GET /runs/{id}` and `POST /runs/{id}/replay` data on
// (RUN-001 through RUN-006) for every branch except `get_recent_events`,
// `get_recent_transactions` and `notify_operator`, which no observed run happened to call —
// those three fall through to the generic summary below, which is still literal tool output,
// just not hand-tuned per field.
export function summarizeResult(tool, args, result) {
  if (result == null) return ''
  switch (tool) {
    case 'get_station_state':
      return `${result.status}${result.communication_state && result.communication_state !== 'CONNECTED' ? ' · link ' + result.communication_state.toLowerCase() : ''}`
    case 'get_connector_status':
      return String(result.status ?? genericSummary(result))
    case 'get_telemetry':
      return `${fmt1(result.temperature_c)} °C · ${fmt0(result.power_kw)} kW`
    case 'get_component_state':
      return `${result.component} ${result.health}`
    case 'run_diagnostic':
      return result.notes ?? summarizeSelfTests(result.self_tests) ?? genericSummary(result)
    case 'reset_connector':
      return String(result.status ?? genericSummary(result))
    case 'restart_component':
      return `${result.health}${result.changed === false ? ' (unchanged)' : ''}`
    case 'set_connector_availability':
      return String(result.status ?? genericSummary(result))
    case 'create_maintenance_ticket':
      return result.ticket_created ? 'ticket created' : genericSummary(result)
    case 'notify_operator':
      return result.notified ? 'operator notified' : genericSummary(result)
    case 'wait':
      return `${args?.sim_seconds ?? '?'} sim-seconds → ${fmt1(result.temperature_c)} °C`
    default:
      return genericSummary(result)
  }
}

function summarizeSelfTests(selfTests) {
  if (!selfTests || typeof selfTests !== 'object') return null
  const failing = Object.entries(selfTests).filter(([, t]) => t?.result === 'FAIL')
  if (failing.length > 0) return failing.map(([name]) => `self_test ${name} FAIL`).join(', ')
  return null
}

function fmt1(v) { return typeof v === 'number' ? v.toFixed(1) : v ?? '—' }
function fmt0(v) { return typeof v === 'number' ? v.toFixed(0) : v ?? '—' }

// Fallback for any result shape not special-cased above: the first few primitive top-level
// fields, verbatim. Never invents a value, never reaches into nested objects to guess at one.
function genericSummary(result) {
  if (typeof result !== 'object') return String(result)
  const parts = []
  for (const [k, v] of Object.entries(result)) {
    if (v == null || typeof v === 'object') continue
    parts.push(`${k} ${v}`)
    if (parts.length === 3) break
  }
  return parts.length > 0 ? parts.join(' · ') : JSON.stringify(result).slice(0, 100)
}

// The one argument worth showing next to the tool name on a row — whichever of these the call
// actually has. Every tool in capabilities.json takes `station_id` plus at most one more
// identifying field; this just picks the first one present.
export function primaryArg(args) {
  if (!args) return ''
  for (const key of ['component', 'connector_id', 'subsystem', 'target']) {
    if (args[key]) return String(args[key])
  }
  return args.station_id ? String(args.station_id) : ''
}

// A failed predicate, verified field-by-field against a real guardrail-forced verification
// failure (RUN-007, INC-001, GUARDRAIL_MAX_CONSECUTIVE_OBSERVATIONS):
// {target, property, op, value, observed} — e.g.
//   {"target":"ST-02","property":"telemetry.temperature_c","op":"<","value":55.0,"observed":76.67}
// Rendered in the same "observed not required" phrasing the design doc's own mock uses
// ("temperature_c 71.2 not < 55.0"). Falls back to raw JSON for any shape that isn't this one.
export function formatPredicate(p) {
  if (typeof p === 'string') return p
  if (p && typeof p === 'object' && p.property && 'op' in p) {
    const value = Array.isArray(p.value) ? `[${p.value.join(', ')}]` : p.value
    return `${p.property} ${p.observed} not ${p.op} ${value}`
  }
  return JSON.stringify(p)
}
