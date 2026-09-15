"""Wires the bus, stores, processor and incident manager together, and hands back the single
`on_event` callback `world.Simulator` is constructed with.

The simulator never imports `pipeline/` — `on_event` is a constructor argument for exactly
this reason. Everything downstream of that callback lives here and in the modules it calls.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from backend.pipeline.event_bus import EventBus
from backend.pipeline.events import EventIdSequence, make_event
from backend.pipeline.incident import ActiveRunLock, IncidentManager
from backend.pipeline.processor import EventProcessor
from backend.pipeline.store import EventStore, IncidentStore, connect


@dataclass
class Pipeline:
    bus: EventBus
    event_store: EventStore
    incident_store: IncidentStore
    incidents: IncidentManager
    processor: EventProcessor
    on_event: Callable[..., None]


def build_pipeline(db_path: str, twin=None) -> Pipeline:
    """`db_path` is a filesystem path (`config.DB_PATH` in the running app) or `":memory:"`
    for tests — see `store.connect()`.

    `twin` is optional and read-only here: admission control consults it only to skip opening
    new incidents against a station already under a maintenance hold
    (`EventProcessor._suppressed`). Callers that don't pass one get the pre-existing behaviour
    exactly. This does not reverse the dependency direction — `pipeline/` may read
    `world/`; it is `world/` that must never import `pipeline/`."""
    conn = connect(db_path)
    event_store = EventStore(conn)
    incident_store = IncidentStore(conn)

    bus = EventBus()
    bus.subscribe(event_store.insert)

    incidents = IncidentManager(incident_store, run_lock=ActiveRunLock())
    processor = EventProcessor(incidents, twin=twin)
    bus.subscribe(processor.handle)

    id_seq = EventIdSequence()

    def on_event(sim_time: float, event_type: str, **fields: Any) -> None:
        event = make_event(id_seq, sim_time, event_type, **fields)
        bus.publish(event)

    return Pipeline(
        bus=bus, event_store=event_store, incident_store=incident_store,
        incidents=incidents, processor=processor, on_event=on_event,
    )
