from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.config import get_settings


class Base(DeclarativeBase):
    pass


def _engine_kwargs(url: str) -> dict:
    if url.startswith("postgresql"):
        # Supabase pooler (Supavisor/pgbouncer) does not support asyncpg's prepared-statement cache.
        return {
            "pool_pre_ping": True,
            "pool_size": 5,
            "max_overflow": 5,
            "connect_args": {"statement_cache_size": 0},
        }
    return {}


settings = get_settings()
engine = create_async_engine(settings.database_url, **_engine_kwargs(settings.database_url))
SessionLocal = async_sessionmaker(engine, expire_on_commit=False)


async def get_session() -> AsyncIterator[AsyncSession]:
    async with SessionLocal() as session:
        yield session


async def create_all() -> None:
    from app import models  # noqa: F401  (register tables)

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
