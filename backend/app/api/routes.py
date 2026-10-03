"""Product API consumed by the operator dashboard."""

import asyncio

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sse_starlette.sse import EventSourceResponse

from app.config import get_settings
from app.db import get_session
from app.events import bus
from app.models import Approval, Assignment, AuditEntry, Hazard, Report, SystemState, Volunteer
from app.schemas import (
    AuditOut,
    HazardOut,
    StateOut,
    SystemOut,
    VolunteerOut,
)
from app.services.seed import reset_operational_state

router = APIRouter(prefix="/api")


@router.get("/health")
async def health() -> dict:
    return {"ok": True}


async def _system(session: AsyncSession) -> SystemOut:
    state = await session.get(SystemState, 1)
    out = SystemOut.model_validate(state)
    out.nuroen_configured = get_settings().nuroen_configured
    return out


@router.get("/state", response_model=StateOut)
async def get_state(session: AsyncSession = Depends(get_session)) -> StateOut:
    return StateOut(
        system=await _system(session),
        reports=(await session.scalars(select(Report).order_by(Report.created_at.desc()))).all(),
        volunteers=(await session.scalars(select(Volunteer).order_by(Volunteer.id))).all(),
        hazards=(await session.scalars(select(Hazard).order_by(Hazard.id))).all(),
        assignments=(await session.scalars(select(Assignment).order_by(Assignment.created_at))).all(),
        approvals=(await session.scalars(select(Approval).order_by(Approval.created_at.desc()))).all(),
    )


@router.get("/volunteers", response_model=list[VolunteerOut])
async def list_volunteers(session: AsyncSession = Depends(get_session)):
    return (await session.scalars(select(Volunteer).order_by(Volunteer.id))).all()


@router.get("/volunteers/{volunteer_id}", response_model=VolunteerOut)
async def get_volunteer(volunteer_id: str, session: AsyncSession = Depends(get_session)):
    v = await session.get(Volunteer, volunteer_id)
    if v is None:
        raise HTTPException(404, "volunteer not found")
    return v


@router.get("/hazards", response_model=list[HazardOut])
async def list_hazards(session: AsyncSession = Depends(get_session)):
    return (await session.scalars(select(Hazard).order_by(Hazard.id))).all()


@router.get("/audit", response_model=list[AuditOut])
async def list_audit(
    limit: int = 200, after_seq: int = 0, session: AsyncSession = Depends(get_session)
):
    q = select(AuditEntry).where(AuditEntry.seq > after_seq).order_by(AuditEntry.seq).limit(limit)
    return (await session.scalars(q)).all()


@router.get("/audit/{entity_id}", response_model=list[AuditOut])
async def audit_for_entity(entity_id: str, session: AsyncSession = Depends(get_session)):
    q = (
        select(AuditEntry)
        .where((AuditEntry.entity_id == entity_id) | (AuditEntry.report_id == entity_id))
        .order_by(AuditEntry.seq)
    )
    return (await session.scalars(q)).all()


@router.post("/scenario/reset")
async def reset_scenario(session: AsyncSession = Depends(get_session)) -> dict:
    await reset_operational_state(session)
    bus.publish("system.reset")
    return {"ok": True}


@router.get("/events")
async def events(request: Request):
    async def stream():
        q = bus.subscribe()
        try:
            yield {"event": "hello", "data": "{}"}
            while True:
                if await request.is_disconnected():
                    break
                try:
                    payload = await asyncio.wait_for(q.get(), timeout=15)
                    yield {"event": "message", "data": payload}
                except TimeoutError:
                    yield {"event": "ping", "data": "{}"}
        finally:
            bus.unsubscribe(q)

    return EventSourceResponse(stream())
