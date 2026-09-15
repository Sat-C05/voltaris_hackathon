"""The scripted stub agent, end to end — run by hand:

    uv run python -m backend.agent.demo

CLI only, same pattern as `world/demo.py` and `pipeline/demo.py`. Injects a cooling DEGRADED
fault on ST-02, waits for the incident to open, then runs the scripted stub agent (no LLM)
through: observe, observe, diagnose, a deliberate rejected `reset_connector` while still hot,
`restart_component`, wait for the temperature to actually fall, a real `reset_connector`,
settle, and propose_resolution. Prints the tool log, then the evaluation.
"""

from __future__ import annotations

from backend import config
from backend.agent.capabilities import assert_no_drift, load_capabilities
from backend.agent.evaluation import print_evaluation
from backend.agent.stub_agent import run_cooling_stub_agent
from backend.pipeline.wiring import build_pipeline
from backend.world.clock import Clock
from backend.world.simulator import Simulator
from backend.world.twin import Twin


def main() -> None:
    capabilities = load_capabilities()
    assert_no_drift(capabilities)

    twin = Twin.load(config.WORLDS_DIR / "locality_01.json")
    clock = Clock()
    pipeline = build_pipeline(":memory:")
    sim = Simulator(twin, clock, on_event=pipeline.on_event)

    result = run_cooling_stub_agent(
        twin=twin, clock=clock, sim=sim, pipeline=pipeline, capabilities=capabilities,
    )

    for entry in result.tool_log:
        if entry["rejected"]:
            print(f"[t={entry['sim_time']:8.1f}s] REJECTED {entry['tool']}({entry['args']}) -> {entry['reason']}: {entry['message']}")
        else:
            print(f"[t={entry['sim_time']:8.1f}s] {entry['tool']}({entry['args']}) -> {entry['result']}")

    print_evaluation(
        result.incident, result.counters,
        opened_sim_time=result.incident.opened_sim_time, closed_sim_time=clock.now(),
        reference_action_count=2,
    )

    assert result.incident.status == "RESOLVED", f"check FAILED: incident ended {result.incident.status}"
    assert result.counters.policy_rejections >= 1, "check FAILED: no deliberate rejection observed"
    print("EXIT TEST PASSED: stub agent drove the incident to RESOLVED with a real policy rejection")


if __name__ == "__main__":
    main()
