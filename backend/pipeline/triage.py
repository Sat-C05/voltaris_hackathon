"""Pre-run triage: is this incident still real? Admission control applied a second time — at
the moment a run would start, rather than when the event arrived.

The correlation key dedupes per `(target_id, incident_type)`, which is right, but one physical fault
legitimately produces several *different* keys: a failed cooling controller opens
`COMPONENT_FAILURE`, and the temperature it drives opens `CHARGER_FAULT` when the connector
crosses TEMP_PROTECTION. Runs then happen one at a time. By the time the second one
reaches the front of the queue, the first run has usually already fixed the cause — and the
agent gets handed an incident whose symptom is gone, finds every reading nominal, gets
`PRECONDITION_FAILED` on everything it tries, and escalates a station that is working. Found
live, more than once: "the charger fault is being escalated even tho the charger is now
working normally."

This module answers the question deterministically, against live twin state, before a run is
spent on it — the same division of labour the Verifier has, where deterministic code answers
"did recovery actually succeed". The agent is not consulted and does not benefit: an incident
retired here never reaches it, and the agent still has no path to writing RESOLVED for an
incident it *is* given.
"""

from __future__ import annotations

from backend import config
from backend.pipeline.incident import Incident
from backend.world.twin import Twin

# Below this handshake rate a station cannot reliably start sessions — the condition behind a
# SESSION_FAILURES incident. Mirrors `_communication_self_tests`' own pass threshold in
# agent/tools.py rather than introducing a second opinion about what "healthy comms" means.
MIN_HEALTHY_HANDSHAKE_RATE = 0.8


def moot_reason(incident: Incident, twin: Twin) -> str | None:
    """Return None if the incident's triggering condition still holds, or a short human-readable
    reason if it is moot (i.e. the fault behind it is already gone).

    Each branch re-evaluates the exact condition `pipeline/processor.py` opened the incident
    on — connector FAULTED, a component at FAILED, comms DISCONNECTED, sessions failing — so
    "moot" here can never mean anything looser than "the thing that opened this is no longer
    true."
    """
    station_id, _, connector_id = incident.target.partition("/")
    station = twin.stations.get(station_id)
    if station is None:
        return f"station {station_id} no longer exists in the world"

    if incident.type == "CHARGER_FAULT":
        connector = station.connectors.get(connector_id)
        if connector is None:
            return f"connector {incident.target} no longer exists in the world"
        if connector.status != "FAULTED":
            return f"connector {incident.target} is no longer FAULTED (now {connector.status})"
        return None

    if incident.type == "COMPONENT_FAILURE":
        failed = [name for name, c in station.components.items() if c.health == "FAILED"]
        if not failed:
            return f"no component on {station_id} is FAILED any more"
        return None

    if incident.type == "COMMUNICATION_LOSS":
        if station.communication_state != "DISCONNECTED":
            return (
                f"{station_id} communication is {station.communication_state}, "
                "no longer DISCONNECTED"
            )
        return None

    if incident.type == "SESSION_FAILURES":
        if (
            station.telemetry.handshake_success_rate >= MIN_HEALTHY_HANDSHAKE_RATE
            and all(c.health == "HEALTHY" for c in station.components.values())
            and station.communication_state == "CONNECTED"
            and station.telemetry.temperature_c < config.TEMP_WARNING
        ):
            return f"{station_id} is starting sessions normally again"
        return None

    return None  # an unknown type is never retired automatically
