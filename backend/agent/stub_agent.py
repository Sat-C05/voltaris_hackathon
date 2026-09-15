"""The scripted stub agent — no LLM.

A hardcoded tool sequence that drives one cooling incident all the way to RESOLVED,
verification included, with one deliberate policy rejection scripted in — attempting
`reset_connector` while the station is still hot — so that path is proven without a model
involved.

This is deliberately NOT the real agent loop: no LLM, no harness guardrails (`MAX_STEPS` etc.
bound an unpredictable model's trajectory, and this trajectory is fixed by hand), no context
builder. Its only job is to prove the plumbing closes end to end — policy -> tools ->
simulator -> events -> incidents -> verifier — deterministically, so that debugging the real
agent is "is this a good decision?" rather than "is this the prompt or the plumbing?"
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from backend import config
from backend.agent.evaluation import RunCounters
from backend.agent.policy import PolicyValidator
from backend.agent.tools import ToolExecutor
from backend.agent.verifier import Verifier
from backend.pipeline.incident import Incident
from backend.pipeline.wiring import Pipeline
from backend.world.clock import Clock
from backend.world.simulator import Fault, Simulator
from backend.world.twin import Twin

MAX_FAULT_TICKS = 2000   # matches world/demo.py's budget for "fault -> FAULTED"


@dataclass
class StubAgentResult:
    incident: Incident
    counters: RunCounters
    tool_log: list[dict[str, Any]] = field(default_factory=list)


def _advance_sim_seconds(sim: Simulator, seconds: float) -> None:
    """Durations round up to the next tick boundary — there is no intra-tick
    scheduling, so a `duration_sim_seconds` cost is realized as whole ticks."""
    if seconds <= 0:
        return
    for _ in range(max(1, math.ceil(seconds / config.TICK_SIM_SECONDS))):
        sim.tick()


class _StubRunner:
    """Routes every scripted call through check -> apply -> record, the same path a real
    agent loop uses, so this really exercises the plumbing and not a shortcut."""

    def __init__(self, *, sim: Simulator, tools: ToolExecutor, policy: PolicyValidator,
                 incident: Incident, capabilities: dict) -> None:
        self.sim = sim
        self.tools = tools
        self.policy = policy
        self.incident = incident
        self.capabilities = capabilities
        self.counters = RunCounters()
        self.tool_log: list[dict[str, Any]] = []

    def observe(self, tool_name: str, /, **kwargs: Any) -> Any:
        """OBSERVATION: free, unlimited, not policy-checked."""
        sim_time = self.sim.clock.now()
        result = getattr(self.tools, tool_name)(**kwargs)
        self.counters.tool_calls += 1
        self.tool_log.append({
            "tool": tool_name, "args": kwargs, "result": result, "rejected": False, "sim_time": sim_time,
        })
        return result

    def act(self, tool_name: str, target_id: str, /, **kwargs: Any):
        """DIAGNOSTIC/ACTION/ESCALATION: policy-checked, costs sim time; ACTION additionally
        counts against the attempt/cooldown ledger, but only once actually applied."""
        entry = self.capabilities[tool_name]
        sim_time = self.sim.clock.now()
        decision = self.policy.check(
            incident_id=self.incident.incident_id, capability=tool_name, target_id=target_id,
            sim_time=sim_time, params=kwargs,
        )
        self.counters.tool_calls += 1
        if not decision.allowed:
            self.counters.policy_rejections += 1
            self.tool_log.append({
                "tool": tool_name, "args": kwargs, "rejected": True, "sim_time": sim_time,
                "reason": decision.reason, "message": decision.message,
            })
            return decision

        result = getattr(self.tools, tool_name)(**kwargs)
        if entry["category"] == "ACTION":
            self.policy.record_applied(self.incident.incident_id, tool_name, target_id, sim_time)
            self.counters.recovery_actions += 1
        _advance_sim_seconds(self.sim, entry["duration_sim_seconds"])
        self.tool_log.append({
            "tool": tool_name, "args": kwargs, "result": result, "rejected": False, "sim_time": sim_time,
        })
        return result


def run_cooling_stub_agent(*, twin: Twin, clock: Clock, sim: Simulator, pipeline: Pipeline,
                            capabilities: dict, station_id: str = "ST-02",
                            connector_id: str = "C02", fault_id: str = "FLT-STUB-001") -> StubAgentResult:
    connector = twin.stations[station_id].connectors[connector_id]
    source = f"{station_id}/{connector_id}"

    sim.schedule_fault(Fault(
        fault_id=fault_id, target=f"{station_id}.cooling", mode="DEGRADED", severity=0.7,
        delay_sim_seconds=30, recoverable=True,
    ))
    for _ in range(MAX_FAULT_TICKS):
        sim.tick()
        if connector.status == "FAULTED":
            break
    if connector.status != "FAULTED":
        raise RuntimeError("stub agent setup failed: connector never reached FAULTED")

    incident = pipeline.incidents.find_open(source, "CHARGER_FAULT")
    if incident is None:
        raise RuntimeError(f"stub agent setup failed: no open CHARGER_FAULT incident for {source}")
    pipeline.incidents.advance(incident, "INVESTIGATING", sim.clock.now())

    policy = PolicyValidator(twin, capabilities)
    tools = ToolExecutor(twin, clock, pipeline.on_event, pipeline.event_store)
    verifier = Verifier(twin, pipeline.event_store)
    runner = _StubRunner(sim=sim, tools=tools, policy=policy, incident=incident, capabilities=capabilities)

    # 1-2. Observe before acting (protocol rule 1).
    runner.observe("get_station_state", station_id=station_id)
    runner.observe("get_telemetry", station_id=station_id)

    # 3. Diagnose — a reading, never a root cause.
    runner.act("run_diagnostic", f"{station_id}.cooling", station_id=station_id, subsystem="cooling")

    # 4. The deliberate wrong move: reset the connector while the station is still hot.
    #    Confirms the safety constraint fires, with a useful message.
    rejected = runner.act("reset_connector", source, station_id=station_id, connector_id=connector_id)
    assert getattr(rejected, "allowed", None) is False, "expected the early reset_connector to be rejected"

    # 5. Adapt (protocol rule 5): restart the component the diagnostic actually flagged.
    runner.act("restart_component", f"{station_id}.cooling", station_id=station_id, component="cooling")

    # 6. Wait for temperature to actually fall below the reset safety threshold.
    for _ in range(MAX_FAULT_TICKS):
        if twin.stations[station_id].telemetry.temperature_c < config.TEMP_SAFE:
            break
        sim.tick()
    pipeline.incidents.advance(incident, "RECOVERING", sim.clock.now())

    # 7. The real reset, now that it is safe.
    runner.act("reset_connector", source, station_id=station_id, connector_id=connector_id)
    action_sim_time = sim.clock.now()

    # 8. Settle before verifying — a falling number, not a lucky instant.
    _advance_sim_seconds(sim, config.DEFAULT_SETTLE_SIM_SECONDS)

    # 9. propose_resolution -> the harness runs the verifier against LIVE state. The agent
    #    has no other path to RESOLVED.
    pipeline.incidents.advance(incident, "VERIFYING", sim.clock.now())
    result = verifier.verify(
        goals=[{"target": source, "property": "status", "op": "equals", "value": "AVAILABLE"}],
        constraints=[
            {"target": station_id, "property": "telemetry.temperature_c", "op": "<", "value": config.TEMP_SAFE},
            {"target": station_id, "property": "components.cooling.health", "op": "equals", "value": "HEALTHY"},
        ],
        since_sim_time=action_sim_time,
    )

    if result.passed:
        pipeline.incidents.advance(incident, "RESOLVED", sim.clock.now())
    else:
        pipeline.incidents.advance(incident, "RECOVERING", sim.clock.now())

    return StubAgentResult(incident=incident, counters=runner.counters, tool_log=runner.tool_log)
