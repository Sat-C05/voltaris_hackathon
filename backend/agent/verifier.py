"""Verification, structurally enforced.

A tool returning `success: true` asserts the command was accepted, not that the system is
healthy. The agent can only `propose_resolution(evidence)`; this module is what the harness
runs against **live twin state** in response — the agent has no path to writing `RESOLVED`
itself.

`goals` and `constraints` are `{"target", "property", "op", "value"}` predicates in the same
shape as a capability's `preconditions`/`safety_constraints`, so `Verifier` and
`PolicyValidator` share the same `apply_op()` vocabulary. A scenario supplies them from its
`success_criteria`; other callers pass them in directly.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from backend.agent.ops import apply_op
from backend.pipeline.store import EventStore
from backend.world.twin import Twin


@dataclass
class VerificationResult:
    passed: bool
    failed_predicates: list[dict[str, Any]] = field(default_factory=list)


class Verifier:
    def __init__(self, twin: Twin, event_store: EventStore) -> None:
        self.twin = twin
        self.event_store = event_store

    @staticmethod
    def _station_of(source: str) -> str:
        """`"ST-02/C02"` and `"ST-02.cooling"` -> `"ST-02"`; a station source is already one."""
        return source.partition("/")[0].partition(".")[0]

    def verify(self, *, goals: list[dict], constraints: list[dict], since_sim_time: float,
               station_id: str | None = None) -> VerificationResult:
        """Goals and constraints must hold against live state, AND no new HIGH-severity
        event may have landed since the action being verified — a event landing during the
        settle window means something changed underneath the recovery, and that recovery is
        not verified.

        `station_id` scopes that second check to the station being recovered. Without it the
        check reads the whole world: a second station faulting during this station's settle
        window fails a recovery that in fact succeeded, and the two stations invalidate each
        other's verifications indefinitely. Optional, so a caller verifying a single-station
        world keeps the unscoped behaviour."""
        failed: list[dict[str, Any]] = []

        for predicate in (*goals, *constraints):
            observed = self.twin.resolve(predicate["target"], predicate["property"])
            if not apply_op(predicate["op"], observed, predicate["value"]):
                failed.append({**predicate, "observed": observed})

        new_high_severity = [
            e for e in self.event_store.since(since_sim_time)
            if e.severity == "HIGH"
            and (station_id is None or self._station_of(e.source) == station_id)
        ]
        if new_high_severity:
            failed.append({
                "check": "no_new_high_severity_event",
                "observed": [e.type for e in new_high_severity],
            })

        return VerificationResult(passed=not failed, failed_predicates=failed)
