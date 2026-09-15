"""The in-process event bus.

    event_bus.publish(event)

No Kafka, RabbitMQ, or NATS — the transport is what gets simplified, not the concept: events
stay first-class objects with a stable schema (`events.Event`), a store (`store.EventStore`),
and identity (`event_id`). Subscribers run synchronously, in registration order, on the same
call stack as `publish()` — there is one asyncio event loop in this project and no
cross-thread handoff to coordinate.
"""

from __future__ import annotations

from typing import Callable

from backend.pipeline.events import Event

Subscriber = Callable[[Event], None]


class EventBus:
    def __init__(self) -> None:
        self._subscribers: list[Subscriber] = []

    def subscribe(self, callback: Subscriber) -> None:
        self._subscribers.append(callback)

    def publish(self, event: Event) -> None:
        for callback in self._subscribers:
            callback(event)
