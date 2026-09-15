// Mirrors backend/config.py's constants. Changing a value here without changing it there
// desynchronises the UI from the backend.
// These are not in the /world snapshot, so the UI must not invent them; it copies them once,
// here, and every component that needs a threshold or a budget reads it from this file.
//
// Prefer `snapshot.active_run.max_steps` / `.max_actions` over the mirrored copies below where
// the snapshot already carries them — one less thing that can drift.

export const TEMP_WARNING = 65.0     // config.py TEMP_WARNING
export const TEMP_PROTECTION = 78.0  // config.py TEMP_PROTECTION
export const TEMP_SAFE = 55.0        // config.py TEMP_SAFE
export const AMBIENT_TEMP_C = 32.0   // config.py AMBIENT_TEMP_C
export const TICK_SIM_SECONDS = 15    // config.py TICK_SIM_SECONDS
export const MAX_STEPS = 20          // config.py MAX_STEPS      (also in snapshot.active_run)
export const MAX_ACTIONS = 5         // config.py MAX_ACTIONS    (also in snapshot.active_run)
export const MAX_CONSECUTIVE_OBSERVATIONS = 6
export const COMPONENTS = ['cooling', 'communication', 'power_module',
                           'contactor', 'temp_sensor', 'network_iface']

// Mirrors backend/data/capabilities.json's "category" field, tool by tool, read directly from
// that file. capabilities.json is the one source of truth for the tool set; this copy is
// display-only for the Agent Console and must never gain an
// entry the file itself doesn't have. Note `wait` and `propose_resolution` are NOT capabilities
// — they don't appear in capabilities.json at all, so they are deliberately absent here too;
// the Agent Console special-cases those two tool names instead of looking them up here.
export const TOOL_CATEGORY = {
  get_station_state: 'OBSERVATION',
  get_connector_status: 'OBSERVATION',
  get_telemetry: 'OBSERVATION',
  get_component_state: 'OBSERVATION',
  get_recent_events: 'OBSERVATION',
  get_recent_transactions: 'OBSERVATION',
  run_diagnostic: 'DIAGNOSTIC',
  reset_connector: 'ACTION',
  restart_component: 'ACTION',
  set_connector_availability: 'ACTION',
  create_maintenance_ticket: 'ESCALATION',
  notify_operator: 'ESCALATION',
}
