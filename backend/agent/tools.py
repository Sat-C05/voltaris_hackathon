"""The twelve tools as internal Python calls, not HTTP endpoints.

`ToolExecutor`'s public methods ARE `IMPLEMENTED_TOOLS` (see `capabilities.py`'s drift guard) —
one method per capability entry in `data/capabilities.json`, same name. OBSERVATION and
DIAGNOSTIC methods only read; ACTION and ESCALATION methods mutate the twin directly (there is
no separate "apply at next tick" queue in this MVP)
and publish the resulting state change through `on_event`, exactly like the simulator does, so
the event store and incident manager see an agent's actions the same way they see the world's.

**No tool returns a root cause.** `run_diagnostic` returns per-subsystem self-test
readings; the inference from a 410 rpm tachometer to "the fan is degraded" is the caller's job.
"""

from __future__ import annotations

from typing import Any, Callable

from backend.pipeline.store import EventStore
from backend.world.clock import Clock
from backend.world.simulator import SESSION_ATTEMPT_INTERVAL_SIM_SECONDS
from backend.world.transitions import transition
from backend.world.twin import Twin

# Session-relevant event types — for the scenarios where the symptom is in the transaction
# log rather than the connector state. What get_recent_transactions filters the store for.
_TRANSACTION_EVENT_TYPES = {
    "STATUS_NOTIFICATION", "START_TRANSACTION", "METER_VALUES",
    "SESSION_HANDSHAKE_FAILED", "CONNECTOR_STATUS_CHANGED",
}

# The healthy values `_apply_communication_fault_sets` (simulator.py) departs from — mirrors
# `data/worlds/locality_01.json`'s own ambient telemetry, the same role `AMBIENT_TEMP_C` plays
# for cooling. Restoring a communication fault has to put these back explicitly: unlike
# temperature, which relaxes toward ambient on its own every tick once cooling is HEALTHY,
# nothing in the tick loop ever recovers `handshake_success_rate`/`comm_latency_ms`/
# `communication_state` — a fault here is a one-shot "Set", not a per-tick rate.
HEALTHY_HANDSHAKE_SUCCESS_RATE = 1.0
HEALTHY_COMM_LATENCY_MS = 40


def _self_test(result: str, **readings: Any) -> dict[str, Any]:
    return {"result": result, **readings}


def _cooling_self_tests(component, station) -> dict[str, Any]:
    tach = {"HEALTHY": 2000, "DEGRADED": 410, "FAILED": 0}[component.health]
    in_spec = 1800 <= tach <= 2200
    temp_sensor_healthy = station.components["temp_sensor"].health == "HEALTHY"
    return {
        "fan_tachometer": _self_test(
            "PASS" if in_spec else "FAIL", reading_rpm=tach, expected_rpm="1800-2200",
        ),
        "coolant_flow": _self_test("PASS", reading_lpm=4.1, expected_lpm=">=3.5"),
        # Names the component this check exercises, not the fault: a real self-test says which
        # reference it compared against, and without that the agent could see a 6.8 °C
        # disagreement between the cooling loop's own probe and the station's primary sensor and
        # have no way to tell which of the two it implicates. Observed live: the agent read this
        # FAIL and tried to restart `cooling` — the subsystem it had tested — while the station's
        # temp_sensor was the thing that had failed. The no-root-cause rule still holds: the reading says two
        # sensors disagree; concluding which one is wrong is the agent's job.
        "thermal_sensor_ref": _self_test(
            "PASS" if temp_sensor_healthy else "FAIL",
            cross_checks_component="temp_sensor",
            reading_c=round(station.telemetry.temperature_c, 1),
            delta_vs_primary=0.2 if temp_sensor_healthy else 6.8,
            expected_delta="<=1.0",
        ),
    }


def _communication_self_tests(component, station) -> dict[str, Any]:
    rate = station.telemetry.handshake_success_rate
    latency = station.telemetry.comm_latency_ms
    return {
        "handshake_test": _self_test(
            "PASS" if rate >= 0.8 else "FAIL",
            reading_success_rate=rate, expected_success_rate=">=0.8",
        ),
        "latency_check": _self_test(
            "PASS" if latency <= 200 else "FAIL",
            reading_ms=latency, expected_ms="<=200",
        ),
        "controller_selftest": _self_test("PASS" if component.health == "HEALTHY" else "FAIL"),
    }


def _contactor_self_tests(component, station) -> dict[str, Any]:
    healthy = component.health == "HEALTHY"
    return {
        "contact_resistance": _self_test(
            "PASS" if healthy else "FAIL",
            reading_mohm=12 if healthy else 340, expected_mohm="<=50",
        ),
        "drop_test": _self_test(
            "PASS" if healthy else "FAIL",
            reading_drop_probability=0.0 if healthy else 0.7, expected_drop_probability="<=0.05",
        ),
    }


def _network_iface_self_tests(component, station) -> dict[str, Any]:
    """Link-level readings, deliberately disjoint from `_communication_self_tests`' controller
    readings: the two components share a telemetry footprint (both can strand a station's
    comms), so the only way to tell a dead link from a dead controller is to test each — which
    is the investigation, and is why neither test set names a cause."""
    health = component.health
    link_up = health != "FAILED"
    loss = {"HEALTHY": 0.0, "DEGRADED": 0.42, "FAILED": 1.0}[health]
    return {
        "link_state": _self_test("PASS" if link_up else "FAIL", reading_link="UP" if link_up else "DOWN"),
        "packet_loss": _self_test(
            "PASS" if loss <= 0.02 else "FAIL", reading_loss_fraction=loss, expected_loss_fraction="<=0.02",
        ),
        "uplink_latency": _self_test(
            "PASS" if station.telemetry.comm_latency_ms <= 200 else "FAIL",
            reading_ms=station.telemetry.comm_latency_ms, expected_ms="<=200",
        ),
    }


def _power_module_self_tests(component, station) -> dict[str, Any]:
    health = component.health
    voltage = {"HEALTHY": 398, "DEGRADED": 371, "FAILED": 0}[health]
    return {
        "dc_bus_voltage": _self_test(
            "PASS" if 360 <= voltage <= 420 else "FAIL", reading_v=voltage, expected_v="360-420",
        ),
        "output_stage_selftest": _self_test("PASS" if health == "HEALTHY" else "FAIL"),
        "deliverable_power": _self_test(
            "PASS" if health == "HEALTHY" else "FAIL",
            reading_kw=station.telemetry.power_kw, rated_kw=50.0,
        ),
    }


def _temp_sensor_self_tests(component, station) -> dict[str, Any]:
    health = component.health
    return {
        "controller_selftest": _self_test("PASS" if health == "HEALTHY" else "FAIL"),
        "reading_updates": _self_test(
            "PASS" if health == "HEALTHY" else "FAIL",
            reading_c=round(station.telemetry.temperature_c, 1),
            behaviour={"HEALTHY": "tracking", "DEGRADED": "lagging", "FAILED": "frozen"}[health],
        ),
    }


def _generic_self_tests(component, station) -> dict[str, Any]:
    return {
        "controller_selftest": _self_test(
            "PASS" if component.health == "HEALTHY" else "FAIL", reading_health=component.health,
        ),
    }


_SELF_TEST_BUILDERS: dict[str, Callable[[Any, Any], dict[str, Any]]] = {
    "cooling": _cooling_self_tests,
    "communication": _communication_self_tests,
    "contactor": _contactor_self_tests,
    "network_iface": _network_iface_self_tests,
    "power_module": _power_module_self_tests,
    "temp_sensor": _temp_sensor_self_tests,
}


class ToolExecutor:
    def __init__(self, twin: Twin, clock: Clock, on_event: Callable[..., None], event_store: EventStore) -> None:
        self.twin = twin
        self.clock = clock
        self.on_event = on_event
        self.event_store = event_store

    # ── OBSERVATION (free, no policy check, never mutates) ───────────────────────────────

    def get_station_state(self, station_id: str) -> dict[str, Any]:
        station = self.twin.stations[station_id]
        return {
            "station_id": station_id,
            "status": station.status,
            "connectors": {cid: {"status": c.status} for cid, c in station.connectors.items()},
            "communication_state": station.communication_state,
        }

    def get_connector_status(self, station_id: str, connector_id: str) -> dict[str, Any]:
        connector = self.twin.stations[station_id].connectors[connector_id]
        return {"station_id": station_id, "connector_id": connector_id, "status": connector.status}

    def get_telemetry(self, station_id: str) -> dict[str, Any]:
        t = self.twin.stations[station_id].telemetry
        return {
            "station_id": station_id,
            "temperature_c": t.temperature_c,
            "power_kw": t.power_kw,
            "cooling_effectiveness": t.cooling_effectiveness,
            "handshake_success_rate": t.handshake_success_rate,
            "comm_latency_ms": t.comm_latency_ms,
        }

    def get_component_state(self, station_id: str, component: str) -> dict[str, Any]:
        c = self.twin.stations[station_id].components[component]
        return {"station_id": station_id, "component": component, "health": c.health}

    def get_recent_events(self, target: str, limit: int = 10) -> list[dict[str, Any]]:
        events = self.event_store.for_source(target, limit=limit)
        return [
            {
                "event_id": e.event_id, "sim_time": e.sim_time, "type": e.type,
                "previous_state": e.previous_state, "new_state": e.new_state,
                "severity": e.severity, "metadata": e.metadata,
            }
            for e in events
        ]

    def get_recent_transactions(self, station_id: str, limit: int = 10) -> list[dict[str, Any]]:
        station = self.twin.stations[station_id]
        rows: list[dict[str, Any]] = []
        for connector_id in station.connectors:
            source = f"{station_id}/{connector_id}"
            rows.extend(
                {
                    "event_id": e.event_id, "sim_time": e.sim_time, "source": e.source,
                    "type": e.type, "new_state": e.new_state, "metadata": e.metadata,
                }
                for e in self.event_store.for_source(source)
                if e.type in _TRANSACTION_EVENT_TYPES
            )
        rows.sort(key=lambda r: r["sim_time"], reverse=True)
        return rows[:limit]

    # ── DIAGNOSTIC (advances sim time, light policy check, never mutates) ────────────────

    def run_diagnostic(self, station_id: str, subsystem: str) -> dict[str, Any]:
        station = self.twin.stations[station_id]
        component = station.components[subsystem]
        builder = _SELF_TEST_BUILDERS.get(subsystem, _generic_self_tests)
        self_tests = builder(component, station)
        failing = [name for name, t in self_tests.items() if t["result"] == "FAIL"]
        notes = (
            f"One or more {subsystem} checks did not meet specification."
            if failing else f"All {subsystem} checks within specification."
        )
        self.on_event(
            self.clock.now(), "DIAGNOSTIC_RUN", target=f"{station_id}.{subsystem}",
            failing_checks=failing,
        )
        return {"subsystem": subsystem, "sim_time": self.clock.now(), "self_tests": self_tests, "notes": notes}

    # ── ACTION (mutates, full policy check, costs sim time) ──────────────────────────────

    def reset_connector(self, station_id: str, connector_id: str) -> dict[str, Any]:
        station = self.twin.stations[station_id]
        connector = station.connectors[connector_id]
        source = f"{station_id}/{connector_id}"
        previous = connector.status
        connector.status = transition("connector", source, previous, "AVAILABLE")
        # A freshly reset connector is exactly as "just became available" as one that finished
        # a session — reschedule its next session attempt
        # from now, rather than leaving whatever stale `next_session_attempt_sim_time` it had
        # from before the fault, which would otherwise fire on literally the next tick and race
        # the verifier's settle window into a false "not AVAILABLE" reading.
        station.next_session_attempt_sim_time = self.clock.now() + SESSION_ATTEMPT_INTERVAL_SIM_SECONDS
        self.on_event(
            self.clock.now(), "CONNECTOR_STATUS_CHANGED", source=source,
            previous_state=previous, new_state="AVAILABLE", reason="RESET_CONNECTOR",
        )
        # `_trip_thermal_protection` (simulator.py) is the only writer of station.status =
        # FAULTED, and nothing ever wrote the reverse — every station in this world has exactly
        # one connector, so a connector-level reset back to AVAILABLE is exactly the
        # condition that made the station-level FAULTED stale. Without this, a resolved
        # incident still renders a permanently red station tile (the snapshot includes
        # station.status alongside connector status) — found live via the `/world` snapshot,
        # not by reading.
        if station.status == "FAULTED":
            station_previous = station.status
            station.status = transition("station", station_id, station_previous, "AVAILABLE")
            self.on_event(
                self.clock.now(), "STATION_STATUS_CHANGED", target=station_id,
                previous_state=station_previous, new_state="AVAILABLE", reason="RESET_CONNECTOR",
            )
        return {"station_id": station_id, "connector_id": connector_id, "status": connector.status}

    def restart_component(self, station_id: str, component: str) -> dict[str, Any]:
        station = self.twin.stations[station_id]
        comp = station.components[component]
        previous = comp.health
        # DEGRADED/FAILED -> HEALTHY only when the underlying fault is recoverable. A restart
        # on an unrecoverable fault is accepted and executes — it just does not restore health.
        if comp.recoverable:
            comp.health = transition("component", f"{station_id}.{component}", previous, "HEALTHY")
            self.on_event(
                self.clock.now(), "COMPONENT_HEALTH_CHANGED", target=f"{station_id}.{component}",
                previous_state=previous, new_state=comp.health,
            )
            # `_apply_communication_fault_sets` (simulator.py) is a one-shot "Set" applied at
            # fault time, not a per-tick rate — unlike cooling's temperature, which relaxes back
            # toward ambient on its own once health is HEALTHY, nothing ever reverses
            # `handshake_success_rate`/`comm_latency_ms`/`communication_state` on its own.
            # Without this, restarting a recoverable communication fault flips `health` back to
            # HEALTHY while the station stays permanently DISCONNECTED with a 0.0 handshake
            # rate — found live: an agent correctly restored the component, correctly re-checked
            # it, saw `communication_state: DISCONNECTED` unchanged, and (reasonably, given what
            # it was shown) concluded the fault must be physical and escalated a station that
            # had, in fact, already been fixed. `network_iface` carries the same one-shot Sets
            # (simulator.py's `_apply_network_iface_fault_sets`) and needs the identical
            # restoration — the link and the controller are different components with the same
            # telemetry footprint.
            if component in ("communication", "network_iface"):
                station.telemetry.handshake_success_rate = HEALTHY_HANDSHAKE_SUCCESS_RATE
                station.telemetry.comm_latency_ms = HEALTHY_COMM_LATENCY_MS
                if station.communication_state == "DISCONNECTED":
                    comm_previous = station.communication_state
                    station.communication_state = transition(
                        "communication", station_id, comm_previous, "CONNECTED",
                    )
                    self.on_event(
                        self.clock.now(), "COMMUNICATION_STATE_CHANGED", target=station_id,
                        previous_state=comm_previous, new_state="CONNECTED",
                    )
        return {
            "station_id": station_id, "component": component, "health": comp.health,
            "changed": comp.health != previous,
        }

    def set_connector_availability(self, station_id: str, connector_id: str, available: bool) -> dict[str, Any]:
        connector = self.twin.stations[station_id].connectors[connector_id]
        source = f"{station_id}/{connector_id}"
        previous = connector.status
        new_state = "AVAILABLE" if available else "UNAVAILABLE"
        connector.status = transition("connector", source, previous, new_state)
        self.on_event(
            self.clock.now(), "CONNECTOR_STATUS_CHANGED", source=source,
            previous_state=previous, new_state=new_state, reason="OPERATOR_ISOLATION",
        )
        if available:
            # Putting a connector back in service is the one signal that says the equipment is
            # trusted again — it is what lifts the station's maintenance hold (see
            # `_hold_station` below and `Station.maintenance_hold`).
            self.twin.stations[station_id].maintenance_hold = False
        return {"station_id": station_id, "connector_id": connector_id, "status": connector.status}

    # ── ESCALATION (mutates, full policy check, costs sim time, terminates the run) ──────

    def create_maintenance_ticket(self, target: str, summary: str, evidence: str) -> dict[str, Any]:
        self.on_event(
            self.clock.now(), "MAINTENANCE_TICKET_CREATED", target=target,
            summary=summary, evidence=evidence,
        )
        self._hold_station(target)
        return {"target": target, "ticket_created": True}

    def notify_operator(self, target: str, message: str) -> dict[str, Any]:
        self.on_event(self.clock.now(), "OPERATOR_NOTIFIED", target=target, message=message)
        self._hold_station(target)
        return {"target": target, "notified": True}

    def _hold_station(self, target: str) -> None:
        """A station with a ticket against it is handed to a human, and the world keeps running
        underneath it: an unrecoverable cooling fault goes on heating an already-isolated
        connector until it crosses TEMP_PROTECTION and raises a *second* incident for the
        problem that was just escalated. The hold is what stops admission control re-reporting
        equipment a human already owns (`pipeline/processor.py`) — found live, round 3."""
        station = self.twin.stations.get(target.partition("/")[0])
        if station is not None:
            station.maintenance_hold = True
