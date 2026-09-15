"""The event processor — admission control.

Answers one question per event: is this merely something that happened, or does it represent
an incident worth waking the agent for?

```text
vehicle connected / charging started / stopped normally  -> log only
one failed session                                        -> log, increment counter
>= 3 failed sessions in 10 sim-minutes                     -> INCIDENT (SESSION_FAILURES)
thermal warning                                            -> log, increment counter
connector faulted                                          -> INCIDENT (CHARGER_FAULT)
component health -> FAILED                                 -> INCIDENT (COMPONENT_FAILURE)
communication -> DISCONNECTED                               -> INCIDENT (COMMUNICATION_LOSS)
```

Every event already reached the store via the bus (`EventStore.insert` is a separate
subscriber, see `wiring.py`) before this handler runs — admission control decides what wakes
the agent, never what gets recorded.
"""

from __future__ import annotations

from collections import defaultdict

from backend.pipeline.events import Event
from backend.pipeline.incident import IncidentManager

SESSION_FAILURE_THRESHOLD = 3
SESSION_FAILURE_WINDOW_SIM_SECONDS = 600   # 10 minutes, in sim time, not wall time


def _component_target(source: str) -> str:
    """`"ST-02.cooling"` -> `"ST-02"` — a component-level incident's target_id is
    the station, not the dotted `station.component` path the simulator uses internally."""
    station_id, _, _ = source.partition(".")
    return station_id


class EventProcessor:
    def __init__(self, incident_manager: IncidentManager, twin=None) -> None:
        self._incidents = incident_manager
        # Optional so a caller without a twin (the CLI demo) keeps working unchanged;
        # without it the maintenance-hold suppression below is simply inactive.
        self._twin = twin
        # Sliding window of (sim_time, event_id) per connector target (source), so a
        # SESSION_FAILURES incident's trigger_events is the whole window that tripped the
        # threshold, not just the one event that happened to cross it.
        self._session_failures: dict[str, list[tuple[float, str]]] = defaultdict(list)

    def handle(self, event: Event) -> None:
        if event.type == "SESSION_HANDSHAKE_FAILED":
            self._record_session_failure(event)
        elif event.type == "CONNECTOR_STATUS_CHANGED" and event.new_state == "FAULTED":
            self._open(event, target=event.source, incident_type="CHARGER_FAULT")
        elif event.type == "COMPONENT_HEALTH_CHANGED" and event.new_state == "FAILED":
            self._open(event, target=_component_target(event.source), incident_type="COMPONENT_FAILURE")
        elif event.type == "COMMUNICATION_STATE_CHANGED" and event.new_state == "DISCONNECTED":
            self._open(event, target=event.source, incident_type="COMMUNICATION_LOSS")
        # Everything else — STATUS_NOTIFICATION, START_TRANSACTION, METER_VALUES,
        # THERMAL_WARNING, STATION_STATUS_CHANGED, FAULT_SCHEDULED, a DEGRADED
        # COMPONENT_HEALTH_CHANGED, a CONNECTOR_STATUS_CHANGED into anything but FAULTED —
        # is log-only: already in the store, nothing further to do here.

    def _record_session_failure(self, event: Event) -> None:
        failures = self._session_failures[event.source]
        failures.append((event.sim_time, event.event_id))
        window_start = event.sim_time - SESSION_FAILURE_WINDOW_SIM_SECONDS
        failures[:] = [(t, eid) for t, eid in failures if t >= window_start]
        if len(failures) >= SESSION_FAILURE_THRESHOLD:
            if self._suppressed(event.source, "SESSION_FAILURES"):
                return
            event_ids = [eid for _, eid in failures]
            self._incidents.on_trigger(
                target=event.source, incident_type="SESSION_FAILURES", severity=event.severity,
                sim_time=event.sim_time, event_ids=event_ids, source=event.source,
            )

    def _suppressed(self, target: str, incident_type: str) -> bool:
        """A station handed to a human (`Station.maintenance_hold`, set by an escalation's
        ticket) stops opening *new* incidents. An incident already open for this exact key is
        unaffected — it still absorbs the event through the correlation key's normal path, so nothing
        an active run is working on is ever hidden from it. Found live: an unrecoverable
        cooling fault, correctly escalated and isolated, kept heating its own isolated
        connector until TEMP_PROTECTION opened a second incident for the same known fault."""
        if self._twin is None:
            return False
        if self._incidents.find_open(target, incident_type) is not None:
            return False
        station_id = target.partition("/")[0].partition(".")[0]
        station = self._twin.stations.get(station_id)
        return station is not None and station.maintenance_hold

    def _open(self, event: Event, *, target: str, incident_type: str) -> None:
        if self._suppressed(target, incident_type):
            return
        self._incidents.on_trigger(
            target=target, incident_type=incident_type, severity=event.severity,
            sim_time=event.sim_time, event_ids=[event.event_id], source=event.source,
        )
