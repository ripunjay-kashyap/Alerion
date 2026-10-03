"""In-process pub/sub feeding the SSE endpoint.

Single Render instance + single worker, so an in-memory fan-out is sufficient.
The frontend treats events as invalidation hints and refetches /api/state.
"""

import asyncio
import json
from typing import Any


class EventBus:
    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue[str]] = set()

    def subscribe(self) -> asyncio.Queue[str]:
        q: asyncio.Queue[str] = asyncio.Queue(maxsize=500)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue[str]) -> None:
        self._subscribers.discard(q)

    def publish(self, event: str, data: dict[str, Any] | None = None) -> None:
        payload = json.dumps({"event": event, "data": data or {}}, default=str)
        for q in list(self._subscribers):
            try:
                q.put_nowait(payload)
            except asyncio.QueueFull:
                # slow client: drop it, it will reconnect and refetch
                self._subscribers.discard(q)


bus = EventBus()
