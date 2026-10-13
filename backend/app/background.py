import asyncio
import logging
from collections.abc import Coroutine
from typing import Any

log = logging.getLogger("meraki.bg")
_tasks: set[asyncio.Task] = set()


def spawn(coro: Coroutine[Any, Any, Any]) -> None:
    """Fire-and-forget with a strong reference and error logging."""
    task = asyncio.create_task(coro)
    _tasks.add(task)

    def _done(t: asyncio.Task) -> None:
        _tasks.discard(t)
        if not t.cancelled() and t.exception():
            log.error("background task failed", exc_info=t.exception())

    task.add_done_callback(_done)
