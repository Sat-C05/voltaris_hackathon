"""The simulated physical world. Imports nothing from pipeline/, agent/ or api/.

- `twin.py`        — the digital twin: stations, connectors, components, sessions.
- `clock.py`       — the simulated clock. The world runs on simulated time only.
- `simulator.py`   — the tick loop, the fault effect table, threshold evaluation, the
  session loop, and fault injection. Faults are injected into components and their
  consequences propagate; station state is never set directly.
- `transitions.py` — the legal state-transition tables for stations and connectors.
"""
