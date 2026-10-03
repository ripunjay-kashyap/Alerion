import asyncio
import contextlib
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.routes import router as api_router
from app.config import get_settings
from app.db import SessionLocal, create_all
from app.orchestrator import local
from app.services.seed import seed_reference_data
from app.services.workflow import WorkflowError
from app.tools.app import tools_app

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await create_all()
    async with SessionLocal() as session:
        await seed_reference_data(session)
    watchdog = asyncio.create_task(local.watchdog())
    yield
    watchdog.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await watchdog


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title="Disaster Relief Router", version="0.2.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_origin_regex=r"https://.*\.vercel\.app",
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.exception_handler(WorkflowError)
    async def _workflow_error(_: Request, exc: WorkflowError) -> JSONResponse:
        return JSONResponse(status_code=exc.status, content={"detail": exc.detail()})

    app.include_router(api_router)
    app.mount("/tools", tools_app)

    @app.get("/")
    async def root() -> dict:
        return {"service": "disaster-relief-router", "docs": "/docs", "tools": "/tools/docs"}

    return app


app = create_app()
