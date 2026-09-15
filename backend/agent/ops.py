"""The comparison operators used by preconditions, safety constraints and verifier
goals/constraints — one small shared vocabulary so `PolicyValidator` and
`Verifier` never invent two different readings of `"in"` or `"<"`.
"""

from __future__ import annotations

from typing import Any, Callable

OPS: dict[str, Callable[[Any, Any], bool]] = {
    "equals": lambda observed, value: observed == value,
    "not_equals": lambda observed, value: observed != value,
    "in": lambda observed, value: observed in value,
    "not_in": lambda observed, value: observed not in value,
    "<": lambda observed, value: observed < value,
    "<=": lambda observed, value: observed <= value,
    ">": lambda observed, value: observed > value,
    ">=": lambda observed, value: observed >= value,
}


def apply_op(op: str, observed: Any, value: Any) -> bool:
    return OPS[op](observed, value)
