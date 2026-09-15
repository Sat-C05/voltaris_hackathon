"""The event envelope and event-type naming.

Event type names are OCPP-shaped (`STATUS_NOTIFICATION`, `START_TRANSACTION`, `METER_VALUES`,
`HEARTBEAT_MISSED`) because it costs nothing and makes the architecture legible to anyone who
knows the protocol. This is a naming convention only — nothing here integrates or
references an OCPP library.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any


@dataclass(frozen=True)
class Event:
    event_id: str
    sim_time: float
    wall_time: str
    source: str
    type: str
    previous_state: str | None
    new_state: str | None
    severity: str
    metadata: dict[str, Any] = field(default_factory=dict)


class EventIdSequence:
    """Owned by whichever component turns raw simulator callbacks into `Event`s — one per
    world instance (see `pipeline/wiring.py`), not a process-wide global, so a world reset
    restarts numbering at `evt_0001` rather than carrying state across worlds."""

    def __init__(self) -> None:
        self._n = 0

    def next(self) -> str:
        self._n += 1
        return f"evt_{self._n:04d}"


def _wall_time_now() -> str:
    # The *only* other place wall-clock time may appear besides the harness
    # timeout — written once at emission for human readers, never read back by logic.
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def severity_for(event_type: str, new_state: str | None) -> str:
    """A display severity for the envelope (`"HIGH"`, `"MEDIUM"`, ...) — an implementation
    choice for the timeline/incident panel; revisit if a scenario ever needs a finer grade
    than these four buckets."""
    if event_type in ("CONNECTOR_STATUS_CHANGED", "STATION_STATUS_CHANGED") and new_state == "FAULTED":
        return "HIGH"
    if event_type == "COMPONENT_HEALTH_CHANGED" and new_state == "FAILED":
        return "HIGH"
    if event_type == "COMMUNICATION_STATE_CHANGED" and new_state == "DISCONNECTED":
        return "HIGH"
    if event_type == "THERMAL_WARNING":
        return "MEDIUM"
    if event_type == "COMPONENT_HEALTH_CHANGED" and new_state == "DEGRADED":
        return "MEDIUM"
    if event_type == "SESSION_HANDSHAKE_FAILED":
        return "LOW"
    return "INFO"


def make_event(id_seq: EventIdSequence, sim_time: float, event_type: str, **fields: Any) -> Event:
    """Builds an `Event` from a `Simulator.on_event(sim_time, event_type, **fields)` call
    `source`/`target` are simulator field names for the same
    concept — whichever is present becomes the envelope's `source`."""
    source = fields.pop("source", None) or fields.pop("target", None) or ""
    previous_state = fields.pop("previous_state", None)
    new_state = fields.pop("new_state", None)
    # The fault object's numeric severity (0.0-1.0) is a different concept from
    # the envelope's display severity string below — kept in metadata under its own name so
    # the two never collide under the same "severity" key.
    fault_severity = fields.pop("severity", None)
    metadata = dict(fields)
    if fault_severity is not None:
        metadata["fault_severity"] = fault_severity

    return Event(
        event_id=id_seq.next(),
        sim_time=sim_time,
        wall_time=_wall_time_now(),
        source=source,
        type=event_type,
        previous_state=previous_state,
        new_state=new_state,
        severity=severity_for(event_type, new_state),
        metadata=metadata,
    )
