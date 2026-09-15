"""The simulator: the fake physical world.

    Given a state, a disturbance, and a tick, produce believable state transitions.

Tick loop order is fixed: apply due faults (the disturbance), apply component effects,
evaluate thresholds, advance sessions, emit events. Nothing mutates the twin outside a tick
except a policy-approved action, applied at the next tick boundary.

Fault injection is one path: `schedule_fault()` takes the same fault object the manual
injection UI and the scenario runner both submit through. It never
sets `station.status = FAULTED` directly — it sets a *component's* health and lets temperature,
thresholds and transitions carry the consequence forward, tick by tick, so the chain the agent
walks backwards during diagnosis is the same chain that produced the fault.
"""

from __future__ import annotations

import asyncio
import random
from dataclasses import dataclass
from typing import Any, Callable

from backend import config
from backend.world.clock import Clock
from backend.world.transitions import transition
from backend.world.twin import Twin

# ── Effect table rates ────────────────────────────────────────────────────────────────────
# Per-sim-minute *rates* are multiplied by config.severity_multiplier().
# Set-values and probabilities are taken from this table unmodified — severity never touches
# them, and never touches the ambient relax rate either.
COOLING_DEGRADED_RATE_C_PER_MIN = 0.8
COOLING_FAILED_RATE_C_PER_MIN = 2.5
COOLING_DEGRADED_EFFECTIVENESS = 0.4
COOLING_FAILED_EFFECTIVENESS = 0.0

COMM_DEGRADED_HANDSHAKE_RATE = 0.3
COMM_DEGRADED_LATENCY_MS = 1800
COMM_FAILED_HANDSHAKE_RATE = 0.0

CONTACTOR_DEGRADED_DROP_PROBABILITY = 0.7          # set-value, not scaled by severity
CONTACTOR_DEGRADED_DROP_AFTER_SIM_SECONDS = 20

# ── Effect rows the base table does not carry ─────────────────────────────────────────────
# The table above has no row for `network_iface` in either mode, none for `power_module
# FAILED`, and none for `temp_sensor DEGRADED` — but the fault-injection path, the form and the
# scenario runner all accept any (component, mode) pair, so those four combinations set a
# health flag and then produce no physical consequence whatsoever. Live testing caught exactly
# that: a `network_iface` FAILED injection opens a COMPONENT_FAILURE incident, the agent
# investigates correctly, finds every reading nominal, and has nothing it can act on — the
# fault is real in the twin and invisible in the world. These four rows extend the table in its
# own idiom (rates vs one-shot Sets) rather than changing any value it already specifies.
#
# `network_iface` is the physical link; `communication` is the controller that speaks over it.
# Both can strand a station's comms, and telling them apart is precisely the investigation the
# agent has to do: run_diagnostic(communication) reports handshake FAIL with controller_selftest
# PASS when the link is the culprit, and both FAIL when the controller is.
NETWORK_IFACE_DEGRADED_HANDSHAKE_RATE = 0.5
NETWORK_IFACE_DEGRADED_LATENCY_MS = 1800
NETWORK_IFACE_FAILED_HANDSHAKE_RATE = 0.0

# Hard thermal cutout. Not one of the three thresholds in config.py — a local protection
# limit, and deliberately reachable ONLY on a station already under a maintenance hold, i.e.
# one an escalation has isolated and handed to a human. That is the exact case it exists for:
# an unrecoverable cooling fault that has been correctly escalated goes on heating for as long
# as the process runs (242 °C observed live), because nothing else ever stops it. Gating on the
# hold rather than on the temperature alone means it can never fire underneath an agent that is
# still working the incident, however slowly — which a bare threshold could, since the effect
# table's worst case covers 78 -> 150 °C in about 19 sim-minutes.
TEMP_CUTOUT_C = 150.0

# `temp_sensor` DEGRADED under-reports: the reading moves at half the true rate, so a station
# with a concurrent cooling fault heats faster than its own telemetry admits. Alone it opens no
# incident (only a FAILED component does) — which is correct, and is why this row is the
# quietest of the four.
TEMP_SENSOR_DEGRADED_READING_FRACTION = 0.5

# A plausible rated DC fast-charger power for the power_module cap. None of the four shipped
# scenarios faults `power_module`, so nothing ever calibrated it against a scenario, and
# nothing needs to — it is a self-consistent world constant, not a placeholder.
RATED_POWER_KW = 50.0
POWER_DEGRADED_CAP_FRACTION = 0.4

# Session cadence. Every ~90 sim-seconds an idle connector attempts a session; the
# CHARGING/FINISHING dwell durations are a self-consistent implementation choice.
SESSION_ATTEMPT_INTERVAL_SIM_SECONDS = 90
CHARGING_DURATION_SIM_SECONDS = 40
FINISHING_DURATION_SIM_SECONDS = 15


@dataclass
class Fault:
    """The one fault-injection object. `target` is `"<station_id>.<component>"`,
    e.g. `"ST-02.cooling"`. Both the manual injection endpoint and the scenario runner build
    exactly this object and hand it to `Simulator.schedule_fault()` — one path."""

    fault_id: str
    target: str
    mode: str            # "DEGRADED" | "FAILED"
    severity: float
    delay_sim_seconds: float
    recoverable: bool
    scheduled_at_sim_time: float | None = None
    applied: bool = False


def _print_event(sim_time: float, event_type: str, **fields: Any) -> None:
    """The default stdout sink, used by the CLI demo. In the running system this callback is
    `event_bus.publish` — the simulator itself never imports pipeline/, so the seam is a
    constructor argument."""
    detail = " ".join(f"{k}={v}" for k, v in fields.items())
    print(f"[t={sim_time:8.1f}s] {event_type} {detail}".rstrip())


class Simulator:
    def __init__(
        self,
        twin: Twin,
        clock: Clock,
        *,
        rng: random.Random | None = None,
        on_event: Callable[..., None] | None = None,
    ) -> None:
        self.twin = twin
        self.clock = clock
        self.rng = rng or random.Random()
        self._on_event = on_event or _print_event
        self._pending_faults: list[Fault] = []

    # ── fault injection: the one path ────────────────────────────────────────────────────

    def schedule_fault(self, fault: Fault) -> None:
        fault.scheduled_at_sim_time = self.clock.now() + fault.delay_sim_seconds
        self._pending_faults.append(fault)
        self._on_event(
            self.clock.now(), "FAULT_SCHEDULED",
            fault_id=fault.fault_id, target=fault.target, mode=fault.mode,
            fires_at=fault.scheduled_at_sim_time,
        )

    def faults(self) -> list[Fault]:
        """Every fault this world has been given, scheduled or already applied — the injection
        panel's own record. Read-only; the list itself is the simulator's."""
        return list(self._pending_faults)

    def _apply_due_faults(self) -> None:
        now = self.clock.now()
        for fault in self._pending_faults:
            if fault.applied or now < fault.scheduled_at_sim_time:
                continue
            self._apply_fault(fault)
            fault.applied = True

    def _apply_fault(self, fault: Fault) -> None:
        station_id, _, component_name = fault.target.partition(".")
        station = self.twin.stations[station_id]
        component = station.components[component_name]

        previous = component.health
        component.health = transition("component", fault.target, previous, fault.mode)
        component.recoverable = fault.recoverable
        component.severity = fault.severity
        self._on_event(
            self.clock.now(), "COMPONENT_HEALTH_CHANGED",
            target=fault.target, previous_state=previous, new_state=fault.mode,
            severity=fault.severity, recoverable=fault.recoverable,
        )

        if component_name == "communication":
            self._apply_communication_fault_sets(station, fault.mode)
        elif component_name == "network_iface":
            self._apply_network_iface_fault_sets(station, fault.mode)
        elif component_name == "power_module" and fault.mode == "FAILED":
            self._trip_power_stage(station_id, station)

    def _apply_communication_fault_sets(self, station, mode: str) -> None:
        if mode == "DEGRADED":
            station.telemetry.handshake_success_rate = COMM_DEGRADED_HANDSHAKE_RATE
            station.telemetry.comm_latency_ms = COMM_DEGRADED_LATENCY_MS
        elif mode == "FAILED":
            station.telemetry.handshake_success_rate = COMM_FAILED_HANDSHAKE_RATE
            previous = station.communication_state
            station.communication_state = transition(
                "communication", station.station_id, previous, "DISCONNECTED"
            )
            self._on_event(
                self.clock.now(), "COMMUNICATION_STATE_CHANGED",
                target=station.station_id, previous_state=previous, new_state="DISCONNECTED",
            )

    def _apply_network_iface_fault_sets(self, station, mode: str) -> None:
        """The link, not the controller. DEGRADED halves the handshake rate and inflates
        latency; FAILED takes the station off the network outright — the same
        `COMMUNICATION_STATE_CHANGED` the controller's own failure emits, which is what makes
        the two indistinguishable from the station state alone and distinguishable from a
        component-level reading (see the effect-row note above)."""
        if mode == "DEGRADED":
            station.telemetry.handshake_success_rate = NETWORK_IFACE_DEGRADED_HANDSHAKE_RATE
            station.telemetry.comm_latency_ms = NETWORK_IFACE_DEGRADED_LATENCY_MS
        elif mode == "FAILED":
            station.telemetry.handshake_success_rate = NETWORK_IFACE_FAILED_HANDSHAKE_RATE
            if station.communication_state != "DISCONNECTED":
                previous = station.communication_state
                station.communication_state = transition(
                    "communication", station.station_id, previous, "DISCONNECTED"
                )
                self._on_event(
                    self.clock.now(), "COMMUNICATION_STATE_CHANGED",
                    target=station.station_id, previous_state=previous, new_state="DISCONNECTED",
                )

    def _trip_power_stage(self, station_id: str, station) -> None:
        """`power_module` FAILED: a charger that loses its power stage mid-session trips the
        connector. An idle connector is not faulted — it simply can never leave PREPARING again
        (see `_advance_one_session`), which is the observable symptom for a station that was
        idle when the module died."""
        for connector_id, connector in station.connectors.items():
            if connector.status != "CHARGING":
                continue
            source = f"{station_id}/{connector_id}"
            previous = connector.status
            connector.status = transition("connector", source, previous, "FAULTED")
            self._on_event(
                self.clock.now(), "CONNECTOR_STATUS_CHANGED", source=source,
                previous_state=previous, new_state="FAULTED", reason="POWER_MODULE_FAILURE",
            )

    # ── the tick loop ─────────────────────────────────────────────────────────────────────

    def tick(self) -> float:
        now = self.clock.tick()
        self._apply_due_faults()
        self._apply_component_effects(config.TICK_SIM_SECONDS)
        self._evaluate_thresholds()
        self._advance_sessions()
        self._apply_power_draw()
        return now

    # ── component effects ────────────────────────────────────────────────────────────────

    def _apply_component_effects(self, dt_sim_seconds: float) -> None:
        dt_min = dt_sim_seconds / 60.0
        for station in self.twin.stations.values():
            self._apply_cooling(station, dt_min)
            # communication / contactor / temp_sensor "Sets" are one-shot, applied at
            # fault time (_apply_fault) or read directly by the session loop; nothing recurs
            # here for those three every tick.

    def _apply_cooling(self, station, dt_min: float) -> None:
        cooling = station.components["cooling"]
        # temp_sensor FAILED freezes the reading -- skip the update entirely so
        # telemetry.temperature_c (the only reading anything else in the system can see)
        # stays exactly at its last value.
        if station.components["temp_sensor"].health == "FAILED":
            return

        # A de-energised station has no heat source. Once the thermal cutout has tripped the
        # unit OFFLINE (below) nothing is being delivered through it, so the temperature decays
        # toward ambient at the normal relax rate even though the cooling component is still
        # broken — `cooling_effectiveness` keeps reporting the component's real state, because
        # the component has not been repaired; it just no longer has anything to cool.
        if station.status == "OFFLINE":
            station.telemetry.cooling_effectiveness = (
                COOLING_FAILED_EFFECTIVENESS if cooling.health == "FAILED"
                else COOLING_DEGRADED_EFFECTIVENESS if cooling.health == "DEGRADED"
                else 1.0
            )
            relaxed = station.telemetry.temperature_c + config.AMBIENT_RELAX_C_PER_SIM_MIN * dt_min
            station.telemetry.temperature_c = max(config.AMBIENT_TEMP_C, relaxed)
            return

        # A DEGRADED temp_sensor under-reports: every movement of the reading, in either
        # direction, is halved (the FAILED case above freezes it outright).
        reading_fraction = (
            TEMP_SENSOR_DEGRADED_READING_FRACTION
            if station.components["temp_sensor"].health == "DEGRADED" else 1.0
        )

        if cooling.health == "DEGRADED":
            rate = COOLING_DEGRADED_RATE_C_PER_MIN * config.severity_multiplier(cooling.severity)
            station.telemetry.cooling_effectiveness = COOLING_DEGRADED_EFFECTIVENESS
            station.telemetry.temperature_c += rate * dt_min * reading_fraction
        elif cooling.health == "FAILED":
            rate = COOLING_FAILED_RATE_C_PER_MIN * config.severity_multiplier(cooling.severity)
            station.telemetry.cooling_effectiveness = COOLING_FAILED_EFFECTIVENESS
            station.telemetry.temperature_c += rate * dt_min * reading_fraction
        else:
            station.telemetry.cooling_effectiveness = 1.0
            relaxed = station.telemetry.temperature_c + (
                config.AMBIENT_RELAX_C_PER_SIM_MIN * dt_min * reading_fraction
            )
            station.telemetry.temperature_c = max(config.AMBIENT_TEMP_C, relaxed)

    def _apply_power_draw(self) -> None:
        """`power_kw` is a *derived* reading: a station delivering into a CHARGING connector
        draws rated power, an idle one draws nothing, and the `power_module` DEGRADED row
        caps what it can deliver at 40% of rated. Nothing previously wrote this field at all,
        so it read 0.0 for every station in every state — which made both the cap row and a
        failed power stage completely invisible to telemetry. Computed after the session loop,
        so it always describes the connector states this tick actually ended in."""
        for station in self.twin.stations.values():
            charging = any(c.status == "CHARGING" for c in station.connectors.values())
            health = station.components["power_module"].health
            if not charging or health == "FAILED":
                station.telemetry.power_kw = 0.0
            elif health == "DEGRADED":
                station.telemetry.power_kw = RATED_POWER_KW * POWER_DEGRADED_CAP_FRACTION
            else:
                station.telemetry.power_kw = RATED_POWER_KW

    # ── thresholds — edge-triggered, not level-triggered ─────────────────────────────────

    def _evaluate_thresholds(self) -> None:
        for station_id, station in self.twin.stations.items():
            temp = station.telemetry.temperature_c
            edge = station.thermal_edge_state

            if temp >= TEMP_CUTOUT_C and station.maintenance_hold and station.status != "OFFLINE":
                self._trip_thermal_cutout(station_id, station, temperature_c=round(temp, 2))
            elif temp >= config.TEMP_PROTECTION and edge != "PROTECTION":
                station.thermal_edge_state = "PROTECTION"
                self._trip_thermal_protection(station_id, station, temperature_c=round(temp, 2))
            elif temp >= config.TEMP_WARNING and edge == "NORMAL":
                station.thermal_edge_state = "WARNING"
                self._on_event(
                    self.clock.now(), "THERMAL_WARNING",
                    target=station_id, temperature_c=round(temp, 2),
                )
            elif temp < config.TEMP_WARNING and edge != "NORMAL":
                station.thermal_edge_state = "NORMAL"  # re-arm for the next crossing

    def _trip_thermal_cutout(self, station_id: str, station, *, temperature_c: float) -> None:
        """The unit takes itself out of service entirely. The transition table reaches OFFLINE from every
        other station state, and `POST /stations/{id}/return-to-service` reaches AVAILABLE back
        out of it, so this is a recoverable end state and not a trap."""
        previous = station.status
        station.status = transition("station", station_id, previous, "OFFLINE")
        self._on_event(
            self.clock.now(), "STATION_STATUS_CHANGED", target=station_id,
            previous_state=previous, new_state="OFFLINE", reason="THERMAL_CUTOUT",
            temperature_c=temperature_c,
        )

    def _trip_thermal_protection(self, station_id: str, station, *, temperature_c: float) -> None:
        for connector_id, connector in station.connectors.items():
            if connector.status == "FAULTED":
                continue
            if connector.status == "UNAVAILABLE" and station.maintenance_hold:
                # Already out of service, with an engineer dispatched: faulting it again adds a
                # state change nobody can act on, and leaves the connector in a state the
                # operator's own return-to-service path cannot lift (the table reaches
                # AVAILABLE from FAULTED only through reset_connector plus verification).
                continue
            source = f"{station_id}/{connector_id}"
            previous = connector.status
            connector.status = transition("connector", source, previous, "FAULTED")
            self._on_event(
                self.clock.now(), "CONNECTOR_STATUS_CHANGED",
                source=source, previous_state=previous, new_state="FAULTED",
                reason="THERMAL_PROTECTION", temperature_c=temperature_c,
            )
        if station.status not in ("FAULTED", "OFFLINE"):
            previous = station.status
            station.status = transition("station", station_id, previous, "FAULTED")
            self._on_event(
                self.clock.now(), "STATION_STATUS_CHANGED",
                target=station_id, previous_state=previous, new_state="FAULTED",
                reason="THERMAL_PROTECTION",
            )

    # ── sessions — the world stays alive, so faults are symptomatic, not declared ────────

    def _advance_sessions(self) -> None:
        now = self.clock.now()
        for station_id, station in self.twin.stations.items():
            contactor_health = station.components["contactor"].health
            for connector_id, connector in station.connectors.items():
                self._advance_one_session(station_id, station, connector_id, connector, contactor_health, now)

    def _advance_one_session(self, station_id, station, connector_id, connector, contactor_health, now) -> None:
        source = f"{station_id}/{connector_id}"

        if connector.status == "AVAILABLE":
            if station.status == "OFFLINE":
                return   # de-energised: no session can start here until it is brought back
            if station.maintenance_hold:
                # The station has been escalated to a human and its equipment is isolated, so it
                # must stop taking vehicles. An escalation can only isolate a connector that is
                # idle or faulted — a session already loading a vehicle has no legal transition
                # to UNAVAILABLE and is deliberately not interrupted — so a
                # station that was mid-session when it was escalated went right on charging
                # afterwards, which is what the human saw: "it states that it is at hold, but the
                # station is still charging." This is where that session ends: the connector is
                # taken out of service the moment it comes back round to idle.
                connector.status = transition("connector", source, "AVAILABLE", "UNAVAILABLE")
                self._on_event(
                    now, "CONNECTOR_STATUS_CHANGED", source=source, previous_state="AVAILABLE",
                    new_state="UNAVAILABLE", reason="MAINTENANCE_HOLD",
                )
                if station.status == "AVAILABLE":
                    previous = station.status
                    station.status = transition("station", station_id, previous, "UNAVAILABLE")
                    self._on_event(
                        now, "STATION_STATUS_CHANGED", target=station_id,
                        previous_state=previous, new_state="UNAVAILABLE", reason="MAINTENANCE_HOLD",
                    )
                return
            if now >= station.next_session_attempt_sim_time:
                connector.status = transition("connector", source, "AVAILABLE", "PREPARING")
                connector.session_state_entered_sim_time = now
                self._on_event(now, "STATUS_NOTIFICATION", source=source, new_state="PREPARING")

        elif connector.status == "PREPARING":
            if contactor_health == "FAILED":
                return  # "connector cannot leave PREPARING" -- stays stuck
            if station.components["power_module"].health == "FAILED":
                return  # no power stage to energise the session -- stuck the same way
            if self.rng.random() < station.telemetry.handshake_success_rate:
                connector.status = transition("connector", source, "PREPARING", "CHARGING")
                connector.session_state_entered_sim_time = now
                self._on_event(now, "START_TRANSACTION", source=source)
            else:
                connector.status = transition("connector", source, "PREPARING", "AVAILABLE")
                station.next_session_attempt_sim_time = now + SESSION_ATTEMPT_INTERVAL_SIM_SECONDS
                self._on_event(now, "SESSION_HANDSHAKE_FAILED", source=source)

        elif connector.status == "CHARGING":
            dwell = now - connector.session_state_entered_sim_time
            if (
                contactor_health == "DEGRADED"
                and dwell >= CONTACTOR_DEGRADED_DROP_AFTER_SIM_SECONDS
                and self.rng.random() < CONTACTOR_DEGRADED_DROP_PROBABILITY
            ):
                connector.status = transition("connector", source, "CHARGING", "FAULTED")
                self._on_event(
                    now, "CONNECTOR_STATUS_CHANGED",
                    source=source, previous_state="CHARGING", new_state="FAULTED",
                    reason="SESSION_DROPPED",
                )
                return
            if dwell >= CHARGING_DURATION_SIM_SECONDS:
                connector.status = transition("connector", source, "CHARGING", "FINISHING")
                connector.session_state_entered_sim_time = now
                self._on_event(now, "METER_VALUES", source=source, session_complete=True)

        elif connector.status == "FINISHING":
            dwell = now - connector.session_state_entered_sim_time
            if dwell >= FINISHING_DURATION_SIM_SECONDS:
                connector.status = transition("connector", source, "FINISHING", "AVAILABLE")
                station.next_session_attempt_sim_time = now + SESSION_ATTEMPT_INTERVAL_SIM_SECONDS
                self._on_event(now, "STATUS_NOTIFICATION", source=source, new_state="AVAILABLE")


async def run_background_clock(sim: Simulator, *, interval_real: float = config.TICK_INTERVAL_REAL) -> None:
    """The Clock, run as its own asyncio task: the world advances in real wall-clock time
    regardless of what else the event loop is doing (the API lifespan hook runs exactly this at
    startup). The agent harness needs the same mechanism — a ~920-sim-second cooling recovery
    has to fit inside a ~2.5-minute demo, which can only come from the world moving forward
    while the agent is thinking, not from tool-call durations alone. Cancel the task this
    returns once the run that needs it is done — it never exits on its own.

    Single-event-loop, no locks: `sim.tick()` is a
    plain synchronous call with no `await` inside it, so it can never interleave with another
    twin mutation mid-tick — cooperative scheduling only ever hands control back at this
    function's own `await asyncio.sleep()`.
    """
    while True:
        await asyncio.sleep(interval_real)
        sim.tick()
