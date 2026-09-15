"""The HTTP surface and the snapshot builder. Nothing imports this package.

`app.py` owns the FastAPI application: the world snapshot endpoint the frontend renders
from, fault injection and scenario endpoints, the tick loop, and the incident watcher that
starts an agent run when an incident opens.

Agent tools are internal Python calls, NOT HTTP endpoints.
"""
