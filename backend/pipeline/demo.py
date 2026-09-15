"""The event pipeline, end to end — run by hand:

    uv run python -m backend.pipeline.demo

CLI only, same pattern as `world/demo.py`. Injects a cooling DEGRADED fault on ST-02, ticks the
simulator through its whole causal chain to FAULTED, then injects a second, independent
cooling DEGRADED fault on ST-03 and ticks that through too. Asserts: N events land in the
store; the ST-02 chain opens EXACTLY ONE incident despite emitting a THERMAL_WARNING, a
CONNECTOR_STATUS_CHANGED and a STATION_STATUS_CHANGED; the ST-03 fault opens a second, separate
incident. That "exactly one" assertion is the point of the whole module.
"""

from __future__ import annotations

from backend import config
from backend.pipeline.wiring import build_pipeline
from backend.world.clock import Clock
from backend.world.simulator import Fault, Simulator
from backend.world.twin import Twin

MAX_TICKS = 2000


def _run_cooling_fault(twin: Twin, clock: Clock, sim: Simulator, station_id: str, connector_id: str, fault_id: str) -> None:
    connector = twin.stations[station_id].connectors[connector_id]
    sim.schedule_fault(
        Fault(
            fault_id=fault_id,
            target=f"{station_id}.cooling",
            mode="DEGRADED",
            severity=0.7,
            delay_sim_seconds=30,
            recoverable=True,
        )
    )
    for _ in range(MAX_TICKS):
        sim.tick()
        if connector.status == "FAULTED":
            break
    assert connector.status == "FAULTED", f"check FAILED: {station_id}/{connector_id} never reached FAULTED"
    print(f"[t={clock.now():8.1f}s] {station_id}/{connector_id}=FAULTED")


def main() -> None:
    twin = Twin.load(config.WORLDS_DIR / "locality_01.json")
    clock = Clock()
    pipeline = build_pipeline(":memory:")
    sim = Simulator(twin, clock, on_event=pipeline.on_event)

    _run_cooling_fault(twin, clock, sim, "ST-02", "C02", "FLT-DEMO-001")
    events_after_first = pipeline.event_store.all()
    incidents_after_first = pipeline.incident_store.all()

    print(f"events in store after ST-02 fault: {len(events_after_first)}")
    print(f"incidents after ST-02 fault: {[(i.incident_id, i.target, i.type) for i in incidents_after_first]}")
    assert len(incidents_after_first) == 1, (
        f"check FAILED: expected exactly one incident, got {len(incidents_after_first)}"
    )
    inc = incidents_after_first[0]
    assert inc.target == "ST-02/C02" and inc.type == "CHARGER_FAULT"
    assert len(inc.trigger_events) >= 1

    _run_cooling_fault(twin, clock, sim, "ST-03", "C03", "FLT-DEMO-002")
    incidents_after_second = pipeline.incident_store.all()
    print(f"incidents after ST-03 fault: {[(i.incident_id, i.target, i.type) for i in incidents_after_second]}")
    assert len(incidents_after_second) == 2, (
        f"check FAILED: expected two separate incidents, got {len(incidents_after_second)}"
    )

    print(f"total events in store: {len(pipeline.event_store.all())}")
    print("EXIT TEST PASSED: one incident per fault, a second station opens a second incident")


if __name__ == "__main__":
    main()
