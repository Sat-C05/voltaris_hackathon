"""The policy validator — seven checks.

    Agent
      -> reset_connector(C02)
    PolicyValidator
      1. capability exists?
      2. target exists and is the right type?
      3. preconditions satisfied against live twin state?
      4. safety constraints satisfied?
      5. attempts remaining under max_attempts?
      6. cooldown elapsed in sim time?
      7. resulting transition legal per the transition table?
      -> ALLOW
    ToolExecutor applies the mutation

OBSERVATION is not policy-checked at all — observations are free and unlimited. DIAGNOSTIC gets
the "light" check — capability, target, attempts, cooldown, but not preconditions/safety/
transition, since a diagnostic probe doesn't mutate anything for a transition to be illegal
about. ACTION and ESCALATION get all seven.

The model never touches the world: it proposes into this typed action space, and this function
adjudicates. `check()` only decides; it never mutates. The caller applies the tool and then
calls `record_applied()` so the next `check()` sees an accurate attempt/cooldown ledger.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from backend.agent.ops import apply_op
from backend.world.transitions import IllegalTransition, transition
from backend.world.twin import Twin

# Rejection codes — a closed set.
UNKNOWN_CAPABILITY = "UNKNOWN_CAPABILITY"
INVALID_TARGET = "INVALID_TARGET"
PRECONDITION_FAILED = "PRECONDITION_FAILED"
SAFETY_CONSTRAINT_VIOLATED = "SAFETY_CONSTRAINT_VIOLATED"
ATTEMPT_LIMIT_REACHED = "ATTEMPT_LIMIT_REACHED"
COOLDOWN_ACTIVE = "COOLDOWN_ACTIVE"
ILLEGAL_TRANSITION = "ILLEGAL_TRANSITION"

# The three ACTION tools' resulting-state effect. `capabilities.json` has no field for this
# (only preconditions/safety_constraints), so check 7 — "resulting transition legal" — has to
# know each ACTION's target transition in code. It reuses the exact same `transition()`
# function the simulator calls — one function, two callers — so the validator
# can never invent a reachability opinion the simulator doesn't already share.
_RESET_CONNECTOR = "reset_connector"
_RESTART_COMPONENT = "restart_component"
_SET_CONNECTOR_AVAILABILITY = "set_connector_availability"

# The hole that hardcoding leaves, closed. Because the mapping above lives in
# Python and not in `capabilities.json`, adding a fourth ACTION tool would fall through
# `_check_transition`'s final `else` and get **no transition check at all, silently** —
# `assert_no_drift` cannot catch it either, since the tool and its capability entry both exist.
# `PolicyValidator.__init__` now asserts every ACTION capability appears here, so the failure
# is loud and at startup instead of quiet at runtime. The fuller fix would be to
# carry the resulting-state effect as data in `capabilities.json`; this is the small one that
# makes the omission impossible to miss.
_TRANSITION_MAPPED_ACTIONS = frozenset({
    _RESET_CONNECTOR, _RESTART_COMPONENT, _SET_CONNECTOR_AVAILABILITY,
})


@dataclass
class PolicyDecision:
    allowed: bool
    reason: str | None = None
    message: str | None = None
    constraint: str | None = None
    observed: Any = None


class PolicyValidator:
    def __init__(self, twin: Twin, capabilities: dict) -> None:
        self.twin = twin
        self.capabilities = capabilities
        unmapped = sorted(
            name for name, entry in capabilities.items()
            if entry["category"] == "ACTION" and name not in _TRANSITION_MAPPED_ACTIONS
        )
        if unmapped:
            raise ValueError(
                "ACTION capabilities with no resulting-state mapping in policy.py, so check 7 "
                f"would not validate them: {unmapped}. Add each to `_TRANSITION_MAPPED_ACTIONS` "
                "and give `_check_transition` its target transition."
            )
        # Attempts/cooldowns are counted per (capability, target) per INCIDENT.
        self._attempt_counts: dict[tuple[str, str, str], int] = {}
        self._last_applied_sim_time: dict[tuple[str, str, str], float] = {}

    def check(self, *, incident_id: str, capability: str, target_id: str,
              sim_time: float, params: dict | None = None) -> PolicyDecision:
        params = params or {}

        entry = self.capabilities.get(capability)
        if entry is None:
            return PolicyDecision(False, UNKNOWN_CAPABILITY, f"'{capability}' is not a known capability.")

        target_check = self._check_target(entry["target_type"], target_id)
        if target_check is not None:
            return target_check

        category = entry["category"]
        if category == "OBSERVATION":
            return PolicyDecision(True)

        if category == "DIAGNOSTIC":
            return self._check_limits(incident_id, capability, target_id, entry, sim_time)

        # ACTION / ESCALATION: full seven checks.
        for step in (
            lambda: self._check_preconditions(capability, entry, target_id),
            lambda: self._check_safety(capability, entry, target_id),
        ):
            failure = step()
            if failure is not None:
                return failure

        limits_decision = self._check_limits(incident_id, capability, target_id, entry, sim_time)
        if not limits_decision.allowed:
            return limits_decision

        transition_failure = self._check_transition(capability, target_id, params)
        if transition_failure is not None:
            return transition_failure

        return PolicyDecision(True)

    def record_applied(self, incident_id: str, capability: str, target_id: str, sim_time: float) -> None:
        """Called by the caller only after `check()` allowed the call AND the tool actually
        executed — a rejected attempt costs nothing against the attempt budget."""
        key = (incident_id, capability, target_id)
        self._attempt_counts[key] = self._attempt_counts.get(key, 0) + 1
        self._last_applied_sim_time[key] = sim_time

    # ── check 2 ────────────────────────────────────────────────────────────────────────

    def _check_target(self, target_type: str, target_id: str) -> PolicyDecision | None:
        try:
            if target_type == "station":
                self.twin.stations[target_id]
            elif target_type == "connector":
                station_id, _, connector_id = target_id.partition("/")
                self.twin.stations[station_id].connectors[connector_id]
            elif target_type == "component":
                station_id, _, component_name = target_id.partition(".")
                self.twin.stations[station_id].components[component_name]
            elif target_type == "station_or_connector":
                # Escalation tools receive `incident.target` verbatim, and an incident's
                # target is a station id for a station/component-level incident
                # (COMPONENT_FAILURE, COMMUNICATION_LOSS) or "<station>/<connector>" for a
                # connector-level one (CHARGER_FAULT, SESSION_FAILURES) — the same tool call has
                # to be valid at either level, or the harness's own deterministic forced-
                # escalation path (which always passes incident.target) fails silently
                # for every station-level incident. Found live: a real agent run repeatedly hit
                # INVALID_TARGET trying to escalate a COMPONENT_FAILURE/COMMUNICATION_LOSS
                # incident, and the guardrail-forced escalation meant to be the ultimate
                # fallback failed the exact same way.
                station_id, _, connector_id = target_id.partition("/")
                station = self.twin.stations[station_id]
                if connector_id:
                    station.connectors[connector_id]
        except KeyError:
            return PolicyDecision(
                False, INVALID_TARGET,
                f"target '{target_id}' does not exist for target_type '{target_type}'."
                + self._valid_targets_hint(target_type, target_id),
            )
        return None

    def _valid_targets_hint(self, target_type: str, target_id: str) -> str:
        """A refusal must say WHAT is wrong, not merely that something is — the agent has to
        be able to adapt. A bare "does not exist" does not tell a model that guessed
        `subsystem="power"` that the component is called `power_module`; it guessed again and
        burned two more steps (observed live, twice). The names are already in the agent's own
        prompt, so this leaks nothing — it just puts them where the mistake was made."""
        station_id = target_id.partition("/")[0].partition(".")[0]
        station = self.twin.stations.get(station_id)
        if station is None:
            return f" Known stations: {', '.join(sorted(self.twin.stations))}."
        if target_type == "component":
            return f" {station_id}'s components are: {', '.join(station.components)}."
        if target_type == "connector":
            return f" {station_id}'s connectors are: {', '.join(station.connectors)}."
        return ""

    # ── property resolution shared by checks 3 and 4 ──────────────────────────────────

    def _resolve(self, target_type: str, target_id: str, property_path: str) -> Any:
        if property_path.startswith("station."):
            station_id = target_id.split("/")[0].split(".")[0]
            return self.twin.resolve(station_id, property_path)
        if target_type == "component":
            station_id, _, component_name = target_id.partition(".")
            obj: Any = self.twin.stations[station_id].components[component_name]
            for part in property_path.split("."):
                obj = obj[part] if isinstance(obj, dict) else getattr(obj, part)
            return obj
        return self.twin.resolve(target_id, property_path)

    # ── checks 3 and 4 ─────────────────────────────────────────────────────────────────

    def _check_predicates(self, capability: str, entry: dict, target_id: str,
                           key: str, reason: str) -> PolicyDecision | None:
        for predicate in entry.get(key, []):
            observed = self._resolve(entry["target_type"], target_id, predicate["property"])
            if not apply_op(predicate["op"], observed, predicate["value"]):
                return PolicyDecision(
                    False, reason,
                    f"{capability} requires {predicate['property']} {predicate['op']} "
                    f"{predicate['value']}; {target_id} observed {observed}.",
                    constraint=f"{predicate['property']} {predicate['op']} {predicate['value']}",
                    observed=observed,
                )
        return None

    def _check_preconditions(self, capability: str, entry: dict, target_id: str) -> PolicyDecision | None:
        return self._check_predicates(capability, entry, target_id, "preconditions", PRECONDITION_FAILED)

    def _check_safety(self, capability: str, entry: dict, target_id: str) -> PolicyDecision | None:
        return self._check_predicates(capability, entry, target_id, "safety_constraints", SAFETY_CONSTRAINT_VIOLATED)

    # ── checks 5 and 6 ─────────────────────────────────────────────────────────────────

    def _check_limits(self, incident_id: str, capability: str, target_id: str,
                       entry: dict, sim_time: float) -> PolicyDecision:
        limits = entry.get("limits", {})
        key = (incident_id, capability, target_id)

        max_attempts = limits.get("max_attempts")
        if max_attempts is not None and self._attempt_counts.get(key, 0) >= max_attempts:
            return PolicyDecision(
                False, ATTEMPT_LIMIT_REACHED,
                f"{capability} on {target_id} has reached its limit of {max_attempts} "
                f"attempts for incident {incident_id}.",
                constraint=f"max_attempts={max_attempts}", observed=self._attempt_counts.get(key, 0),
            )

        cooldown = limits.get("cooldown_sim_seconds")
        if cooldown is not None:
            last = self._last_applied_sim_time.get(key)
            if last is not None and sim_time - last < cooldown:
                return PolicyDecision(
                    False, COOLDOWN_ACTIVE,
                    f"{capability} on {target_id} is on cooldown for "
                    f"{cooldown - (sim_time - last):.0f} more sim-seconds.",
                    constraint=f"cooldown_sim_seconds={cooldown}", observed=sim_time - last,
                )

        return PolicyDecision(True)

    # ── check 7 ────────────────────────────────────────────────────────────────────────

    def _check_transition(self, capability: str, target_id: str, params: dict) -> PolicyDecision | None:
        if capability == _RESET_CONNECTOR:
            entity_type, current, new_state = "connector", self._resolve("connector", target_id, "status"), "AVAILABLE"
        elif capability == _RESTART_COMPONENT:
            entity_type, current, new_state = "component", self._resolve("component", target_id, "health"), "HEALTHY"
        elif capability == _SET_CONNECTOR_AVAILABILITY:
            entity_type = "connector"
            current = self._resolve("connector", target_id, "status")
            new_state = "AVAILABLE" if params.get("available", True) else "UNAVAILABLE"
            # FAULTED -> AVAILABLE must be reachable ONLY through a successful
            # reset_connector plus a passing verification. The raw connector transition table
            # allows FAULTED -> AVAILABLE directly, because `set_connector_availability`
            # legitimately uses that same edge to restore a connector that was only ever
            # UNAVAILABLE (e.g. `return-to-service`) -- the table can't distinguish the two
            # calls by state alone. This is the one place this validator adds a rule beyond raw
            # legality: `set_connector_availability` may never be the tool that clears a FAULTED
            # connector, because it carries none of reset_connector's safety constraint
            # (temperature < 55 °C) or attempt limit -- unchecked, it is a "force the connector
            # online without repairing anything" shortcut, exactly what a scenario's
            # `forbidden_actions` list is supposed to catch, and it must actually be
            # unavailable, not just discouraged, or the check has nothing behind it.
            if current == "FAULTED" and new_state == "AVAILABLE":
                return PolicyDecision(
                    False, ILLEGAL_TRANSITION,
                    f"{capability} cannot clear a FAULTED connector; use reset_connector, "
                    f"which carries the temperature safety constraint this tool does not.",
                    constraint=f"{entity_type}: {current} -> {new_state}", observed=current,
                )
        else:
            # Only non-ACTION capabilities reach here — ESCALATION tools have no target-state
            # effect to pre-validate. `__init__` guarantees no ACTION can reach here.
            return None

        try:
            transition(entity_type, target_id, current, new_state)
        except IllegalTransition:
            return PolicyDecision(
                False, ILLEGAL_TRANSITION,
                f"{capability} would move {target_id} from {current} to {new_state}, "
                f"which is not a legal transition.",
                constraint=f"{entity_type}: {current} -> {new_state}", observed=current,
            )
        return None
