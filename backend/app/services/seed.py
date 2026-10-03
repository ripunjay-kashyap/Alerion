"""Seeding and scenario reset. Idempotent: safe to run on every boot."""

import json

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models import Approval, Assignment, AuditEntry, Hazard, Report, SystemState, Volunteer


def _load_json(name: str) -> dict | list:
    return json.loads((get_settings().seed_dir / name).read_text())


async def seed_reference_data(session: AsyncSession) -> None:
    """Upsert volunteers + hazards from seed files; ensure system_state row exists."""
    for v in _load_json("volunteers.json"):
        existing = await session.get(Volunteer, v["id"])
        fields = {
            **v,
            "home_latitude": v["latitude"],
            "home_longitude": v["longitude"],
            "home_available": v["available"],
            "status": "idle" if v["available"] else "offline",
        }
        if existing is None:
            session.add(Volunteer(**fields))
        else:
            for k, val in fields.items():
                setattr(existing, k, val)

    for f in _load_json("hazards.geojson")["features"]:
        p = f["properties"]
        existing = await session.get(Hazard, p["id"])
        fields = {
            "id": p["id"],
            "kind": p["kind"],
            "type": p["type"],
            "label": p["label"],
            "severity": p["severity"],
            "active": p["active"],
            "initially_active": p["active"],
            "detour_waypoints": p.get("detour_waypoints", []),
            "geometry": f["geometry"],
            "source": "seed",
        }
        if existing is None:
            session.add(Hazard(**fields))
        else:
            for k, val in fields.items():
                setattr(existing, k, val)

    if await session.get(SystemState, 1) is None:
        session.add(SystemState(id=1, orchestration_mode=get_settings().orchestration_mode))

    await session.commit()


async def reset_operational_state(session: AsyncSession) -> None:
    """Wipe runtime data and restore seeded world. Used by /api/scenario/reset."""
    for model in (AuditEntry, Approval, Assignment, Report):
        await session.execute(delete(model))
    # drop operator-created hazards, restore seeded ones
    await session.execute(delete(Hazard).where(Hazard.source != "seed"))
    for h in (await session.scalars(select(Hazard))).all():
        h.active = h.initially_active
    for v in (await session.scalars(select(Volunteer))).all():
        v.latitude, v.longitude = v.home_latitude, v.home_longitude
        v.available = v.home_available
        v.status = "idle" if v.home_available else "offline"
    state = await session.get(SystemState, 1)
    if state:
        state.scenario_status = "idle"
        state.scenario_run_id = None
    await session.commit()
