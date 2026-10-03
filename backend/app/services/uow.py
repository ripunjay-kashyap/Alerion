"""Unit of work: one serialized, committed transaction per workflow step.

Single instance + low volume → one global lock is the simplest way to rule out races
(two reports grabbing the same volunteer, Nuroen and fallback processing one report, etc.).
"""

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy.ext.asyncio import AsyncSession

from app.db import SessionLocal

_lock = asyncio.Lock()


@asynccontextmanager
async def unit_of_work() -> AsyncIterator[AsyncSession]:
    async with _lock, SessionLocal() as session:
        try:
            yield session
            await session.commit()
        except BaseException as exc:
            await session.rollback()
            entry = getattr(exc, "audit_entry", None)
            if entry:
                from app.services import audit

                audit.record(session, **entry)
                await session.commit()
            raise
