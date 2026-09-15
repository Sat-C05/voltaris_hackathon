"""The real agent loop: an LLM proposing tool calls into the same check -> apply -> record
path the scripted stub agent uses, but driven by an unpredictable model instead of a fixed
script — so every termination condition is enforced here, in code, and never requested of the
model. Anything you would be upset to see violated cannot be a request in a prompt.

One consequence is load-bearing for this file: the stub agent's OBSERVATION calls
(`_StubRunner.observe()`) skip `PolicyValidator` entirely, since its arguments are hand-scripted
and always valid. A real model can hallucinate a bad `station_id`, and `ToolExecutor`'s methods
index the twin directly with no existence check — an OBSERVATION call is therefore routed
through `PolicyValidator.check()` here too, which already performs the target-existence check
for every category before it branches on category, and does nothing further for OBSERVATION
(observations stay free and unlimited — no preconditions, safety constraints, attempts, cooldown
or transition check apply). This turns a hallucinated target into a structured, actionable
rejection instead of an uncaught `KeyError` crashing the harness: a guardrail breach must route
to safe escalation, never a crash.
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from typing import Any

from backend import config
from backend.agent.context import PROPOSE_RESOLUTION, WAIT
from backend.agent.evaluation import RunCounters
from backend.agent.llm_client import LLMClient
from backend.agent.policy import PolicyValidator
from backend.agent.tools import ToolExecutor
from backend.agent.verifier import Verifier
from backend.pipeline.incident import Incident, IncidentManager
from backend.world.simulator import Simulator

# A local implementation budget for a malformed or tool-less model turn, kept separate from
# MAX_STEPS: a malformed emission is not a reasoning step.
NO_TOOL_CALL_RETRY_LIMIT = 3

# The per-call ceiling on the `wait` harness request (see context.WAIT). 900 sim-seconds is
# 15 sim-minutes: enough for one call to make visible progress against the -1.5 °C/sim-min
# ambient relax rate, small enough that
# no single call can skip the whole incident.
MAX_WAIT_SIM_SECONDS = 900

# How many answered repeats a run gets past `DUPLICATE_CALL_LIMIT` before the duplicate
# guardrail becomes
# terminal. `DUPLICATE_CALL_LIMIT` itself is untouched; this only governs what happens on a
# breach of it (see `_DuplicateTracker`). A repeat is the mildest pathology and the only one that
# costs the world nothing, so the first breaches are answered rather than fatal; the ceiling is
# what keeps "never hang" true.
DUPLICATE_CALL_GRACE = 2

_INVESTIGATIVE_CATEGORIES = ("OBSERVATION", "DIAGNOSTIC")


@dataclass
class AgentRunResult:
    incident: Incident
    counters: RunCounters
    tool_log: list[dict[str, Any]] = field(default_factory=list)
    transcript: list[Any] = field(default_factory=list)


class _DuplicateTracker:
    """`DUPLICATE_CALL_LIMIT`: same tool + same args, counted across the whole run.

    The limit is unchanged; what changed is the response to breaching it. A third identical call
    used to end the run in a forced escalation, which live testing kept catching at the worst
    moment: an agent that had already repaired the station repeated one call while working out
    how to finish, and a fully successful recovery was recorded as `GUARDRAIL_DUPLICATE_CALL`.
    Repetition is the mildest pathology — it mutates nothing and costs no sim time —
    so `over_limit` is now answered with a structured rejection the model can act on, exactly
    like a policy refusal, and only `over_ceiling` (two further repeats) ends the run.
    """

    def __init__(self, limit: int, ceiling: int) -> None:
        self._limit = limit
        self._ceiling = ceiling
        self._counts: dict[tuple, int] = {}

    def count(self, name: str, args: dict) -> int:
        key = (name, tuple(sorted(args.items())))
        self._counts[key] = self._counts.get(key, 0) + 1
        return self._counts[key]

    def over_limit(self, count: int) -> bool:
        return count > self._limit

    def over_ceiling(self, count: int) -> bool:
        return count > self._ceiling


def _advance_sim_seconds(sim: Simulator, seconds: float) -> None:
    """Durations shorter than one tick round up to the next tick boundary."""
    if seconds <= 0:
        return
    for _ in range(max(1, math.ceil(seconds / config.TICK_SIM_SECONDS))):
        sim.tick()


class AgentHarness:
    """Runs one incident through the real LLM agent loop end to end: investigate, act, verify,
    resolve or escalate. The caller is responsible for opening the incident and advancing it to
    INVESTIGATING before calling `run()` — mirroring the stub agent's own split between setup
    and the runner."""

    def __init__(self, *, sim: Simulator, tools: ToolExecutor, policy: PolicyValidator,
                 verifier: Verifier, incidents: IncidentManager, llm: LLMClient,
                 capabilities: dict) -> None:
        self.sim = sim
        self.tools = tools
        self.policy = policy
        self.verifier = verifier
        self.incidents = incidents
        self.llm = llm
        self.capabilities = capabilities

    async def run(self, *, incident: Incident, system_prompt: str, tools_schema: list[dict],
                   goals: list[dict], constraints: list[dict],
                   settle_sim_seconds: float = config.DEFAULT_SETTLE_SIM_SECONDS,
                   counters: RunCounters | None = None,
                   tool_log: list[dict[str, Any]] | None = None) -> AgentRunResult:
        # Both optional, and both for the same reason: a caller (api/app.py's `/world` and
        # `/runs/{id}`, the snapshot's `active_run` and the agent timeline) can hold the
        # same instances and read them live while this coroutine is still running — appending to
        # a shared list and reading it back needs no lock on a single-threaded event loop, so
        # the agent timeline can populate step by step in the browser instead of appearing all
        # at once when the run ends. Callers that don't need this (llm_demo.py) are
        # unaffected: a fresh instance is created exactly as before.
        counters = counters if counters is not None else RunCounters()
        tool_log = tool_log if tool_log is not None else []
        messages: list[Any] = [{"role": "system", "content": system_prompt}]
        duplicates = _DuplicateTracker(
            config.DUPLICATE_CALL_LIMIT, config.DUPLICATE_CALL_LIMIT + DUPLICATE_CALL_GRACE,
        )

        consecutive_observations = 0
        actions_taken = 0
        # Abnormal readings the agent has ALREADY been handed this run, replayed back to it in
        # the budget warning. This adds no information the model has not already received — it
        # is its own tool output, restated — and Invariant 5 is untouched: nothing here infers a
        # cause, it only lists what read abnormal. A small model loses track of its own findings
        # across a long transcript: live testing caught an agent reading `contactor: DEGRADED`
        # on its fifth call and then spending its last call on another component instead of
        # acting on what it had just found.
        findings: list[str] = []
        pending_action_reminder: str | None = None
        verification_retries = 0
        last_action_sim_time = incident.opened_sim_time
        no_tool_call_streak = 0
        wall_clock_start = time.time()

        def warn_if_near_observation_budget() -> None:
            """One warning, injected at budget-1, before the guardrail fires silently.

            The budgets stay enforced in code and are never *asked* for in the prompt — this
            does not ask, it tells the model what the system is about to do to it. Found in
            live testing: an agent read cooling FAILED on its
            second call, then kept enumerating the other five components and was force-escalated
            mid-investigation, with a fix it had already diagnosed and never attempted. A model
            that cannot see its own budget cannot spend it deliberately."""
            remaining = config.MAX_CONSECUTIVE_OBSERVATIONS - consecutive_observations
            if remaining in (1, 2):
                already_acted = actions_taken > 0
                next_step = (
                    "You have already taken a recovery action. If your readings show the target "
                    "back in service, call propose_resolution now and the system will verify it "
                    "against live state — that is the only way this run can end as resolved. "
                    "If they do not, act again or escalate deliberately."
                    if already_acted else
                    "Act on the evidence you already have: take a recovery action, or escalate "
                    "deliberately with what you have gathered."
                )
                so_far = (
                    f" Abnormal readings you have already gathered: {'; '.join(findings)}."
                    if findings else
                    " Nothing you have read so far is abnormal."
                )
                messages.append({
                    "role": "system",
                    "content": (
                        f"You have made {consecutive_observations} consecutive calls without "
                        f"acting. After {remaining} more the system will isolate the target and "
                        f"escalate automatically, ending this run.{so_far} {next_step}"
                    ),
                })

        def forced_escalation(reason: str, evidence: str) -> AgentRunResult:
            counters.guardrail_fired = reason

            # Verify before escalating, but only once the agent has actually acted.
            #
            # A guardrail breach would otherwise route straight to the deterministic
            # isolate -> ticket -> notify path. Live testing showed that turning a
            # *successful* recovery into an escalation is this system's most common wrong
            # answer: twice in a row the agent diagnosed a fault in four steps, fixed it, watched
            # the station come back — and then kept reading components instead of calling
            # propose_resolution, so the observation budget escalated a station whose
            # temperature was back at ambient with every component HEALTHY. The world's real
            # state, not the model's failure to announce it, should decide the outcome.
            #
            # Invariant 7 is untouched and arguably strengthened: the agent still cannot write
            # RESOLVED, and the same Verifier still judges the same live twin state after the
            # same settling period. What changes is only that a breach no longer *prevents* that
            # judgement from being made. A breach with no action taken escalates exactly as
            # before — there is nothing to verify — and a failed verification falls straight
            # through to the unchanged escalation path, with the guardrail still recorded on the
            # run either way.
            if actions_taken > 0:
                verification = self._handle_propose_resolution(
                    incident=incident,
                    args={"evidence": f"Harness verification before forced escalation ({reason})."},
                    goals=goals, constraints=constraints, since_sim_time=last_action_sim_time,
                    settle_sim_seconds=settle_sim_seconds, counters=counters, tool_log=tool_log,
                    forced=True,
                )
                if verification.passed:
                    return AgentRunResult(
                        incident=incident, counters=counters, tool_log=tool_log, transcript=messages,
                    )

            self._run_forced_escalation(incident, evidence, tool_log)
            self.incidents.advance(
                incident, "ESCALATED", self.sim.clock.now(), escalation_reason=reason,
            )
            return AgentRunResult(incident=incident, counters=counters, tool_log=tool_log, transcript=messages)

        while True:
            if time.time() - wall_clock_start > config.WALL_CLOCK_TIMEOUT_SECONDS:
                return forced_escalation(
                    "GUARDRAIL_WALL_CLOCK_TIMEOUT", "Wall-clock timeout waiting on the model.",
                )
            if counters.tool_calls >= config.MAX_STEPS:
                return forced_escalation(
                    "GUARDRAIL_MAX_STEPS", f"Exhausted the {config.MAX_STEPS}-tool-call step budget.",
                )

            message = await self.llm.chat(messages, tools_schema)
            messages.append(message)

            if not message.tool_calls:
                no_tool_call_streak += 1
                if no_tool_call_streak > NO_TOOL_CALL_RETRY_LIMIT:
                    return forced_escalation(
                        "GUARDRAIL_NO_TOOL_CALL", "Model repeatedly failed to call a tool.",
                    )
                messages.append({
                    "role": "system",
                    "content": "You must call exactly one of the available tools to make progress.",
                })
                continue
            no_tool_call_streak = 0

            for call in message.tool_calls:
                name = call.function.name
                args = dict(call.function.arguments)

                if counters.tool_calls >= config.MAX_STEPS:
                    return forced_escalation(
                        "GUARDRAIL_MAX_STEPS", f"Exhausted the {config.MAX_STEPS}-tool-call step budget.",
                    )

                if name == PROPOSE_RESOLUTION:
                    result = self._handle_propose_resolution(
                        incident=incident, args=args, goals=goals, constraints=constraints,
                        since_sim_time=last_action_sim_time, settle_sim_seconds=settle_sim_seconds,
                        counters=counters, tool_log=tool_log,
                    )
                    consecutive_observations = 0
                    if result.passed:
                        return AgentRunResult(incident=incident, counters=counters, tool_log=tool_log, transcript=messages)
                    verification_retries += 1
                    if verification_retries > config.MAX_VERIFICATION_RETRIES:
                        return forced_escalation(
                            "GUARDRAIL_MAX_VERIFICATION_RETRIES",
                            f"Verification failed {verification_retries} times: {result.failed_predicates}",
                        )
                    messages.append({
                        "role": "tool", "tool_name": name,
                        "content": f"NOT VERIFIED. Failed predicates: {result.failed_predicates}",
                    })
                    continue

                if name == WAIT:
                    # A harness request, like propose_resolution: never policy-checked, never
                    # an ACTION, and exempt from the duplicate tracker for the same reason
                    # propose_resolution is — a repeated wait is not a stuck no-progress loop,
                    # it advances the world every time. MAX_STEPS, the consecutive-observation
                    # budget and the wall clock still bound it.
                    result = self._handle_wait(args, counters, tool_log)
                    # A wait BEFORE any action is stalling, and counts. A wait AFTER one is the
                    # protocol's own rule 8 ("if the effect of that action needs time to show
                    # up, wait for it before judging it") and is progress, not avoidance — the
                    # world measurably changes on every one. Found live: an agent restarted a
                    # failed cooling controller, waited five times while the temperature fell
                    # 107 °C -> 70.6 °C, and was force-escalated roughly two waits short of the
                    # 55 °C its reset_connector safety constraint required. MAX_STEPS and the
                    # wall clock still bound it; only this counter is exempted.
                    if actions_taken == 0:
                        consecutive_observations += 1
                        if consecutive_observations > config.MAX_CONSECUTIVE_OBSERVATIONS:
                            return forced_escalation(
                                "GUARDRAIL_MAX_CONSECUTIVE_OBSERVATIONS",
                                "Investigated without acting for too long.",
                            )
                        warn_if_near_observation_budget()
                    messages.append({"role": "tool", "tool_name": name, "content": str(result)})
                    continue

                entry = self.capabilities.get(name)
                category = entry["category"] if entry else None

                if category in _INVESTIGATIVE_CATEGORIES:
                    consecutive_observations += 1
                else:
                    consecutive_observations = 0
                if consecutive_observations > config.MAX_CONSECUTIVE_OBSERVATIONS:
                    return forced_escalation(
                        "GUARDRAIL_MAX_CONSECUTIVE_OBSERVATIONS",
                        "Investigated without acting for too long.",
                    )
                warn_if_near_observation_budget()

                if category == "ACTION" and actions_taken >= config.MAX_ACTIONS:
                    return forced_escalation(
                        "GUARDRAIL_MAX_ACTIONS", f"Reached the {config.MAX_ACTIONS}-action budget.",
                    )

                repeat_count = duplicates.count(name, args)
                if duplicates.over_ceiling(repeat_count):
                    return forced_escalation(
                        "GUARDRAIL_DUPLICATE_CALL",
                        f"Repeated {name}({args}) beyond the duplicate-call limit.",
                    )
                if duplicates.over_limit(repeat_count):
                    # Costs a step, but is NOT a policy rejection: `PolicyValidator` never saw
                    # it, and the policy-rejection count is a measure of the agent proposing
                    # things the world refuses, which this is not.
                    counters.tool_calls += 1
                    sim_time = self.sim.clock.now()
                    message_text = (
                        f"REJECTED: DUPLICATE_CALL — you have already called {name} with these "
                        f"exact arguments {config.DUPLICATE_CALL_LIMIT} times and the answer has "
                        "not changed. Repeating it will not tell you anything new. Either act on "
                        "what you already know, or, if the station now meets the success "
                        "criteria, call propose_resolution."
                    )
                    tool_log.append({
                        "tool": name, "args": args, "sim_time": sim_time, "rejected": True,
                        "reason": "DUPLICATE_CALL", "message": message_text.removeprefix("REJECTED: "),
                    })
                    messages.append({"role": "tool", "tool_name": name, "content": message_text})
                    continue

                counters.tool_calls += 1
                sim_time = self.sim.clock.now()
                target_id = _target_id_for(name, args)
                decision = self.policy.check(
                    incident_id=incident.incident_id, capability=name, target_id=target_id,
                    sim_time=sim_time, params=args,
                ) if entry is not None else _unknown_capability_decision(name)

                if not decision.allowed:
                    counters.policy_rejections += 1
                    tool_log.append({
                        "tool": name, "args": args, "sim_time": sim_time, "rejected": True,
                        "reason": decision.reason, "message": decision.message,
                    })
                    messages.append({
                        "role": "tool", "tool_name": name,
                        "content": f"REJECTED: {decision.reason} — {decision.message}",
                    })
                    continue

                try:
                    result = getattr(self.tools, name)(**args)
                except (TypeError, KeyError) as exc:
                    tool_log.append({
                        "tool": name, "args": args, "sim_time": sim_time, "rejected": True,
                        "reason": "INVALID_ARGUMENTS", "message": str(exc),
                    })
                    messages.append({
                        "role": "tool", "tool_name": name,
                        "content": f"ERROR: invalid arguments for {name}: {exc}",
                    })
                    continue

                if category == "ACTION":
                    self.policy.record_applied(incident.incident_id, name, target_id, sim_time)
                    counters.recovery_actions += 1
                    actions_taken += 1
                    last_action_sim_time = sim_time
                    if incident.status == "INVESTIGATING":
                        self.incidents.advance(incident, "RECOVERING", self.sim.clock.now())
                    # Protocol rules 10 and 6, restated at the one moment they apply. A run that
                    # has acted is one call away from either finishing or wasting its budget, and
                    # the observed failure at this point is never a wrong action — it is drifting
                    # on without ever asking for verification.
                    pending_action_reminder = (
                        "You have taken a recovery action. Observe its effect, and as soon as "
                        "your readings show the success criteria met, call propose_resolution — "
                        "it is the only route to a resolved incident, and the system, not you, "
                        "decides whether it passes."
                    )

                _advance_sim_seconds(self.sim, entry["duration_sim_seconds"])
                _note_findings(name, args, result, findings)
                tool_log.append({
                    "tool": name, "args": args, "sim_time": sim_time, "rejected": False, "result": result,
                })
                messages.append({"role": "tool", "tool_name": name, "content": str(result)})
                if pending_action_reminder is not None:
                    messages.append({"role": "system", "content": pending_action_reminder})
                    pending_action_reminder = None

                if category == "ESCALATION":
                    # Isolation is deterministic, not a request to the model: the canonical
                    # sequence is set_connector_availability(false) -> ticket -> notify, but the
                    # model calling create_maintenance_ticket/notify_operator directly (its own
                    # choice of ESCALATION tool) must not depend on it remembering the isolate
                    # step too — found live, an agent-initiated escalation that skipped it left
                    # a known-broken station's connector marked AVAILABLE.
                    self._isolate_station(incident, tool_log)
                    self.incidents.advance(incident, "ESCALATED", self.sim.clock.now())
                    return AgentRunResult(incident=incident, counters=counters, tool_log=tool_log, transcript=messages)

    # ── wait -> the harness's clock, not the world's capability surface ─────────────────────

    def _handle_wait(self, args: dict, counters: RunCounters,
                      tool_log: list[dict[str, Any]]) -> dict[str, Any]:
        """Advance simulated time and hand back what the station looks like afterwards.

        The telemetry comes back with the wait rather than making the agent follow up with
        `get_telemetry`, because that follow-up is exactly the call the duplicate-call guardrail
        would kill on its third identical repetition — the failure this request exists to fix.
        """
        counters.tool_calls += 1
        station_id = str(args.get("station_id", ""))
        station = self.sim.twin.stations.get(station_id)
        sim_time = self.sim.clock.now()

        if station is None:
            result: dict[str, Any] = {
                "error": f"unknown station_id '{station_id}'", "waited_sim_seconds": 0,
            }
            tool_log.append({
                "tool": WAIT, "args": args, "sim_time": sim_time, "rejected": True,
                "reason": "INVALID_TARGET", "message": result["error"],
            })
            return result

        try:
            requested = float(args.get("sim_seconds", 0))
        except (TypeError, ValueError):
            requested = 0.0
        seconds = max(config.TICK_SIM_SECONDS, min(MAX_WAIT_SIM_SECONDS, requested))

        before_c = station.telemetry.temperature_c
        _advance_sim_seconds(self.sim, seconds)
        result = {
            "waited_sim_seconds": seconds,
            "sim_time": self.sim.clock.now(),
            "temperature_c": round(station.telemetry.temperature_c, 1),
            "temperature_c_before_wait": round(before_c, 1),
            "cooling_effectiveness": station.telemetry.cooling_effectiveness,
            "connectors": {cid: c.status for cid, c in station.connectors.items()},
        }
        tool_log.append({
            "tool": WAIT, "args": args, "sim_time": sim_time, "rejected": False, "result": result,
        })
        return result

    # ── propose_resolution -> Verifier against live state ────────────────────────────────────

    def _handle_propose_resolution(self, *, incident: Incident, args: dict, goals: list[dict],
                                    constraints: list[dict], since_sim_time: float,
                                    settle_sim_seconds: float, counters: RunCounters,
                                    tool_log: list[dict[str, Any]], forced: bool = False):
        counters.tool_calls += 1
        if incident.status == "INVESTIGATING":
            self.incidents.advance(incident, "RECOVERING", self.sim.clock.now())
        self.incidents.advance(incident, "VERIFYING", self.sim.clock.now())

        _advance_sim_seconds(self.sim, settle_sim_seconds)  # verification takes sim time
        result = self.verifier.verify(
            goals=goals, constraints=constraints, since_sim_time=since_sim_time,
            station_id=incident.target.partition("/")[0],
        )
        entry: dict[str, Any] = {
            "tool": PROPOSE_RESOLUTION, "args": args, "sim_time": self.sim.clock.now(), "rejected": False,
            "result": {"passed": result.passed, "failed_predicates": result.failed_predicates},
        }
        if forced:
            entry["forced"] = True   # the timeline must show this was the harness, not the agent
        tool_log.append(entry)

        if result.passed:
            self.incidents.advance(incident, "RESOLVED", self.sim.clock.now())
        else:
            self.incidents.advance(incident, "RECOVERING", self.sim.clock.now())  # retry loop
        return result

    # ── guardrail breach -> deterministic isolate-and-escalate ───────────────────────────────

    def _run_forced_escalation(self, incident: Incident, evidence: str, tool_log: list[dict[str, Any]]) -> None:
        """The harness performs this itself rather than asking the model — a guardrail breach
        means the model's trajectory is no longer trusted to choose the next action."""
        self._isolate_station(incident, tool_log)
        self._apply_forced(
            "create_maintenance_ticket", incident, tool_log,
            target=incident.target,
            summary=f"Guardrail-forced escalation for {incident.incident_id}",
            evidence=evidence,
        )
        self._apply_forced(
            "notify_operator", incident, tool_log,
            target=incident.target, message=f"Incident {incident.incident_id} escalated: {evidence}",
        )

    def _isolate_station(self, incident: Incident, tool_log: list[dict[str, Any]]) -> None:
        """Take every connector at the incident's station out of service ("DO NOT force
        the connector online... set_connector_availability(false)"). Every station in this
        world has exactly one connector, so isolating "the station" and isolating "the
        target connector" are the same operation whether the incident's own target names a
        connector (`ST-02/C02`) or not (`ST-02`) — found live: a station-level incident
        (COMPONENT_FAILURE on an unrecoverable cooling fault) escalated cleanly but left its
        connector marked AVAILABLE, so the same physical fault later crossed TEMP_PROTECTION and
        raised a second, redundant CHARGER_FAULT incident for a problem already known and
        already escalated. A connector mid-session (PREPARING/CHARGING/FINISHING) has no legal
        transition straight to UNAVAILABLE — that attempt is rejected and logged,
        not retried; the isolation is best-effort, and a session already loading a vehicle isn't
        interrupted by it, which is both safe and expected."""
        station_id = incident.target.partition("/")[0]
        station = self.sim.twin.stations.get(station_id)
        if station is None:
            return
        for connector_id, connector in station.connectors.items():
            if connector.status in ("AVAILABLE", "FAULTED"):
                self._apply_forced(
                    "set_connector_availability", incident, tool_log,
                    station_id=station_id, connector_id=connector_id, available=False,
                )

    def _apply_forced(self, name: str, incident: Incident, tool_log: list[dict[str, Any]], **kwargs) -> None:
        entry = self.capabilities[name]
        sim_time = self.sim.clock.now()
        target_id = _target_id_for(name, kwargs)
        decision = self.policy.check(
            incident_id=incident.incident_id, capability=name, target_id=target_id,
            sim_time=sim_time, params=kwargs,
        )
        if not decision.allowed:
            tool_log.append({
                "tool": name, "args": kwargs, "sim_time": sim_time, "rejected": True,
                "reason": decision.reason, "message": decision.message, "forced": True,
            })
            return
        result = getattr(self.tools, name)(**kwargs)
        self.policy.record_applied(incident.incident_id, name, target_id, sim_time)
        _advance_sim_seconds(self.sim, entry["duration_sim_seconds"])
        tool_log.append({
            "tool": name, "args": kwargs, "sim_time": sim_time, "rejected": False,
            "result": result, "forced": True,
        })


def _note_findings(name: str, args: dict, result: Any, findings: list[str]) -> None:
    """Collect the abnormal readings a tool result contains, in the agent's own words, for the
    budget warning to replay. Purely a restatement of what the model was already told — see the
    `findings` declaration in `run()`."""
    if not isinstance(result, dict):
        return
    health = result.get("health")
    if health is not None and health != "HEALTHY":
        note = f"{args.get('component', result.get('component'))} is {health}"
        if note not in findings:
            findings.append(note)
    for test_name, test in (result.get("self_tests") or {}).items():
        if isinstance(test, dict) and test.get("result") == "FAIL":
            note = f"{result.get('subsystem')} self-test '{test_name}' FAILED"
            if note not in findings:
                findings.append(note)


def _unknown_capability_decision(name: str):
    from backend.agent.policy import PolicyDecision, UNKNOWN_CAPABILITY
    return PolicyDecision(False, UNKNOWN_CAPABILITY, f"'{name}' is not a known capability.")


def _target_id_for(name: str, args: dict) -> str:
    """Reconstruct the `target_id` shape `PolicyValidator`/`Twin.resolve()` expect from a
    tool call's own arguments (the `station.*`/`connector`/`component` id shapes)."""
    if "connector_id" in args:
        return f"{args['station_id']}/{args['connector_id']}"
    if "component" in args:
        return f"{args['station_id']}.{args['component']}"
    if "subsystem" in args:
        # `run_diagnostic`'s component parameter is named `subsystem`, but its
        # capability `target_type` is "component" — without this branch its target_id collapsed
        # to a bare station id and every run_diagnostic call was rejected INVALID_TARGET.
        return f"{args['station_id']}.{args['subsystem']}"
    if "target" in args:
        return args["target"]
    if "station_id" in args:
        return args["station_id"]
    return ""
