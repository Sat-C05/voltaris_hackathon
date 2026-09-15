"""SQLite storage for events and incidents.

Worlds/scenarios/capabilities/protocol stay JSON files and the twin and clock stay in-memory,
both owned by `world/`. Events and incidents get a real database because both must survive
process restarts: `GET /events?since=` and the replay player read the append-only event log
back, and the incident table is the record of what the system actually did.
"""

from __future__ import annotations

import json
import sqlite3

from backend.pipeline.events import Event
from backend.pipeline.incident import Incident

_EVENTS_SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
    event_id TEXT PRIMARY KEY,
    sim_time REAL NOT NULL,
    wall_time TEXT NOT NULL,
    source TEXT NOT NULL,
    type TEXT NOT NULL,
    previous_state TEXT,
    new_state TEXT,
    severity TEXT NOT NULL,
    metadata TEXT NOT NULL
);
"""

_INCIDENTS_SCHEMA = """
CREATE TABLE IF NOT EXISTS incidents (
    incident_id TEXT PRIMARY KEY,
    target TEXT NOT NULL,
    type TEXT NOT NULL,
    severity TEXT NOT NULL,
    status TEXT NOT NULL,
    opened_sim_time REAL NOT NULL,
    trigger_events TEXT NOT NULL,
    agent_run_id TEXT,
    escalation_reason TEXT,
    closure_reason TEXT
);
"""


def connect(path: str) -> sqlite3.Connection:
    """`path` is a filesystem path (Contract: `config.DB_PATH`) or `":memory:"` for tests."""
    conn = sqlite3.connect(path)
    conn.execute(_EVENTS_SCHEMA)
    conn.execute(_INCIDENTS_SCHEMA)
    conn.commit()
    return conn


class EventStore:
    """Subscribed directly to the bus (`bus.subscribe(store.insert)`, see `wiring.py`) — every
    published event is persisted, log-only or incident-worthy alike, because admission control
    decides what wakes the agent, not what gets recorded."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def insert(self, event: Event) -> None:
        self._conn.execute(
            "INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                event.event_id, event.sim_time, event.wall_time, event.source, event.type,
                event.previous_state, event.new_state, event.severity,
                json.dumps(event.metadata),
            ),
        )
        self._conn.commit()

    def all(self) -> list[Event]:
        rows = self._conn.execute("SELECT * FROM events ORDER BY sim_time, event_id").fetchall()
        return [self._row_to_event(row) for row in rows]

    def since(self, sim_time: float) -> list[Event]:
        rows = self._conn.execute(
            "SELECT * FROM events WHERE sim_time > ? ORDER BY sim_time, event_id", (sim_time,),
        ).fetchall()
        return [self._row_to_event(row) for row in rows]

    def for_source(self, source: str, limit: int | None = None) -> list[Event]:
        query = "SELECT * FROM events WHERE source = ? ORDER BY sim_time DESC, event_id DESC"
        params: tuple = (source,)
        if limit is not None:
            query += " LIMIT ?"
            params = (source, limit)
        rows = self._conn.execute(query, params).fetchall()
        return [self._row_to_event(row) for row in rows]

    @staticmethod
    def _row_to_event(row: tuple) -> Event:
        (event_id, sim_time, wall_time, source, type_, previous_state, new_state,
         severity, metadata) = row
        return Event(
            event_id=event_id, sim_time=sim_time, wall_time=wall_time, source=source, type=type_,
            previous_state=previous_state, new_state=new_state, severity=severity,
            metadata=json.loads(metadata),
        )


class IncidentStore:
    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def upsert(self, incident: Incident) -> None:
        self._conn.execute(
            """INSERT INTO incidents VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(incident_id) DO UPDATE SET
                   status = excluded.status,
                   severity = excluded.severity,
                   trigger_events = excluded.trigger_events,
                   agent_run_id = excluded.agent_run_id,
                   escalation_reason = excluded.escalation_reason,
                   closure_reason = excluded.closure_reason""",
            (
                incident.incident_id, incident.target, incident.type, incident.severity,
                incident.status, incident.opened_sim_time,
                json.dumps(incident.trigger_events), incident.agent_run_id,
                incident.escalation_reason, incident.closure_reason,
            ),
        )
        self._conn.commit()

    def all(self) -> list[Incident]:
        rows = self._conn.execute("SELECT * FROM incidents ORDER BY opened_sim_time").fetchall()
        return [self._row_to_incident(row) for row in rows]

    def get(self, incident_id: str) -> Incident | None:
        row = self._conn.execute(
            "SELECT * FROM incidents WHERE incident_id = ?", (incident_id,)
        ).fetchone()
        return self._row_to_incident(row) if row else None

    @staticmethod
    def _row_to_incident(row: tuple) -> Incident:
        (incident_id, target, type_, severity, status, opened_sim_time,
         trigger_events, agent_run_id, escalation_reason, closure_reason) = row
        return Incident(
            incident_id=incident_id, target=target, type=type_, severity=severity, status=status,
            opened_sim_time=opened_sim_time, trigger_events=json.loads(trigger_events),
            agent_run_id=agent_run_id, escalation_reason=escalation_reason,
            closure_reason=closure_reason,
        )
