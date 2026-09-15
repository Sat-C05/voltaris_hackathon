"""The real agent, end to end — run by hand:

    uv run python -m backend.agent.llm_demo

Runs the real `gemma4:e4b` agent (no script, no stub) through the harness twice:

  Demo 1 — a recoverable cooling fault. Expected: investigate, restart cooling, wait, reset
           the connector, propose_resolution -> Verifier passes -> RESOLVED.
  Demo 2 — the same fault with `recoverable: false`. Expected: the agent
           restarts cooling, observes the tach reading is unchanged, concludes the fault is
           physical, and isolates + escalates -> ESCALATED (a success outcome, not a failure).

CLI only, same pattern as `agent/demo.py`. Prints the tool log and evaluation for each.
"""

from __future__ import annotations

import asyncio
import contextlib
import random

from backend import config
from backend.agent.capabilities import assert_no_drift, load_capabilities
from backend.agent.context import (
    build_incident_context,
    build_system_prompt,
    render_capabilities_for_prompt,
    render_success_criteria,
    render_tools_schema,
)
from backend.agent.evaluation import print_evaluation
from backend.agent.harness import AgentHarness
from backend.agent.llm_client import LLMClient
from backend.agent.policy import PolicyValidator
from backend.agent.tools import ToolExecutor
from backend.agent.verifier import Verifier
from backend.pipeline.wiring import build_pipeline
from backend.world.clock import Clock
from backend.world.simulator import Fault, Simulator, run_background_clock
from backend.world.twin import Twin

STATION_ID, CONNECTOR_ID = "ST-02", "C02"
SOURCE = f"{STATION_ID}/{CONNECTOR_ID}"
MAX_FAULT_TICKS = 2000

# "Back in service", not "idle at this instant": the world keeps running sessions during the
# verifier's settle window, so a connector that recovered can legitimately be PREPARING or
# CHARGING by the time the verifier looks at it — a strictly better state than AVAILABLE that
# an `equals AVAILABLE` goal would score as a verification failure. The scenario files'
# `success_criteria` carry this same set.
IN_SERVICE = ["AVAILABLE", "PREPARING", "CHARGING", "FINISHING"]
GOALS = [{"target": SOURCE, "property": "status", "op": "in", "value": IN_SERVICE}]
CONSTRAINTS = [
    {"target": STATION_ID, "property": "telemetry.temperature_c", "op": "<", "value": config.TEMP_SAFE},
    {"target": STATION_ID, "property": "components.cooling.health", "op": "equals", "value": "HEALTHY"},
]


def _print_tool_log(tool_log: list[dict]) -> None:
    for entry in tool_log:
        prefix = f"[t={entry['sim_time']:8.1f}s]"
        forced = " (forced)" if entry.get("forced") else ""
        if entry["rejected"]:
            print(f"{prefix} REJECTED{forced} {entry['tool']}({entry['args']}) -> {entry['reason']}: {entry['message']}")
        else:
            print(f"{prefix} {entry['tool']}({entry['args']}){forced} -> {entry['result']}")


async def _run_demo(*, label: str, recoverable: bool, seed: int) -> None:
    print("=" * 60)
    print(label)
    print("=" * 60)

    capabilities = load_capabilities()
    assert_no_drift(capabilities)

    twin = Twin.load(config.WORLDS_DIR / "locality_01.json")
    clock = Clock()
    pipeline = build_pipeline(":memory:")
    sim = Simulator(twin, clock, rng=random.Random(seed), on_event=pipeline.on_event)

    connector = twin.stations[STATION_ID].connectors[CONNECTOR_ID]
    sim.schedule_fault(Fault(
        fault_id=f"FLT-LLM-{seed}", target=f"{STATION_ID}.cooling", mode="DEGRADED",
        severity=0.7, delay_sim_seconds=30, recoverable=recoverable,
    ))
    for _ in range(MAX_FAULT_TICKS):
        sim.tick()
        if connector.status == "FAULTED":
            break
    if connector.status != "FAULTED":
        raise RuntimeError("demo setup failed: connector never reached FAULTED")

    incident = pipeline.incidents.find_open(SOURCE, "CHARGER_FAULT")
    if incident is None:
        raise RuntimeError(f"demo setup failed: no open CHARGER_FAULT incident for {SOURCE}")
    pipeline.incidents.advance(incident, "INVESTIGATING", sim.clock.now())

    incident_context = build_incident_context(incident=incident, twin=twin, event_store=pipeline.event_store)
    system_prompt = build_system_prompt(
        incident_context=incident_context,
        capabilities_text=render_capabilities_for_prompt(capabilities),
        success_criteria_text=render_success_criteria(goals=GOALS, constraints=CONSTRAINTS),
        max_steps=config.MAX_STEPS, max_actions=config.MAX_ACTIONS,
    )
    tools_schema = render_tools_schema(capabilities)

    harness = AgentHarness(
        sim=sim,
        tools=ToolExecutor(twin, clock, pipeline.on_event, pipeline.event_store),
        policy=PolicyValidator(twin, capabilities),
        verifier=Verifier(twin, pipeline.event_store),
        incidents=pipeline.incidents,
        llm=LLMClient(),
        capabilities=capabilities,
    )

    # The world must keep moving in real wall-clock time while the agent thinks — the API's
    # lifespan hook runs this same task at startup; this CLI demo starts and stops one per run.
    clock_task = asyncio.create_task(run_background_clock(sim))
    try:
        result = await harness.run(
            incident=incident, system_prompt=system_prompt, tools_schema=tools_schema,
            goals=GOALS, constraints=CONSTRAINTS,
        )
    finally:
        clock_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await clock_task

    _print_tool_log(result.tool_log)
    print_evaluation(
        result.incident, result.counters,
        opened_sim_time=result.incident.opened_sim_time, closed_sim_time=sim.clock.now(),
    )


async def main() -> None:
    await _run_demo(label="DEMO 1 — recoverable cooling fault (expect RESOLVED)", recoverable=True, seed=1)
    await _run_demo(label="DEMO 2 — unrecoverable cooling fault (expect ESCALATED)", recoverable=False, seed=2)


if __name__ == "__main__":
    asyncio.run(main())
