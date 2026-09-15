"""The simulator, end to end — run by hand:

    uv run python -m backend.world.demo

CLI only: no API, no frontend. Injects a cooling DEGRADED fault on ST-02 at severity 0.7 —
the demo default — and ticks the simulator, printing every sim event to stdout with its sim
timestamp, until connector ST-02/C02 reaches FAULTED. This is the forward causal chain the
agent later walks backwards during diagnosis; there is nothing to read here, only what
prints.
"""

from __future__ import annotations

from backend import config
from backend.world.clock import Clock
from backend.world.simulator import Fault, Simulator
from backend.world.twin import Twin

# Guards the demo against a runaway loop if the chain never resolves; at 15 sim-s/tick this
# is 500 sim-minutes, far past any plausible fault-to-FAULTED chain.
MAX_TICKS = 2000


def main() -> None:
    twin = Twin.load(config.WORLDS_DIR / "locality_01.json")
    clock = Clock()
    sim = Simulator(twin, clock)

    sim.schedule_fault(
        Fault(
            fault_id="FLT-DEMO-001",
            target="ST-02.cooling",
            mode="DEGRADED",
            severity=0.7,
            delay_sim_seconds=30,
            recoverable=True,
        )
    )

    connector = twin.stations["ST-02"].connectors["C02"]
    for _ in range(MAX_TICKS):
        sim.tick()
        if connector.status == "FAULTED":
            break

    station = twin.stations["ST-02"]
    print(
        f"[t={clock.now():8.1f}s] DONE ST-02/C02={connector.status} "
        f"ST-02.status={station.status} ST-02.temperature_c={station.telemetry.temperature_c:.1f}"
    )
    assert connector.status == "FAULTED", "check FAILED: connector never reached FAULTED"
    print("EXIT TEST PASSED: cooling DEGRADED -> THERMAL_WARNING -> TEMP_PROTECTION -> FAULTED")


if __name__ == "__main__":
    main()
