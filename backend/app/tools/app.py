"""Nuroen-facing tool surface.

Mounted as a separate FastAPI sub-app at /tools so it has its own clean OpenAPI
document (/tools/openapi.json) that Nuroen can import to generate agent skills.
Every operation: narrow, POST, flat JSON body, bearer-key auth.
"""

from fastapi import Depends, FastAPI, Header, HTTPException

from app.config import get_settings


async def require_tool_key(authorization: str = Header(default="")) -> None:
    expected = f"Bearer {get_settings().tools_api_key}"
    if authorization != expected:
        raise HTTPException(status_code=401, detail="invalid tool key")


tools_app = FastAPI(
    title="Disaster Relief Router — Agent Tools",
    version="0.1.0",
    description=(
        "Deterministic execution and safety tools for the Disaster Relief Router agents. "
        "All safety-critical decisions (eligibility, route safety, priority, policy) are made "
        "by these tools; agents must never override a tool refusal."
    ),
    dependencies=[Depends(require_tool_key)],
)


@tools_app.post("/ping", operation_id="ping", summary="Connectivity check for the agent connector")
async def ping() -> dict:
    return {"ok": True, "service": "disaster-relief-router"}
