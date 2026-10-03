import os
import tempfile

# Isolated SQLite DB + offline Mapbox (seeded cache) — must be set before app modules import settings.
_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{_db.name}"
os.environ.setdefault("MAPBOX_MODE", "cache_only")
os.environ["ORCHESTRATION_MODE"] = "local"
os.environ["TOOLS_API_KEY"] = "test-key"

import httpx  # noqa: E402
import pytest  # noqa: E402

from app.db import Base, SessionLocal, create_all, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.orchestrator import local  # noqa: E402
from app.services.seed import seed_reference_data  # noqa: E402

local.STEP_DELAY_S = 0.0


@pytest.fixture
async def client():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
    await create_all()
    async with SessionLocal() as s:
        await seed_reference_data(s)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
    local.bump_generation()


TOOL_HEADERS = {"Authorization": "Bearer test-key"}


@pytest.fixture(scope="session", autouse=True)
async def _dispose_engine():
    yield
    await engine.dispose()  # aiosqlite worker threads otherwise keep the interpreter alive
