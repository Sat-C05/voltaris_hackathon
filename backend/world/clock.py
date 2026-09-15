"""The clock.

One instance, owned by world/, created at world reset. Only the tick loop calls `tick()`.

    The world runs on simulated time. The harness runs on wall-clock time. They never mix.

`time.time()` / `datetime.now()` never appear here, or anywhere in world/ — those live only
in the agent harness's wall-clock timeout. `now()` is a float count of simulated
seconds since world reset.
"""

from __future__ import annotations

from backend import config


class Clock:
    """Sim time only. `scale` is settable at runtime for demo pacing (`POST /clock/scale`)
    but changing it must never alter a threshold, cooldown or duration — it only changes how
    much wall-clock time a tick consumes, never how much sim time it advances. `tick()` always
    advances by the fixed `TICK_SIM_SECONDS`.
    """

    def __init__(self) -> None:
        self._sim_time: float = 0.0
        self.scale: float = config.SIM_TIME_SCALE
        self.running: bool = False

    def now(self) -> float:
        return self._sim_time

    def tick(self) -> float:
        self._sim_time += config.TICK_SIM_SECONDS
        return self._sim_time

    @property
    def tick_interval_real(self) -> float:
        """Wall-clock seconds per tick at the current `scale`. Derived, never stored — at the
        base scale (config.SIM_TIME_SCALE) this equals config.TICK_INTERVAL_REAL exactly."""
        return config.TICK_SIM_SECONDS / self.scale

    def reset(self) -> None:
        self._sim_time = 0.0
        self.running = False
