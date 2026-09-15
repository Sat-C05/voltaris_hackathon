"""Context builder and prompt renderer.

Deliberately narrow: incident header, current connector/station state, the last 10 events for
this target, and the *names* of components present — never a component's `health`. The agent
has to call `get_component_state`/`run_diagnostic` to learn that; handing it over here would
make investigation theatre, not real — the no-root-cause rule extended to the prompt itself.
"""

from __future__ import annotations

from pathlib import Path

from backend import config
from backend.pipeline.incident import Incident
from backend.pipeline.store import EventStore
from backend.world.twin import Twin

_JSON_TYPE = {"string": "string", "integer": "integer", "bool": "boolean", "float": "number"}

# Not a world action — a request to the harness, so it is rendered and offered to the
# model as a tool alongside capabilities.json's twelve, but it has no capability entry and is
# never policy-checked.
PROPOSE_RESOLUTION = "propose_resolution"

# Also not a world action, and for exactly the same reason as `propose_resolution`:
# letting simulated time pass is a request to the harness's clock, not something the agent does
# to the infrastructure. It therefore has no capability entry, is never policy-checked, and
# does not count against the per-capability attempt limits — but it does cost a step.
# Without it the agent has no way to wait for a time-dependent safety constraint to clear
# (e.g. a station cooling below TEMP_SAFE after its cooling controller is restarted), because
# the only improvised substitute — polling `get_telemetry` — trips DUPLICATE_CALL_LIMIT on the
# third identical call.
WAIT = "wait"


def load_protocol(path: Path | None = None) -> str:
    return Path(path or config.PROTOCOL_FILE).read_text().strip()


def render_tools_schema(capabilities: dict) -> list[dict]:
    """Ollama's native `tools` param (OpenAI-style function schema), one entry per capability
    plus `propose_resolution`."""
    tools = []
    for name, entry in capabilities.items():
        properties = {
            param: {"type": _JSON_TYPE.get(kind, "string")}
            for param, kind in entry["params"].items()
        }
        tools.append({
            "type": "function",
            "function": {
                "name": name,
                "description": entry["description"],
                "parameters": {
                    "type": "object",
                    "properties": properties,
                    "required": list(properties.keys()),
                },
            },
        })
    tools.append({
        "type": "function",
        "function": {
            "name": WAIT,
            "description": (
                "Let simulated time pass at a station and then read its telemetry back. Use "
                "this when a condition needs time to change — for example after restarting a "
                "cooling controller, when the station must cool below the safe reset "
                "temperature before a connector may be reset. Waits up to 900 simulated "
                "seconds per call."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "station_id": {"type": "string"},
                    "sim_seconds": {"type": "integer", "description": "How long to wait, in simulated seconds (15-900)."},
                },
                "required": ["station_id", "sim_seconds"],
            },
        },
    })
    tools.append({
        "type": "function",
        "function": {
            "name": PROPOSE_RESOLUTION,
            "description": (
                "Propose that this incident is resolved. This does not resolve anything by "
                "itself — the system verifies live state and reports back whether it actually "
                "passed."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "evidence": {"type": "string", "description": "What you observed that supports resolution."},
                },
                "required": ["evidence"],
            },
        },
    })
    return tools


def render_capabilities_for_prompt(capabilities: dict) -> str:
    lines = [
        f"  {name}({', '.join(entry['params'].keys())}) [{entry['category']}] — {entry['description']}"
        for name, entry in capabilities.items()
    ]
    lines.append(
        f"  {WAIT}(station_id, sim_seconds) [TIME] — let simulated time pass (up to 900 s) and "
        "read the station's telemetry back; use it to wait out a condition that needs time, "
        "such as a station cooling down after a cooling restart."
    )
    lines.append(
        f"  {PROPOSE_RESOLUTION}(evidence) [RESOLUTION REQUEST] — propose that this incident "
        "is resolved; the system verifies live state before accepting it."
    )
    return "\n".join(lines)


def build_incident_context(*, incident: Incident, twin: Twin, event_store: EventStore) -> str:
    station_id, _, connector_id = incident.target.partition("/")
    station = twin.stations[station_id]

    lines = [
        f"INCIDENT {incident.incident_id}",
        f"Target: {incident.target}",
        f"Type: {incident.type}   Severity: {incident.severity}",
        f"Opened: sim_time {incident.opened_sim_time:.0f}",
        "",
        "CURRENT STATE",
    ]
    if connector_id:
        lines.append(f"  connector {connector_id}: {station.connectors[connector_id].status}")
    lines.append(f"  station {station_id}: {station.status}")
    lines.append("")

    lines.append("RECENT EVENTS (last 10, for this target)")
    events = list(reversed(event_store.for_source(incident.target, limit=10)))
    if not events:
        lines.append("  (none)")
    for e in events:
        transition = f"  {e.previous_state} -> {e.new_state}" if e.previous_state else ""
        lines.append(f"  {e.sim_time:>7.1f}  {e.type}{transition}")
    lines.append("")

    lines.append("COMPONENTS PRESENT")
    lines.append("  " + ", ".join(station.components.keys()))
    return "\n".join(lines)


def render_success_criteria(*, goals: list[dict], constraints: list[dict]) -> str:
    lines = ["Goals (must all become true):"]
    lines += [f"  {g['target']}.{g['property']} {g['op']} {g['value']}" for g in goals]
    lines.append("Constraints (must all hold once goals are met):")
    lines += [f"  {c['target']}.{c['property']} {c['op']} {c['value']}" for c in constraints]
    return "\n".join(lines)


def build_system_prompt(*, incident_context: str, capabilities_text: str,
                         success_criteria_text: str, max_steps: int, max_actions: int,
                         max_consecutive_observations: int = config.MAX_CONSECUTIVE_OBSERVATIONS) -> str:
    protocol_text = load_protocol()
    return f"""SYSTEM ROLE
You are an autonomous EV charging operations agent.

OBJECTIVE
Restore service safely when possible. If remote recovery is not safe or not possible, isolate
the affected resource and escalate.

PROTOCOL
{protocol_text}

CURRENT INCIDENT
{incident_context}

AVAILABLE CAPABILITIES
{capabilities_text}

SUCCESS CRITERIA
{success_criteria_text}

CONSTRAINTS
You have at most {max_steps} tool calls and {max_actions} recovery actions for this incident.
You may make at most {max_consecutive_observations} observations in a row without acting; the
next one ends the run in a forced escalation. This station has six components, so reading them
one by one is not a strategy that fits inside that budget — a run that spends it enumerating
ends with a station isolated and ticketed and nothing learned. Telling the budget to you is not
a request: it is enforced in code whatever you do.
You cannot mark an incident resolved yourself; call propose_resolution and the system will
verify it against live state.

HOW THIS RUN ENDS
There are exactly three endings, and you choose between two of them:
  propose_resolution(evidence) — the system verifies the success criteria above against live
    state and resolves the incident if they hold. This is the ONLY route to a resolved
    incident. The moment your readings show the criteria met, call it; it costs you nothing if
    it fails, and the system tells you which predicate did not hold.
  an escalation tool — when recovery is not possible or not safe.
  neither, for too long — the system ends the run for you, isolates the target and escalates.
    That is the one ending you should never reach by accident: a station you have already
    repaired still ends up out of service and on an engineer's list.
"""
