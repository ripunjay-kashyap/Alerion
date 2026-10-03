"""Drop and recreate all tables, then seed. DEV ONLY — wipes all data.

uv run python -m scripts.reset_db
"""

import asyncio

from app.db import Base, SessionLocal, create_all, engine
from app.services.seed import seed_reference_data


async def main() -> None:
    from app import models  # noqa: F401

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
    await create_all()
    async with SessionLocal() as s:
        await seed_reference_data(s)
    await engine.dispose()
    print(f"reset ok: {engine.url.host or engine.url.database}")


if __name__ == "__main__":
    asyncio.run(main())
