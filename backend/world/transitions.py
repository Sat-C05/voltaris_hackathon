"""Legal state transitions.

One table per entity, one function, called by both the simulator and the policy validator's
transition check — one opinion about reachability, held in one place, so the two can never
independently invent an edge the other does not know about.

`FAULTED -> AVAILABLE` is reachable only through a successful `reset_connector` plus a passing
verification; the simulator itself must never make that transition. Likewise
`DEGRADED/FAILED -> HEALTHY` only via a successful `restart_component` on a recoverable fault.
"""

from __future__ import annotations


class IllegalTransition(Exception):
    """Raised instead of silently no-op'ing. Callers that need idempotence (e.g. re-arming an
    edge-triggered threshold) must guard for it themselves before calling `transition()` —
    this function's job is only to say what's reachable, not to swallow repeats."""

    def __init__(self, entity_type: str, entity_id: str, current: str, new: str) -> None:
        self.entity_type = entity_type
        self.entity_id = entity_id
        self.current = current
        self.new = new
        super().__init__(f"{entity_type} {entity_id}: {current} -> {new} is not a legal transition")


LEGAL_CONNECTOR: dict[str, set[str]] = {
    "AVAILABLE":   {"PREPARING", "UNAVAILABLE", "FAULTED"},
    "PREPARING":   {"CHARGING", "AVAILABLE", "FAULTED"},
    "CHARGING":    {"FINISHING", "FAULTED"},
    "FINISHING":   {"AVAILABLE", "FAULTED"},
    "FAULTED":     {"AVAILABLE", "UNAVAILABLE"},
    "UNAVAILABLE": {"AVAILABLE", "FAULTED"},
}

LEGAL_STATION: dict[str, set[str]] = {
    "AVAILABLE":   {"UNAVAILABLE", "FAULTED", "OFFLINE"},
    "UNAVAILABLE": {"AVAILABLE", "FAULTED", "OFFLINE"},
    "FAULTED":     {"UNAVAILABLE", "AVAILABLE", "OFFLINE"},
    "OFFLINE":     {"AVAILABLE", "UNAVAILABLE"},
}

LEGAL_COMPONENT: dict[str, set[str]] = {
    "HEALTHY":  {"DEGRADED", "FAILED", "OFFLINE"},
    "DEGRADED": {"HEALTHY", "FAILED", "OFFLINE"},
    "FAILED":   {"HEALTHY", "OFFLINE"},
    "OFFLINE":  {"HEALTHY", "DEGRADED"},
}

LEGAL_COMMUNICATION: dict[str, set[str]] = {
    "CONNECTED":    {"DEGRADED", "DISCONNECTED"},
    "DEGRADED":     {"CONNECTED", "DISCONNECTED"},
    "DISCONNECTED": {"CONNECTED"},
}

# Incident transitions: a forward path plus a VERIFYING -> RECOVERING retry loop, and
# "any state -> ESCALATED/FAILED" as terminal exits reachable from everywhere non-terminal.
_INCIDENT_FORWARD: dict[str, set[str]] = {
    "OPEN":          {"INVESTIGATING"},
    "INVESTIGATING": {"RECOVERING"},
    "RECOVERING":    {"VERIFYING"},
    "VERIFYING":     {"RESOLVED", "RECOVERING"},
}
_INCIDENT_NON_TERMINAL = ("OPEN", "INVESTIGATING", "RECOVERING", "VERIFYING")
_INCIDENT_TERMINAL = ("RESOLVED", "ESCALATED", "FAILED")

LEGAL_INCIDENT: dict[str, set[str]] = {
    state: _INCIDENT_FORWARD.get(state, set()) | {"ESCALATED", "FAILED"}
    for state in _INCIDENT_NON_TERMINAL
}
for _terminal in _INCIDENT_TERMINAL:
    LEGAL_INCIDENT[_terminal] = set()  # terminal: no outgoing edges

LEGAL: dict[str, dict[str, set[str]]] = {
    "connector": LEGAL_CONNECTOR,
    "station": LEGAL_STATION,
    "component": LEGAL_COMPONENT,
    "communication": LEGAL_COMMUNICATION,
    "incident": LEGAL_INCIDENT,
}


def transition(entity_type: str, entity_id: str, current: str, new: str) -> str:
    """The one function. Raises `IllegalTransition` rather than allowing a
    reachability opinion to be invented ad hoc at the call site. Returns `new` on success so
    callers can write `x.status = transition(...)` at the point of mutation."""
    if new not in LEGAL[entity_type].get(current, set()):
        raise IllegalTransition(entity_type, entity_id, current, new)
    return new
