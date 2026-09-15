"""The golden-run recorder — a durable record of a finished run, and demo insurance.

A recorded run is an ordered `(sim_time, kind, payload)` log: every event touching the
incident's station (already durable in `EventStore`) merged with every tool call the
harness made (`AgentHarness`'s own `tool_log`, already sim_time-stamped per entry). Replay does
not re-simulate anything and calls no model — `POST /runs/{run_id}/replay` (`api/app.py`) hands
this log back whole, and it is the *frontend's* job to play it back at the recorded sim-time
pacing (the frontend's poll-driven rendering already consumes a growing `tool_log` from a
live run; a replay is the same consumption pattern against a static array instead).

Stored in its own SQLite file (`config.GOLDEN_RUNS_DB_PATH`), never the one `POST /world/reset`
deletes -- see that constant's own comment for why a "your insurance was in the thing you just
reset" bug would defeat the entire point of recording it.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from typing import Any

from backend.pipeline.events import Event
from backend.pipeline.incident import Incident
from backend.pipeline.store import EventStore

_SCHEMA = """
CREATE TABLE IF NOT EXISTS golden_runs (
    run_id TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL,
    scenario_id TEXT,
    outcome TEXT NOT NULL,
    recorded_at_wall TEXT NOT NULL,
    log_json TEXT NOT NULL
);
"""


def _station_of(source: str) -> str:
    """`"ST-02/C02"` and `"ST-02.cooling"` -> `"ST-02"`; a bare station id is already one.
    Same rule as `Verifier._station_of` -- duplicated rather than imported so this module (owned
    by `pipeline/`) never depends on `agent/`, per the layout's one-way dependency direction."""
    return source.partition("/")[0].partition(".")[0]


def build_recorded_log(*, incident: Incident, tool_log: list[dict[str, Any]],
                        event_store: EventStore) -> list[dict[str, Any]]:
    """Merge every event for the incident's station with every tool-log entry, sorted by
    `sim_time`. Both halves already carry a `sim_time`; nothing here re-derives one."""
    station_id = _station_of(incident.target)
    entries: list[dict[str, Any]] = []

    for event in event_store.all():
        if _station_of(event.source) != station_id:
            continue
        entries.append({
            "sim_time": event.sim_time, "kind": "EVENT",
            "payload": {
                "event_id": event.event_id, "type": event.type, "source": event.source,
                "previous_state": event.previous_state, "new_state": event.new_state,
                "severity": event.severity, "metadata": event.metadata,
            },
        })

    for entry in tool_log:
        entries.append({
            "sim_time": entry.get("sim_time", 0.0), "kind": "TOOL_CALL", "payload": entry,
        })

    entries.sort(key=lambda e: e["sim_time"])
    return entries


class GoldenRunStore:
    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def save(self, *, run_id: str, incident: Incident, scenario_id: str | None,
              log: list[dict[str, Any]]) -> None:
        self._conn.execute(
            """INSERT INTO golden_runs VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(run_id) DO UPDATE SET
                   incident_id = excluded.incident_id, scenario_id = excluded.scenario_id,
                   outcome = excluded.outcome, recorded_at_wall = excluded.recorded_at_wall,
                   log_json = excluded.log_json""",
            (
                run_id, incident.incident_id, scenario_id, incident.status,
                datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), json.dumps(log),
            ),
        )
        self._conn.commit()

    def get(self, run_id: str) -> dict[str, Any] | None:
        row = self._conn.execute(
            "SELECT run_id, incident_id, scenario_id, outcome, recorded_at_wall, log_json "
            "FROM golden_runs WHERE run_id = ?", (run_id,),
        ).fetchone()
        if row is None:
            return None
        run_id_, incident_id, scenario_id, outcome, recorded_at, log_json = row
        return {
            "run_id": run_id_, "incident_id": incident_id, "scenario_id": scenario_id,
            "outcome": outcome, "recorded_at": recorded_at, "log": json.loads(log_json),
        }

    def list_summaries(self) -> list[dict[str, Any]]:
        rows = self._conn.execute(
            "SELECT run_id, incident_id, scenario_id, outcome, recorded_at_wall "
            "FROM golden_runs ORDER BY recorded_at_wall DESC",
        ).fetchall()
        return [
            {"run_id": r[0], "incident_id": r[1], "scenario_id": r[2], "outcome": r[3],
             "recorded_at": r[4]}
            for r in rows
        ]

    def next_run_number(self) -> int:
        """Found live during a hardening sweep: `AppState._run_ids` restarts at 1 on every
        `build_state()` (every `/scenarios/run`, every `/world/reset`), so without this every
        scenario run's agent is "RUN-001" again and this store's `run_id` primary key makes each
        new recording silently overwrite the last -- 20 hardening runs left exactly one row
        behind. `build_state()` seeds its run-id counter from this instead of restarting at 1,
        so ids stay unique for the life of this durable store, not just one `AppState`."""
        max_n = 0
        for (run_id,) in self._conn.execute("SELECT run_id FROM golden_runs"):
            try:
                max_n = max(max_n, int(run_id.rsplit("-", 1)[-1]))
            except ValueError:
                continue
        return max_n + 1


def connect(path: str) -> sqlite3.Connection:
    """`path` is a filesystem path (`config.GOLDEN_RUNS_DB_PATH`) or `":memory:"` for tests."""
    conn = sqlite3.connect(path)
    conn.execute(_SCHEMA)
    conn.commit()
    return conn
