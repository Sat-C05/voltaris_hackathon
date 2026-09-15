"""FastAPI application: the HTTP surface, the tick loop, and the incident watcher.

The tick loop runs as an asyncio.Task on the same single event loop as the HTTP handlers and
the agent harness, so twin mutations are serialized by construction — no locks, no races
between a tick and a read, and none between a tick and a tool call. The one rule that keeps
this true:

    NOTHING IN A REQUEST HANDLER OR THE AGENT LOOP MAY BLOCK THE EVENT LOOP.

Ollama calls go through the async client, never the sync one (`agent/llm_client.py`). A
blocking LLM call would freeze the world's simulated clock mid-run.

This module wires the same objects the CLI demo scripts do (`Simulator`, `Pipeline`,
`ToolExecutor`, `PolicyValidator`, `Verifier`, `AgentHarness`) into one long-lived process
instead of a one-shot script, and adds the one thing a script doesn't need: an **incident
watcher** that starts an `AgentHarness` run by itself, the moment an incident opens, respecting
the "one agent run at a time" rule via `IncidentManager.run_lock`.
"""

from __future__ import annotations

import asyncio
import itertools
import json
import random
import traceback
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from backend import config
from backend.agent.capabilities import assert_no_drift, load_capabilities
from backend.agent.context import (
    build_incident_context,
    build_system_prompt,
    render_capabilities_for_prompt,
    render_success_criteria,
    render_tools_schema,
)
from backend.agent.evaluation import RunCounters, score_scenario
from backend.agent.harness import AgentHarness, AgentRunResult
from backend.agent.llm_client import LLMClient
from backend.agent.policy import PolicyValidator
from backend.agent.tools import ToolExecutor
from backend.agent.verifier import Verifier
from backend.pipeline import triage
from backend.pipeline.golden_runs import GoldenRunStore, build_recorded_log
from backend.pipeline.golden_runs import connect as connect_golden_runs
from backend.pipeline.incident import Incident
from backend.pipeline.wiring import Pipeline, build_pipeline
from backend.world.clock import Clock
from backend.world.simulator import Fault, Simulator
from backend.world.twin import COMPONENT_NAMES, Twin

WATCHER_INTERVAL_REAL = 0.5   # how often the incident watcher looks for OPEN incidents

# The tick loop's sleep slice: how quickly a `POST /clock/scale` change is felt. Not a
# tunable of the clock itself — `TICK_SIM_SECONDS` is untouched; this only bounds how long a
# pacing change can sit unapplied. See `_tick_loop` for why slicing is necessary at all.
SCALE_POLL_REAL = 0.1

# Back in service, not merely idle at this instant: the world keeps running sessions during
# the verifier's settle window, so a connector that recovered can legitimately be
# PREPARING/CHARGING/FINISHING by the
# time the verifier looks, which is a strictly better state than AVAILABLE alone would accept.
IN_SERVICE = ["AVAILABLE", "PREPARING", "CHARGING", "FINISHING"]


# ── application state — one instance, replaced wholesale by POST /world/reset ────────────────

@dataclass
class ActiveRun:
    run_id: str
    incident: Incident
    counters: RunCounters
    tool_log: list[dict]
    task: asyncio.Task


@dataclass
class AppState:
    twin: Twin
    clock: Clock
    sim: Simulator
    pipeline: Pipeline
    capabilities: dict
    golden_runs: GoldenRunStore
    scale: float = config.SIM_TIME_SCALE
    tick_task: asyncio.Task | None = None
    watcher_task: asyncio.Task | None = None
    active_run: ActiveRun | None = None
    tick_errors: int = 0
    runs: dict[str, AgentRunResult] = field(default_factory=dict)
    _run_ids: itertools.count = field(default_factory=lambda: itertools.count(1))
    _fault_ids: itertools.count = field(default_factory=lambda: itertools.count(1))

    # Set by `POST /scenarios/run` right before it schedules the fault,
    # consumed exactly once by the next `_start_one_run_if_due` that starts a run — see that
    # function's docstring for why "once" matters. `run_scenarios` is the durable half: keyed by
    # `run_id`, it outlives `active_run` (cleared the moment a run ends) so `GET /evaluation/{id}`
    # can still find it afterwards.
    active_scenario: dict | None = None
    run_scenarios: dict[str, dict] = field(default_factory=dict)

    def next_run_id(self) -> str:
        return f"RUN-{next(self._run_ids):03d}"

    def next_fault_id(self) -> str:
        return f"FLT-{next(self._fault_ids):03d}"


def build_state(seed: int | None = None) -> AppState:
    """A fresh world: one twin, one clock, one pipeline, all owned here.

    Deletes the SQLite file rather than reusing it — nothing reads it across restarts, and a
    stale events/incidents table from a previous run would reference twin entities a fresh
    `Twin.load()` has already reset, which is a worse failure mode than losing history nothing
    currently consumes. `POST /world/reset` calls this too, to reset twin, clock, event store
    and incident store together.

    `seed`, when given, seeds the simulator's RNG (session drops, handshake failures — the only
    two `self.rng.random()` call sites in `world/simulator.py`), which is what makes a scenario
    run reproducible. `None` (every caller except `POST /scenarios/run`) keeps an unseeded
    `random.Random()`, per-process nondeterministic, exactly as manual fault injection runs."""
    db_path = Path(config.DB_PATH)
    db_path.unlink(missing_ok=True)

    twin = Twin.load(config.WORLDS_DIR / "locality_01.json")
    clock = Clock()
    pipeline = build_pipeline(str(db_path), twin=twin)
    rng = random.Random(seed) if seed is not None else None
    sim = Simulator(twin, clock, on_event=pipeline.on_event, rng=rng)
    capabilities = load_capabilities()
    # Reconnecting here every reset is fine -- it's the same durable file each time, per
    # `GOLDEN_RUNS_DB_PATH`'s own comment on why it is never the file this function deletes.
    golden_runs = GoldenRunStore(connect_golden_runs(str(config.GOLDEN_RUNS_DB_PATH)))
    state = AppState(twin=twin, clock=clock, sim=sim, pipeline=pipeline,
                      capabilities=capabilities, golden_runs=golden_runs)
    # Found live: `_run_ids` restarting at 1 here on every reset made every scenario
    # run's agent "RUN-001" again, silently overwriting the last recording under the same primary
    # key in `golden_runs` (a store that deliberately outlives this function's resets). Seeding
    # from the store's own history keeps every run_id this process ever hands out unique for the
    # store's whole lifetime, not just this one `AppState`'s.
    state._run_ids = itertools.count(golden_runs.next_run_number())
    return state


def load_scenario(scenario_id: str) -> dict:
    """A scenario file, read straight off disk — `data/scenarios/*.json` is the one thing
    `POST /scenarios/run` needs and the manual injection form never did."""
    path = config.SCENARIOS_DIR / f"{scenario_id}.json"
    if not path.is_file():
        raise HTTPException(404, f"unknown scenario '{scenario_id}'")
    return json.loads(path.read_text())


# ── background tasks ──────────────────────────────────────────────────────────────────────────

async def _tick_loop(state: AppState) -> None:
    """The Clock, run as its own task, exactly like `world.simulator.run_background_clock`
    — except `interval_real` is read from `state.scale` on every iteration instead of being fixed
    at task creation, which is what lets `POST /clock/scale` actually change the pacing of an
    already-running loop.

    One tick that raises must never stop the clock. An `asyncio.Task` that raises dies silently
    — nothing retrieves its exception — and the world then freezes while every endpoint keeps
    answering happily: `/world` returns a snapshot whose `sim_time` never advances, the agent's
    own `_advance_sim_seconds` still ticks (so a run appears to work), and an operator watching
    the browser sees a station that has simply stopped changing. Observed live at the end of the
    Observed in testing: a server left running showed `clock.running: false` with the
    world stuck. A failing tick is logged and skipped instead; the clock is the one thing in
    this process that may not stop (Invariant 6's "never crash, never hang", applied to the
    world loop rather than the agent loop)."""
    while True:
        # Sleep in slices, re-reading `state.scale` each one, rather than in a single
        # `await asyncio.sleep(TICK_SIM_SECONDS / scale)`.
        #
        # The single-sleep version made `POST /clock/scale`'s own promise false: the loop read
        # the scale, then committed to a sleep of that length, so a scale change arriving during
        # the sleep did nothing until it expired. Switching ×1 -> ×120 took up to 15 real seconds
        # to be felt, and a "pause" expressed as a very low scale (which is exactly what the
        # frontend design asked for, there being no pause endpoint) computed a 150,000-second
        # sleep and froze the world *permanently* — `GET /clock` still answering `scale: 30,
        # running: true` while `sim_time` never moved again. Found by driving the real
        # endpoint: paused, resumed to ×30, and watched sim_time sit at 2490.0 across five
        # polls. It is the precise failure this function's own docstring was written about,
        # arriving through the pacing control instead of through a raising tick.
        #
        # No clock tunable changes: `TICK_SIM_SECONDS` is untouched and each tick still
        # advances the world by exactly one tick. Only the responsiveness of the wall-clock
        # wait between ticks changes.
        slept = 0.0
        while True:
            interval_real = config.TICK_SIM_SECONDS / state.scale
            if slept >= interval_real:
                break
            await asyncio.sleep(min(SCALE_POLL_REAL, interval_real - slept))
            slept += SCALE_POLL_REAL
        try:
            state.sim.tick()
        except Exception:  # noqa: BLE001 — see the docstring: the clock outlives any one tick.
            state.tick_errors += 1
            traceback.print_exc()


async def _incident_watcher(state: AppState) -> None:
    """At most one agent run at a time. Polls for an OPEN incident with the run lock free,
    acquires it, advances the incident to INVESTIGATING, and launches the harness as its own
    task — the one piece a one-shot demo script doesn't need, because there the caller starts
    the run itself."""
    while True:
        await asyncio.sleep(WATCHER_INTERVAL_REAL)
        try:
            _start_one_run_if_due(state)
        except Exception:  # noqa: BLE001 — same rule as the tick loop: the watcher may not die.
            traceback.print_exc()


def _start_one_run_if_due(state: AppState) -> None:
    """One pass of the watcher: at most one run started, or one moot incident retired."""
    if state.active_run is not None or not state.pipeline.incidents.run_lock.is_free():
        return
    candidates = state.pipeline.incidents.open_incidents()
    if not candidates:
        return
    incident = min(candidates, key=lambda i: i.opened_sim_time)

    # Pre-run triage (pipeline/triage.py): one physical fault legitimately opens several
    # incidents under different correlation keys, and runs happen one at a time
    # — so by the time a queued one reaches the front, the run ahead of it has often
    # already removed its cause. Spending an agent run on a symptom that is already gone is
    # how a working station ends up ESCALATED, seen repeatedly in live testing. Checked here, at
    # the last possible moment against live state, rather than when the event arrived.
    # A station already handed to a human takes no further agent runs at all. Its queued
    # incidents are folded into the escalation that is already in flight — whether or not their
    # symptom has cleared. One unrecoverable network_iface fault opens COMPONENT_FAILURE,
    # COMMUNICATION_LOSS and SESSION_FAILURES; before this, each in turn got a full run that
    # rediscovered the same unfixable fault and escalated it again, three times over (reported
    # live). The maintenance hold stops *new* incidents opening; this stops the ones that opened
    # before the escalation from being investigated after it.
    station = state.twin.stations.get(incident.target.partition("/")[0])
    if station is not None and station.maintenance_hold:
        state.pipeline.incidents.retire(
            incident,
            f"folded into the open escalation for {station.station_id}",
            state.sim.clock.now(), terminal="ESCALATED",
        )
        return

    moot = triage.moot_reason(incident, state.twin)
    if moot is not None:
        state.pipeline.incidents.retire(incident, moot, state.sim.clock.now())
        return

    state.pipeline.incidents.run_lock.acquire(incident.incident_id)
    state.pipeline.incidents.advance(incident, "INVESTIGATING", state.sim.clock.now())
    run_id = state.next_run_id()
    counters = RunCounters()
    tool_log: list[dict] = []

    # Consumed exactly once: a scenario's fault is the only fault scheduled against a fresh,
    # just-reset world (`POST /scenarios/run` builds one), so the very next run this watcher
    # starts is that fault's incident — there is nothing else in the queue to steal it. Cleared
    # immediately after so a later *manual* fault injected into the same still-running world
    # (nothing stops that) falls back to `_default_success_criteria` like every non-scenario run.
    if state.active_scenario is not None:
        state.run_scenarios[run_id] = state.active_scenario
        state.active_scenario = None

    task = asyncio.create_task(_run_agent(state, incident, run_id, counters, tool_log))
    state.active_run = ActiveRun(
        run_id=run_id, incident=incident, counters=counters, tool_log=tool_log, task=task,
    )


async def _run_agent(state: AppState, incident: Incident, run_id: str,
                      counters: RunCounters, tool_log: list[dict]) -> None:
    """One full agent run against a live incident. Mirrors `llm_demo.py`'s wiring exactly, minus
    the parts a script needs and a long-lived process doesn't (the background clock task is
    already running for the whole process, not started/stopped per run)."""
    incident.agent_run_id = run_id
    state.pipeline.incident_store.upsert(incident)

    scenario_record = state.run_scenarios.get(run_id)
    if scenario_record is not None:
        # The scenario's own success_criteria, not a hand-written guess — the whole point of
        # the scenario files over `_default_success_criteria`'s honest fallback.
        criteria = scenario_record["scenario"]["success_criteria"]
        goals, constraints = criteria["goals"], criteria["constraints"]
    else:
        goals, constraints = _default_success_criteria(incident)
    incident_context = build_incident_context(
        incident=incident, twin=state.twin, event_store=state.pipeline.event_store,
    )
    system_prompt = build_system_prompt(
        incident_context=incident_context,
        capabilities_text=render_capabilities_for_prompt(state.capabilities),
        success_criteria_text=render_success_criteria(goals=goals, constraints=constraints),
        max_steps=config.MAX_STEPS, max_actions=config.MAX_ACTIONS,
        max_consecutive_observations=config.MAX_CONSECUTIVE_OBSERVATIONS,
    )
    harness = AgentHarness(
        sim=state.sim,
        tools=ToolExecutor(state.twin, state.clock, state.pipeline.on_event, state.pipeline.event_store),
        policy=PolicyValidator(state.twin, state.capabilities),
        verifier=Verifier(state.twin, state.pipeline.event_store),
        incidents=state.pipeline.incidents,
        llm=LLMClient(),
        capabilities=state.capabilities,
    )

    try:
        result = await harness.run(
            incident=incident, system_prompt=system_prompt, tools_schema=render_tools_schema(state.capabilities),
            goals=goals, constraints=constraints, counters=counters, tool_log=tool_log,
        )
        state.runs[run_id] = result
    except asyncio.CancelledError:
        # A cancelled run is NOT a crashed run, and `CancelledError` is a `BaseException` in
        # Python 3.8+ — so without this branch it sails past the broad `except Exception` below
        # and into the `finally`, where `state.runs[run_id]` was never written and raised
        # `KeyError` instead: the golden-run save, `active_run = None` and, worst of all,
        # `run_lock.release()` were all skipped, leaving the run lock held forever and no further
        # agent run able to start (the run lock is the thing that gates every run).
        #
        # Latent until now only because both cancel sites (`POST /world/reset`,
        # `POST /scenarios/run`) replace the whole `AppState` immediately, so the wedged lock
        # belonged to a state nothing read again. Any future cancel that KEEPS the state — an
        # "abort run" control in the frontend is the obvious one — would have hung the demo
        # permanently, with no error visible anywhere. Found by audit and confirmed with a
        # direct asyncio probe before being fixed.
        #
        # Re-raised, never swallowed: the caller cancelled this task on purpose and asyncio must
        # still see the task end as cancelled. The `finally` below now tolerates the missing
        # entry, so the lock is released and the incident left where the cancel found it — the
        # state it belongs to is being discarded anyway.
        raise
    except Exception as exc:  # noqa: BLE001 — Invariant 6: a guardrail breach (or a crash inside
        # one) must never crash the process or hang the demo. An unexpected exception (e.g. the
        # model host is unreachable) is treated the same as a guardrail breach: isolate and
        # escalate deterministically rather than leaving the incident stuck INVESTIGATING forever.
        state.pipeline.incidents.advance(
            incident, "ESCALATED", state.sim.clock.now(), escalation_reason="GUARDRAIL_HARNESS_ERROR",
        )
        tool_log.append({"tool": "_harness_error", "args": {}, "sim_time": state.sim.clock.now(),
                          "rejected": True, "reason": "GUARDRAIL_HARNESS_ERROR", "message": str(exc)})
        state.runs[run_id] = AgentRunResult(incident=incident, counters=counters, tool_log=tool_log)
    finally:
        # Record every run, clean or not -- a run that ended on GUARDRAIL_HARNESS_ERROR
        # still deserves a durable log (it's evidence, not a demo candidate), and there is no
        # extra cost to recording it uniformly rather than special-casing "only the good ones".
        # `.get()`, not `[...]`: a cancelled run (see the `CancelledError` branch above) never
        # reaches either assignment, and an exception raised HERE would skip the two lines below
        # that actually matter — releasing the run lock. There is nothing worth recording for a
        # cancelled run anyway: it has no terminal outcome, only a truncated log.
        result = state.runs.get(run_id)
        if result is not None:
            state.golden_runs.save(
                run_id=run_id, incident=incident,
                scenario_id=scenario_record["scenario"]["scenario_id"] if scenario_record else None,
                log=build_recorded_log(incident=incident, tool_log=result.tool_log,
                                        event_store=state.pipeline.event_store),
            )
        state.active_run = None
        state.pipeline.incidents.run_lock.release()


def _default_success_criteria(incident: Incident) -> tuple[list[dict], list[dict]]:
    """Hand-written goals and constraints per incident type, used only when the incident did
    not come from a scenario file (a scenario supplies its own `success_criteria`).
    `CHARGER_FAULT` is the only type any demo path exercises end to end; the rest get a
    generic, honest fallback.

    That fallback must not be a guess at which specific component was at fault (nothing may
    leak that to the agent) — but it also must not be so weak that it stops meaning anything. An
    earlier version of this function only checked `station.status`, which live testing caught
    passing `propose_resolution` for a still-actively-overheating station: a COMPONENT_FAILURE
    incident opens on a component health transition to FAILED, which does not by itself move
    `station.status` away from AVAILABLE (only crossing TEMP_PROTECTION does that) — so an agent
    that called `restart_component` on the wrong component, or called it too early, could
    satisfy "station status looks fine" while the actual fault, and the temperature it was
    driving up, were both still live. The fix is not to name the faulted component (the
    Verifier is deterministic backend code, allowed to check everything at once without telling
    the agent which check mattered) — it's to require every component healthy and the
    temperature below the warning threshold, which is true if and only if nothing is still
    broken, regardless of which of the six components broke."""
    station_id, _, connector_id = incident.target.partition("/")

    if incident.type == "CHARGER_FAULT" and connector_id:
        source = f"{station_id}/{connector_id}"
        # Every component healthy, not just cooling. A connector faults for more reasons than
        # heat — a DEGRADED contactor drops 70% of sessions after 20 s of charging — and
        # with only the thermal constraints to satisfy, `reset_connector` alone passed
        # verification while the thing that faulted the connector was still there, so the
        # connector faulted again a session later. That is the difference the human measured
        # between contactor FAILED (~8/10 resolved) and contactor DEGRADED (~6/10): FAILED opens
        # a COMPONENT_FAILURE whose criteria already demanded a healthy station, DEGRADED opens
        # a CHARGER_FAULT whose criteria did not. Clearing a latched fault is not a repair
        # unless the cause is gone too.
        return (
            [{"target": source, "property": "status", "op": "in", "value": IN_SERVICE}],
            [
                {"target": station_id, "property": "telemetry.temperature_c", "op": "<", "value": config.TEMP_SAFE},
                *(
                    {"target": station_id, "property": f"components.{name}.health",
                     "op": "equals", "value": "HEALTHY"}
                    for name in COMPONENT_NAMES
                ),
            ],
        )

    # COMPONENT_FAILURE / SESSION_FAILURES / COMMUNICATION_LOSS: no scenario file yet to say
    # which component matters, so every component must be HEALTHY and temperature must be back
    # under the warning threshold — "nothing is still broken," checked without naming what was.
    constraints = [
        {"target": station_id, "property": f"components.{name}.health", "op": "equals", "value": "HEALTHY"}
        for name in COMPONENT_NAMES
    ]
    constraints.append(
        {"target": station_id, "property": "telemetry.temperature_c", "op": "<", "value": config.TEMP_WARNING},
    )
    goals = [{"target": station_id, "property": "status", "op": "in", "value": IN_SERVICE}]
    return (goals, constraints)


# ── lifespan ───────────────────────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    assert_no_drift(load_capabilities())  # Fail loud at startup, before any request.
    state = build_state()
    app.state.core = state
    state.tick_task = asyncio.create_task(_tick_loop(state))
    state.watcher_task = asyncio.create_task(_incident_watcher(state))
    yield
    for task in (state.tick_task, state.watcher_task, state.active_run.task if state.active_run else None):
        if task is not None:
            task.cancel()


app = FastAPI(title="EV Autonomous NOC", version="0.1.0", lifespan=lifespan)


# ── request bodies ────────────────────────────────────────────────────────────────────────────

class FaultInjectRequest(BaseModel):
    station_id: str
    component: str
    mode: str = "DEGRADED"          # "DEGRADED" | "FAILED"
    severity: float = 0.7
    delay_sim_seconds: float = 30.0
    recoverable: bool = True


class ClockScaleRequest(BaseModel):
    scale: float


class ScenarioRunRequest(BaseModel):
    scenario_id: str
    seed: int | None = None


# ── snapshot builder ─────────────────────────────────────────────────────────────────────────

def _build_snapshot(state: AppState) -> dict:
    stations = {}
    for station_id, station in state.twin.stations.items():
        t = station.telemetry
        stations[station_id] = {
            "status": station.status,
            "connectors": {cid: {"status": c.status} for cid, c in station.connectors.items()},
            "components": {name: {"health": c.health} for name, c in station.components.items()},
            "communication_state": station.communication_state,
            "telemetry": {
                "temperature_c": round(t.temperature_c, 1),
                "power_kw": t.power_kw,
                "cooling_effectiveness": t.cooling_effectiveness,
                "handshake_success_rate": t.handshake_success_rate,
                "comm_latency_ms": t.comm_latency_ms,
            },
            "active_session": station.active_session,
            # The incident panel and map need to show that a station is held for a human, so
            # it is part of the snapshot shape.
            "maintenance_hold": station.maintenance_hold,
        }

    incidents = []
    for incident in state.pipeline.incident_store.all():
        incidents.append({
            "incident_id": incident.incident_id,
            "target": incident.target,
            "type": incident.type,
            "severity": incident.severity,
            "status": incident.status,
            "opened_sim_time": incident.opened_sim_time,
            "trigger_event_count": len(incident.trigger_events),
            "agent_run_id": incident.agent_run_id,
            "queued": state.pipeline.incidents.is_queued(incident),
            "escalation_reason": incident.escalation_reason,
            "closure_reason": incident.closure_reason,
        })

    active_run = None
    if state.active_run is not None:
        active_run = {
            "run_id": state.active_run.run_id,
            "incident_id": state.active_run.incident.incident_id,
            "steps_used": state.active_run.counters.tool_calls,
            "max_steps": config.MAX_STEPS,
            "actions_used": state.active_run.counters.recovery_actions,
            "max_actions": config.MAX_ACTIONS,
            "state": state.active_run.incident.status,
        }

    return {
        "sim_time": state.sim.clock.now(),
        "clock": {
            "scale": state.scale,
            "tick_sim_seconds": config.TICK_SIM_SECONDS,
            "running": state.tick_task is not None and not state.tick_task.done(),
        },
        "stations": stations,
        "gateway": {gid: {"status": g.status} for gid, g in state.twin.gateway.items()},
        "incidents": incidents,
        "active_run": active_run,
        # An injected fault is invisible for as long as its delay lasts, and then for as long
        # as its consequences take to cross a threshold — during which the UI showed nothing at
        # all and the operator could not tell a pending fault from a broken injection. The
        # queue is display-only; nothing renders state from it.
        "faults": [
            {
                "fault_id": f.fault_id, "target": f.target, "mode": f.mode,
                "severity": f.severity, "recoverable": f.recoverable,
                "fires_at_sim_time": f.scheduled_at_sim_time, "applied": f.applied,
            }
            for f in state.sim.faults()
        ],
    }


# ── endpoints ─────────────────────────────────────────────────────────────────────────────────

@app.get("/health")
async def health() -> dict:
    """Liveness — the demo script's process check."""
    return {"status": "ok", "phase": "API & frontend"}


@app.get("/world")
async def get_world() -> JSONResponse:
    """The snapshot — the frontend's ONLY rendering input. Complete on every poll, never a
    delta."""
    return JSONResponse(_build_snapshot(app.state.core))


@app.get("/stations/{station_id}")
async def get_station(station_id: str) -> dict:
    snapshot = _build_snapshot(app.state.core)
    station = snapshot["stations"].get(station_id)
    if station is None:
        raise HTTPException(404, f"unknown station '{station_id}'")
    return {"station_id": station_id, **station}


@app.get("/incidents")
async def list_incidents() -> list[dict]:
    return _build_snapshot(app.state.core)["incidents"]


@app.get("/incidents/{incident_id}")
async def get_incident(incident_id: str) -> dict:
    for incident in _build_snapshot(app.state.core)["incidents"]:
        if incident["incident_id"] == incident_id:
            return incident
    raise HTTPException(404, f"unknown incident '{incident_id}'")


@app.get("/events")
async def get_events(since: float = 0.0) -> list[dict]:
    """Append-only log, display only — never a rendering input."""
    events = app.state.core.pipeline.event_store.since(since)
    return [
        {
            "event_id": e.event_id, "sim_time": e.sim_time, "source": e.source, "type": e.type,
            "previous_state": e.previous_state, "new_state": e.new_state,
            "severity": e.severity, "metadata": e.metadata,
        }
        for e in events
    ]


@app.get("/runs/golden")
async def list_golden_runs() -> dict:
    """A small, cheap addition for a demo-run picker: which
    recordings exist, which scenario each came from, and how it ended, without pulling a whole
    log just to list them. Registered ABOVE `GET /runs/{run_id}` deliberately: FastAPI matches
    routes in registration order, and `{run_id}` would otherwise swallow the literal "golden"
    path segment first -- caught live (curl returned "unknown run 'golden'"), not by reading."""
    state: AppState = app.state.core
    return {"runs": state.golden_runs.list_summaries()}


@app.get("/runs/{run_id}")
async def get_run(run_id: str) -> dict:
    """The agent timeline: sim_time, tool call, result, policy verdict — never raw model
    reasoning."""
    state: AppState = app.state.core
    if state.active_run is not None and state.active_run.run_id == run_id:
        return {
            "run_id": run_id, "incident_id": state.active_run.incident.incident_id,
            "status": "IN_PROGRESS", "tool_log": state.active_run.tool_log,
        }
    result = state.runs.get(run_id)
    if result is None:
        raise HTTPException(404, f"unknown run '{run_id}'")
    return {
        "run_id": run_id, "incident_id": result.incident.incident_id,
        "status": result.incident.status, "tool_log": result.tool_log,
    }


@app.get("/evaluation/{run_id}")
async def get_evaluation(run_id: str) -> dict:
    state: AppState = app.state.core
    result = state.runs.get(run_id)
    if result is None:
        raise HTTPException(404, f"unknown run '{run_id}'")
    c = result.counters
    evaluation = {
        "run_id": run_id,
        "incident_id": result.incident.incident_id,
        "outcome": result.incident.status,
        "escalation_reason": result.incident.escalation_reason,
        "tool_calls": c.tool_calls,
        "recovery_actions": c.recovery_actions,
        "policy_rejections": c.policy_rejections,
        "guardrail_fired": c.guardrail_fired,
    }
    # The ✓/✗ scores only exist for a run that came from a scenario (`run_scenarios`
    # keeps the association past `active_run` being cleared) — a hand-injected fault has no
    # `success_criteria` to score against and keeps the raw counts alone, as it always has.
    scenario_record = state.run_scenarios.get(run_id)
    if scenario_record is not None:
        evaluation.update(score_scenario(
            incident=result.incident, tool_log=result.tool_log,
            scenario=scenario_record["scenario"],
            fault_fired_sim_time=scenario_record["fault_fired_sim_time"],
            twin=state.twin,
        ))
    return evaluation


@app.post("/faults/inject")
async def inject_fault(body: FaultInjectRequest) -> dict:
    """The single fault path — the manual injection form and the scenario runner both submit
    through exactly this endpoint."""
    state: AppState = app.state.core
    station = state.twin.stations.get(body.station_id)
    if station is None:
        raise HTTPException(404, f"unknown station '{body.station_id}'")
    if body.component not in station.components:
        raise HTTPException(422, f"unknown component '{body.component}' on {body.station_id}")
    if body.mode not in ("DEGRADED", "FAILED"):
        raise HTTPException(422, "mode must be 'DEGRADED' or 'FAILED'")

    fault = Fault(
        fault_id=state.next_fault_id(),
        target=f"{body.station_id}.{body.component}",
        mode=body.mode,
        severity=body.severity,
        delay_sim_seconds=body.delay_sim_seconds,
        recoverable=body.recoverable,
    )
    state.sim.schedule_fault(fault)
    return {
        "fault_id": fault.fault_id, "target": fault.target, "mode": fault.mode,
        "fires_at_sim_time": state.sim.clock.now() + body.delay_sim_seconds,
    }


@app.post("/stations/{station_id}/return-to-service")
async def return_to_service(station_id: str) -> dict:
    """Lift a station's maintenance hold — the operator saying the engineer is done.

    A hold silences admission control for that station (`EventProcessor._suppressed`) and folds
    its queued incidents into the open escalation, which is right while a human owns the
    equipment and wrong forever after. Without a way back, an escalated station stays silent
    until `POST /world/reset` — which live testing hit immediately: an escalation early in a
    session made every later fault injected at that station look as though it had been ignored.
    Returns each connector to service exactly as `set_connector_availability(available=True)`
    does, which is itself what clears the flag."""
    state: AppState = app.state.core
    station = state.twin.stations.get(station_id)
    if station is None:
        raise HTTPException(404, f"unknown station '{station_id}'")

    tools = ToolExecutor(state.twin, state.clock, state.pipeline.on_event, state.pipeline.event_store)
    restored = []
    for connector_id, connector in station.connectors.items():
        if connector.status == "UNAVAILABLE":
            tools.set_connector_availability(
                station_id=station_id, connector_id=connector_id, available=True,
            )
            restored.append(connector_id)
    station.maintenance_hold = False
    return {"station_id": station_id, "maintenance_hold": False, "connectors_restored": restored}


@app.post("/world/reset")
async def reset_world() -> dict:
    """Reset twin, clock, event store and incident store. Cancels the in-flight
    tick/watcher/agent tasks first — two loops mutating two different twins is worse than the
    concurrent-run case the one-run-at-a-time rule was written to prevent."""
    old: AppState = app.state.core
    for task in (old.tick_task, old.watcher_task, old.active_run.task if old.active_run else None):
        if task is not None:
            task.cancel()

    new_state = build_state()
    app.state.core = new_state
    new_state.tick_task = asyncio.create_task(_tick_loop(new_state))
    new_state.watcher_task = asyncio.create_task(_incident_watcher(new_state))
    return {"status": "reset"}


@app.get("/clock")
async def get_clock() -> dict:
    state: AppState = app.state.core
    return {
        "sim_time": state.sim.clock.now(),
        "scale": state.scale,
        "tick_sim_seconds": config.TICK_SIM_SECONDS,
        "running": state.tick_task is not None and not state.tick_task.done(),
    }


@app.post("/clock/scale")
async def set_clock_scale(body: ClockScaleRequest) -> dict:
    """Settable at runtime for demo pacing; never touches `TICK_SIM_SECONDS`, only how fast
    wall-clock time delivers ticks."""
    if body.scale <= 0:
        raise HTTPException(422, "scale must be positive")
    app.state.core.scale = body.scale
    return {"scale": body.scale}


@app.get("/scenarios")
async def list_scenarios() -> dict:
    return {"scenarios": sorted(p.stem for p in config.SCENARIOS_DIR.glob("*.json"))}


@app.post("/scenarios/run")
async def run_scenario(body: ScenarioRunRequest) -> dict:
    """Set a scenario running: load the world, reset every store, seed the RNG, load the
    scenario, start the tick loop, schedule the fault. Everything after that (wait for the
    incident, run the agent, wait for a terminal state, evaluate, persist) is exactly what the
    incident watcher and `GET /evaluation/{run_id}` already do for a manually injected fault —
    a scenario's fault goes through the same `Simulator.schedule_fault` as `POST /faults/inject`,
    so nothing about how it plays out afterward is scenario-specific except which
    `success_criteria` the run is scored against (`AppState.active_scenario`, consumed by
    `_start_one_run_if_due`).

    Rebuilds the world exactly like `POST /world/reset`, so a scenario run promises the same
    clean start, plus the seed needed to reproduce session drops and handshake failures
    deterministically."""
    scenario = load_scenario(body.scenario_id)

    old: AppState = app.state.core
    for task in (old.tick_task, old.watcher_task, old.active_run.task if old.active_run else None):
        if task is not None:
            task.cancel()

    new_state = build_state(seed=body.seed)
    fault_spec = scenario["fault"]
    station_id, _, component = fault_spec["target"].partition(".")
    if station_id not in new_state.twin.stations:
        raise HTTPException(422, f"scenario '{body.scenario_id}' targets unknown station '{station_id}'")

    fired_at = new_state.sim.clock.now() + fault_spec["delay_sim_seconds"]
    new_state.active_scenario = {"scenario": scenario, "fault_fired_sim_time": fired_at}
    new_state.sim.schedule_fault(Fault(
        fault_id=new_state.next_fault_id(), target=fault_spec["target"], mode=fault_spec["mode"],
        severity=fault_spec["severity"], delay_sim_seconds=fault_spec["delay_sim_seconds"],
        recoverable=fault_spec["recoverable"],
    ))

    app.state.core = new_state
    new_state.tick_task = asyncio.create_task(_tick_loop(new_state))
    new_state.watcher_task = asyncio.create_task(_incident_watcher(new_state))
    return {
        "status": "scheduled", "scenario_id": body.scenario_id, "seed": body.seed,
        "fault_target": fault_spec["target"], "fires_at_sim_time": fired_at,
    }


@app.post("/runs/{run_id}/replay")
async def replay_run(run_id: str) -> dict:
    """Hand back the whole recorded `(sim_time, kind, payload)` log for `run_id`. Zero model
    calls by construction -- nothing here re-simulates or re-derives anything, it is the exact
    log `_run_agent` persisted when the run finished. Pacing it back out at the recorded
    sim-time deltas is the frontend's job (poll-driven, no WebSockets; a replay is the
    same consumption pattern against a static array a live run already uses against a growing
    one). Reads from `AppState.golden_runs`, which survives `POST /world/reset` on purpose
    (`config.GOLDEN_RUNS_DB_PATH`'s own comment), so a run recorded before a reset is still here
    after one."""
    state: AppState = app.state.core
    recording = state.golden_runs.get(run_id)
    if recording is None:
        raise HTTPException(404, f"no recorded run '{run_id}' — only a finished run is recorded")
    return recording


# ── static frontend (built by `npm run build` into backend/static) ───────────────────────────
_STATIC_DIR = Path(__file__).parent.parent / "static"
if _STATIC_DIR.is_dir():
    app.mount("/", StaticFiles(directory=_STATIC_DIR, html=True), name="static")
