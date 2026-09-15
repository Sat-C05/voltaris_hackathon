"""The capability table — one source, two consumers.

`data/capabilities.json` is read by both the prompt renderer and `PolicyValidator`.
`IMPLEMENTED_TOOLS` is derived directly from `ToolExecutor`'s own public methods rather than
hand-listed, so the drift guard actually catches drift instead of merely restating the same
list twice under two names.
"""

from __future__ import annotations

import json
from pathlib import Path

from backend import config
from backend.agent.tools import ToolExecutor

IMPLEMENTED_TOOLS: frozenset[str] = frozenset(
    name for name, value in vars(ToolExecutor).items()
    if not name.startswith("_") and callable(value)
)


def load_capabilities(path: Path | None = None) -> dict:
    path = path or config.CAPABILITIES_FILE
    return json.loads(Path(path).read_text())


def assert_no_drift(capabilities: dict) -> None:
    """Ten lines: every implemented tool has a capability entry, and every
    capability entry has an implementation. Call once at startup — fail loud, not silently."""
    declared = set(capabilities.keys())
    implemented = set(IMPLEMENTED_TOOLS)
    assert declared == implemented, (
        "capabilities.json and ToolExecutor have drifted: "
        f"declared but not implemented: {sorted(declared - implemented)}; "
        f"implemented but not declared: {sorted(implemented - declared)}"
    )
