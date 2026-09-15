"""Incident identity and lifecycle.

The correlation key is the whole point of this module: without it, one cooling fault emits a
thermal warning, a session failure and a connector fault, and — absent an identity rule — that
would open three incidents and wake three agent loops on one fault, all mutating the same
station. `IncidentManager.on_trigger()` is the one place that rule is enforced.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from backend import config
from backend.world.transitions import transition

# The closed set of incident types. The event processor is the only caller that picks one of
# these; nothing else in the system invents an incident type.
INCIDENT_TYPES = ("CHARGER_FAULT", "COMPONENT_FAILURE", "SESSION_FAILURES", "COMMUNICATION_LOSS")

NON_TERMINAL_STATUSES = ("OPEN", "INVESTIGATING", "RECOVERING", "VERIFYING")
TERMINAL_STATUSES = ("RESOLVED", "ESCALATED", "FAILED")


@dataclass
class Incident:
    incident_id: str
    target: str
    type: str
    severity: str
    status: str
    opened_sim_time: float
    trigger_events: list[str] = field(default_factory=list)
    agent_run_id: str | None = None
    # Set only when a terminal ESCALATED status came from a harness guardrail breach, not from
    # the agent's own escalation decision — "GUARDRAIL_<name>" or None.
    escalation_reason: str | None = None
    # Set only when this incident was retired by pre-run triage (`pipeline/triage.py`) rather
    # than by an agent run — the live-state reason its triggering condition no longer held.
    closure_reason: str | None = None

    @property
    def key(self) -> tuple[str, str]:
        return (self.target, self.type)


class IncidentIdSequence:
    """One per world instance — see `EventIdSequence`'s note in `events.py` for why this isn't
    a process-wide global."""

    def __init__(self) -> None:
        self._n = 0

    def next(self) -> str:
        self._n += 1
        return f"INC-{self._n:03d}"


class ActiveRunLock:
    """Holds at most one incident_id: one agent run at a time, for the whole system. It lives
    in this module because the same module owns incident identity, which is what
    `IncidentManager.is_queued()` checks it against."""

    def __init__(self) -> None:
        self._incident_id: str | None = None

    @property
    def held_by(self) -> str | None:
        return self._incident_id

    def is_free(self) -> bool:
        return self._incident_id is None

    def acquire(self, incident_id: str) -> None:
        if self._incident_id is not None and self._incident_id != incident_id:
            raise RuntimeError(f"ACTIVE_RUN_LOCK already held by {self._incident_id}")
        self._incident_id = incident_id

    def release(self) -> None:
        self._incident_id = None


class IncidentManager:
    """Owns the correlation-key rule: at most one non-terminal incident per
    `(target_id, incident_type)`. A triggering event for an existing non-terminal incident with
    that key appends to `trigger_events`; otherwise a new incident opens.

    `INCIDENT_OPEN_WINDOW_SIM_SECONDS` additionally lets a just-terminated
    incident keep absorbing late trigger events for the same key, without reopening it, for
    that many sim-seconds after it went terminal — after the window a new trigger opens a
    fresh incident instead.
    """

    def __init__(self, store, id_seq: IncidentIdSequence | None = None,
                 run_lock: ActiveRunLock | None = None) -> None:
        self._store = store
        self._id_seq = id_seq or IncidentIdSequence()
        self.run_lock = run_lock or ActiveRunLock()
        self._open: dict[tuple[str, str], Incident] = {}
        self._recently_terminal: dict[tuple[str, str], tuple[Incident, float, set[str]]] = {}
        # Which event sources have triggered each incident — e.g. {"ST-01.contactor"} for a
        # COMPONENT_FAILURE. In-memory only, like the terminal window it serves: both exist for
        # the length of one run of the process, and neither is read back from SQLite.
        self._sources: dict[str, set[str]] = {}
        for incident in store.all():
            if incident.status in NON_TERMINAL_STATUSES:
                self._open[incident.key] = incident

    def on_trigger(self, *, target: str, incident_type: str, severity: str,
                    sim_time: float, event_ids: list[str], source: str | None = None) -> Incident:
        """`event_ids` is every triggering event this admission-control decision is based on —
        for a threshold rule (e.g. `SESSION_FAILURES`) that is the whole window, not just the
        event that tipped it over, so the incident's evidence trail matches what the agent
        will see when it asks for recent events."""
        key = (target, incident_type)

        existing = self._open.get(key)
        if existing is None:
            recent = self._recently_terminal.get(key)
            if recent is not None:
                recent_incident, terminal_sim_time, sources = recent
                within_window = sim_time - terminal_sim_time < config.INCIDENT_OPEN_WINDOW_SIM_SECONDS
                # The window exists to absorb *late echoes of the same fault* after an
                # incident closes — not to deafen the station to a different fault that happens
                # to share the correlation key. It was doing the latter: `(ST-01,
                # COMPONENT_FAILURE)` is the key for every one of the station's six components,
                # so for 600 sim-seconds (only 20 WALL-seconds at 30x) after any component
                # incident closed, a brand-new failure of a different component opened nothing
                # at all. Reported live as "I ran a contactor fault, it resolved, and then no
                # matter which other fault I injected it didn't accept it"; reproduced exactly.
                # A late echo comes from the source that triggered the incident in the first
                # place, so absorption is now conditional on that — the window's length, and
                # every other part of the correlation rule, are unchanged.
                same_source = source is None or not sources or source in sources
                if within_window and same_source:
                    existing = recent_incident

        if existing is not None:
            for event_id in event_ids:
                if event_id not in existing.trigger_events:
                    existing.trigger_events.append(event_id)
            if source is not None:
                self._sources.setdefault(existing.incident_id, set()).add(source)
            self._store.upsert(existing)
            return existing

        incident = Incident(
            incident_id=self._id_seq.next(),
            target=target,
            type=incident_type,
            severity=severity,
            status="OPEN",
            opened_sim_time=sim_time,
            trigger_events=list(event_ids),
        )
        self._open[key] = incident
        if source is not None:
            self._sources[incident.incident_id] = {source}
        self._store.upsert(incident)
        return incident

    def advance(self, incident: Incident, new_status: str, sim_time: float,
                *, escalation_reason: str | None = None) -> Incident:
        """Moves an incident's status along the incident transition table. Terminal statuses drop the
        incident out of `_open` (it can no longer absorb events by the non-terminal path) and
        start its `INCIDENT_OPEN_WINDOW_SIM_SECONDS` clock, timed from `sim_time` — the sim
        time of this transition, not the incident's original `opened_sim_time`.

        `escalation_reason` is only meaningful when `new_status == "ESCALATED"` and the
        escalation came from a harness guardrail breach ("GUARDRAIL_<name>"); leave it None
        for the agent's own escalation decision."""
        incident.status = transition("incident", incident.incident_id, incident.status, new_status)
        if escalation_reason is not None:
            incident.escalation_reason = escalation_reason
        self._store.upsert(incident)
        if incident.status in TERMINAL_STATUSES:
            if self._open.get(incident.key) is incident:
                del self._open[incident.key]
            self._recently_terminal[incident.key] = (
                incident, sim_time, self._sources.get(incident.incident_id, set()),
            )
            if self.run_lock.held_by == incident.incident_id:
                self.run_lock.release()
        return incident

    def retire(self, incident: Incident, reason: str, sim_time: float,
               *, terminal: str = "RESOLVED") -> Incident:
        """Close an incident whose triggering condition is already gone, without spending an
        agent run on it (`pipeline/triage.py` decides *whether*; this decides *how*).

        It walks the transition table's full forward path rather than jumping to RESOLVED,
        because the table has no OPEN -> RESOLVED edge and this is not a shortcut past it: triage
        genuinely investigated (it read live twin state) and genuinely verified (the condition
        that opened the incident is false), so INVESTIGATING -> RECOVERING -> VERIFYING ->
        RESOLVED is the honest description of what happened, in one sim-time instant.

        `terminal` is RESOLVED for an incident whose fault is simply gone, and ESCALATED for one
        that is being folded into an escalation already in flight for the same station — a
        connector that is only "no longer FAULTED" because an escalation isolated it has not
        been resolved, and saying so on screen would be a lie about a station a human still owns.
        """
        incident.closure_reason = reason
        if terminal == "ESCALATED":
            return self.advance(incident, "ESCALATED", sim_time)
        for status in ("INVESTIGATING", "RECOVERING", "VERIFYING", "RESOLVED"):
            if incident.status == status:
                continue
            self.advance(incident, status, sim_time)
        return incident

    def find_open(self, target: str, incident_type: str) -> Incident | None:
        return self._open.get((target, incident_type))

    def open_incidents(self) -> list[Incident]:
        """Every non-terminal incident still waiting for a run to be started on it — i.e.
        status OPEN. `INVESTIGATING`/`RECOVERING`/`VERIFYING` already have a run in flight
        (or, after a crash, are a case this MVP does not recover from automatically).
        Used by `api/app.py`'s incident watcher: one agent run at a time."""
        return [i for i in self._open.values() if i.status == "OPEN"]

    def is_queued(self, incident: Incident) -> bool:
        return not self.run_lock.is_free() and self.run_lock.held_by != incident.incident_id
