"""Events and incidents. Imports only from world/.

- `events.py`    — the event envelope and `severity_for()`.
- `event_bus.py` — the in-process pub/sub bus: `publish()`, `subscribe()`.
- `store.py`     — SQLite-backed `EventStore` and `IncidentStore`.
- `processor.py` — `EventProcessor`: admission control, log-only vs. incident-worthy.
- `incident.py`  — `Incident`, the correlation-key rule, and `ActiveRunLock`.
- `triage.py`    — severity and incident-type classification for incoming events.
- `golden_runs.py` — durable recording of finished agent runs, for replay.
- `wiring.py`    — `build_pipeline()`, which returns the `on_event` callback handed to
  `world.Simulator` at construction time — the one seam `world/` exposes to this package.
- `demo.py`      — a CLI walkthrough, runnable via `uv run python -m backend.pipeline.demo`.
"""
