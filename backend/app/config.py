from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = BACKEND_DIR.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=BACKEND_DIR / ".env", extra="ignore")

    # Database — Supabase pooler URI (postgresql+asyncpg://...) or sqlite+aiosqlite for local/tests
    database_url: str = "sqlite+aiosqlite:///./alerion.db"

    # Mapbox
    mapbox_token: str = ""
    mapbox_mode: Literal["live", "cache_first", "cache_only"] = "cache_first"

    # Nuroen-facing tool surface
    tools_api_key: str = "dev-tools-key"

    # Nuroen orchestration
    # local: backend auto-processes reports. nuroen: reports wait for pickup from Nuroen chat,
    # then fall back to local after the pickup timeout.
    orchestration_mode: Literal["nuroen", "local"] = "local"
    nuroen_pickup_timeout_s: int = 120
    nuroen_lease_extend_s: int = 30

    # HTTP
    cors_origins: str = "http://localhost:3000"

    # Paths
    seed_dir: Path = BACKEND_DIR / "seed"
    scenarios_dir: Path = REPO_DIR / "scenarios"
    policy_path: Path = BACKEND_DIR / "policy.yaml"

    @field_validator("database_url")
    @classmethod
    def _force_asyncpg(cls, v: str) -> str:
        # Accept the URI exactly as Supabase shows it; we always need the async driver.
        for prefix in ("postgresql://", "postgres://"):
            if v.startswith(prefix):
                return "postgresql+asyncpg://" + v[len(prefix) :]
        return v

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
