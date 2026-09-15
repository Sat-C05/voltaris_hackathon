"""EV Autonomous NOC — a single backend process, five modules, logical separation only.

Dependency direction:

    api ──▶ agent ──▶ world
     │        │
     └────────┴──▶ pipeline ──▶ world

world/ imports nothing from the others. pipeline/ imports only world/. Nothing imports api/.
"""
