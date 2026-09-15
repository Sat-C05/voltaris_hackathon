"""The digital twin: mutable live state loaded from `data/worlds/locality_01.json`.

Mutated only inside a tick, by the simulator, or by a policy-approved action applied at the
next tick boundary. Nothing else writes to it.

**Connector ids are per-station: `ST-02 -> C02`.** That keeps an incident key like `ST-02/C02`
unambiguous across the whole world, so `locality_01.json` is written to the C01..C04 rule
rather than giving every station a uniform `C01`.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

COMPONENT_NAMES = (
    "cooling", "communication", "power_module", "contactor", "temp_sensor", "network_iface",
)


@dataclass
class Telemetry:
    temperature_c: float
    power_kw: float
    cooling_effectiveness: float
    handshake_success_rate: float
    comm_latency_ms: float


@dataclass
class Component:
    health: str = "HEALTHY"
    # Whether the fault currently affecting this component is recoverable via
    # restart_component. Meaningless while HEALTHY.
    recoverable: bool = True
    # The severity of the fault currently affecting this component. Meaningless
    # while HEALTHY; read each tick by rate-based effects (cooling) via severity_multiplier().
    severity: float = 0.5


@dataclass
class Connector:
    connector_id: str
    status: str = "AVAILABLE"
    # sim_time the connector entered its current status; used by the session loop to time
    # PREPARING/CHARGING/FINISHING dwell. Not part of any external schema.
    session_state_entered_sim_time: float = 0.0


@dataclass
class Station:
    station_id: str
    status: str
    connectors: dict[str, Connector]
    components: dict[str, Component]
    communication_state: str
    telemetry: Telemetry
    active_session: dict[str, Any] | None = None
    next_session_attempt_sim_time: float = 90.0
    # Edge-trigger bookkeeping for threshold crossings (NORMAL | WARNING | PROTECTION).
    # Internal only — not part of the snapshot shape.
    thermal_edge_state: str = "NORMAL"
    # True once this station has been escalated to a human: a ticket exists and the equipment
    # is isolated, so the event processor's admission control stops opening further incidents
    # against it. Without it, an unrecoverable fault that was correctly escalated keeps
    # driving the world — an isolated connector still crosses TEMP_PROTECTION — and opens a
    # second incident for a problem an engineer is already on their way to. Cleared by
    # returning a connector to service, or by a world reset. IS in the snapshot: an operator
    # has to see that a station is held.
    maintenance_hold: bool = False


@dataclass
class Gateway:
    gateway_id: str
    status: str = "AVAILABLE"


@dataclass
class Relationship:
    from_id: str
    to_id: str
    type: str


class Twin:
    """The live world. One instance, replaced wholesale at world reset; nothing but the
    simulator and policy-approved actions mutate it."""

    def __init__(
        self,
        world_id: str,
        stations: dict[str, Station],
        gateway: dict[str, Gateway],
        relationships: list[Relationship],
    ) -> None:
        self.world_id = world_id
        self.stations = stations
        self.gateway = gateway
        self.relationships = relationships

    @classmethod
    def load(cls, path: Path) -> "Twin":
        raw = json.loads(path.read_text())

        stations: dict[str, Station] = {}
        for station_id, s in raw["stations"].items():
            connectors = {
                cid: Connector(connector_id=cid, status=c["status"])
                for cid, c in s["connectors"].items()
            }
            components = {
                name: Component(health=c["health"]) for name, c in s["components"].items()
            }
            stations[station_id] = Station(
                station_id=station_id,
                status=s["status"],
                connectors=connectors,
                components=components,
                communication_state=s.get("communication_state", "CONNECTED"),
                telemetry=Telemetry(**s["telemetry"]),
            )

        gateway = {
            gid: Gateway(gateway_id=gid, status=g["status"])
            for gid, g in raw.get("gateway", {}).items()
        }
        relationships = [
            Relationship(from_id=r["from"], to_id=r["to"], type=r["type"])
            for r in raw.get("relationships", [])
        ]
        return cls(world_id=raw["world_id"], stations=stations, gateway=gateway, relationships=relationships)

    # -- dotted-path property resolution -----------------------------------------------------
    # Used by the policy validator's preconditions and safety constraints, and by the verifier.
    # It lives here because it reads the twin's own shape.

    def resolve(self, target_id: str, property_path: str) -> Any:
        """Resolve a policy `property` path against live state.

        `target_id` is `"ST-02"` (station-rooted) or `"ST-02/C02"` (connector-rooted).
        `property_path` is rooted at that target (`"status"`, `"health"`) unless it starts
        with `"station."`, which is always absolute from the station regardless of target
        (`"station.telemetry.temperature_c"` from a connector target).
        """
        station_id, _, connector_id = target_id.partition("/")
        station = self.stations[station_id]
        root: Any = station.connectors[connector_id] if connector_id else station

        parts = property_path.split(".")
        if parts[0] == "station":
            obj: Any = station
            parts = parts[1:]
        else:
            obj = root

        for part in parts:
            obj = obj[part] if isinstance(obj, dict) else getattr(obj, part)
        return obj
