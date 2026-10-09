"""Product API consumed by the operator dashboard. Contract: docs/api-contract.md."""

import asyncio

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sse_starlette.sse import EventSourceResponse

from app import simulator
from app.config import get_settings
from app.db import get_session
from app.events import bus
from app.models import (
    Approval,
    Assignment,
    AuditEntry,
    Hazard,
    HazardKind,
    IntelSuggestion,
    Report,
    SystemState,
    Volunteer,
)
from app.orchestrator import pipeline
from app.schemas import (
    ApprovalOut,
    ApprovalRejectIn,
    ApprovalResolveIn,
    AssignmentOut,
    AuditOut,
    FacilitiesOut,
    HazardIn,
    HazardOut,
    IntelAcceptOut,
    IntelScanOut,
    IntelStatusOut,
    IntelSuggestionOut,
    ReportIn,
    ReportOut,
    ScenarioStartIn,
    ScenarioStatusOut,
    StateOut,
    SystemOut,
    SystemStats,
    VolunteerOut,
)
from app.services import audit, intel, reroute, serpapi, workflow
from app.services.seed import reset_operational_state
from app.services.uow import unit_of_work
from app.services.workflow import WorkflowError

router = APIRouter(prefix="/api")


@router.get("/health")
async def health() -> dict:
    return {"ok": True}


async def _system(session: AsyncSession) -> SystemOut:
    out = SystemOut.model_validate(await session.get(SystemState, 1))
    out.stats = SystemStats(**await workflow.stats(session))
    return out


@router.get("/state", response_model=StateOut)
async def get_state(session: AsyncSession = Depends(get_session)) -> StateOut:
    if session.bind.dialect.name == "postgresql":
        # one consistent snapshot across the six queries (no half-committed workflow steps)
        await session.connection(execution_options={"isolation_level": "REPEATABLE READ"})
    return StateOut(
        system=await _system(session),
        reports=(await session.scalars(select(Report).order_by(Report.created_at.desc()))).all(),
        volunteers=(await session.scalars(select(Volunteer).order_by(Volunteer.id))).all(),
        hazards=(await session.scalars(select(Hazard).order_by(Hazard.id))).all(),
        assignments=(await session.scalars(select(Assignment).order_by(Assignment.created_at))).all(),
        approvals=(await session.scalars(select(Approval).order_by(Approval.created_at.desc()))).all(),
        intel_suggestions=(
            await session.scalars(select(IntelSuggestion).order_by(IntelSuggestion.created_at.desc()))
        ).all(),
    )


# ---------------- reports


@router.post("/reports", response_model=ReportOut, status_code=201)
async def create_report(body: ReportIn) -> Report:
    async with unit_of_work() as s:
        report = await workflow.ingest_report(
            s,
            text=body.text,
            source_type=body.source,
            source_identifier=body.source_identifier,
            actor=audit.DISPATCHER,
        )
    if report.workflow_status == "RECEIVED":
        pipeline.kick(report.id)
    return report


@router.get("/reports", response_model=list[ReportOut])
async def list_reports(session: AsyncSession = Depends(get_session)):
    return (await session.scalars(select(Report).order_by(Report.created_at.desc()))).all()


@router.get("/reports/{report_id}", response_model=ReportOut)
async def get_report(report_id: str, session: AsyncSession = Depends(get_session)):
    return await workflow.get_report(session, report_id)


# ---------------- approvals


@router.get("/approvals", response_model=list[ApprovalOut])
async def list_approvals(session: AsyncSession = Depends(get_session)):
    return (await session.scalars(select(Approval).order_by(Approval.created_at.desc()))).all()


@router.post("/approvals/{approval_id}/approve", response_model=ApprovalOut)
async def approve(approval_id: str, body: ApprovalResolveIn | None = None):
    body = body or ApprovalResolveIn()
    async with unit_of_work() as s:
        appr, follow_up = await workflow.resolve_approval(
            s, approval_id, approve=True, note=body.note, corrections=body.corrections, actor=audit.DISPATCHER
        )
    if follow_up:
        pipeline.kick(follow_up)
    return appr


@router.post("/approvals/{approval_id}/reject", response_model=ApprovalOut)
async def reject(approval_id: str, body: ApprovalRejectIn | None = None):
    body = body or ApprovalRejectIn()
    async with unit_of_work() as s:
        appr, _ = await workflow.resolve_approval(
            s, approval_id, approve=False, note=body.note, corrections=None, actor=audit.DISPATCHER
        )
    return appr


@router.get("/reports/{report_id}/facilities", response_model=FacilitiesOut)
async def report_facilities(report_id: str, session: AsyncSession = Depends(get_session)):
    """Google Maps (SerpApi): hospitals for rescue and medical incidents, relief camps for food. Open ones first."""
    report = await workflow.get_report(session, report_id)
    return FacilitiesOut(report_id=report.id, **await intel.facilities(report))


# ---------------- intel (SerpApi evidence layer)


@router.get("/intel/status", response_model=IntelStatusOut)
async def intel_status():
    settings = get_settings()
    return IntelStatusOut(
        mode=settings.serpapi_mode,
        key_configured=bool(settings.serpapi_key),
        engines=["google_maps", "google_news", "google"],
        session_usage={
            "live_searches": serpapi.usage.live,
            "cache_hits": serpapi.usage.cached,
            "failed": serpapi.usage.failed,
            "by_engine": serpapi.usage.by_engine,
        },
        account=await serpapi.account(),
    )


@router.post("/intel/scan", response_model=IntelScanOut)
async def intel_scan():
    found = await intel.gather()  # SerpApi calls happen outside the unit-of-work lock
    async with unit_of_work() as s:
        summary = await intel.scan(s, found)
    async with unit_of_work() as s:
        q = select(IntelSuggestion).where(IntelSuggestion.status == "pending")
        pending = (await s.scalars(q.order_by(IntelSuggestion.created_at.desc()))).all()
    return IntelScanOut(**summary, suggestions=pending)


@router.get("/intel/suggestions", response_model=list[IntelSuggestionOut])
async def intel_suggestions(session: AsyncSession = Depends(get_session)):
    return (await session.scalars(select(IntelSuggestion).order_by(IntelSuggestion.created_at.desc()))).all()


@router.post("/intel/suggestions/{suggestion_id}/accept", response_model=IntelAcceptOut)
async def intel_accept(suggestion_id: str):
    async with unit_of_work() as s:
        sug, affected = await intel.accept(s, suggestion_id, audit.DISPATCHER)
        hazard = await s.get(Hazard, sug.hazard_id)
    return IntelAcceptOut(suggestion=sug, hazard=hazard, rerouted_assignments=affected)


@router.post("/intel/suggestions/{suggestion_id}/dismiss", response_model=IntelSuggestionOut)
async def intel_dismiss(suggestion_id: str):
    async with unit_of_work() as s:
        return await intel.dismiss(s, suggestion_id, audit.DISPATCHER)


# ---------------- hazards


@router.get("/hazards", response_model=list[HazardOut])
async def list_hazards(session: AsyncSession = Depends(get_session)):
    return (await session.scalars(select(Hazard).order_by(Hazard.id))).all()


@router.post("/hazards", response_model=HazardOut, status_code=201)
async def create_hazard(body: HazardIn):
    expected = "Polygon" if body.kind == HazardKind.FLOOD_ZONE else "LineString"
    if body.geometry.get("type") != expected:
        raise HTTPException(
            422, {"code": "invalid_geometry", "message": f"{body.kind} requires a {expected}"}
        )
    async with unit_of_work() as s:
        h = Hazard(
            kind=body.kind,
            type="flood" if body.kind == HazardKind.FLOOD_ZONE else "blocked",
            label=body.label,
            geometry=body.geometry,
            severity="high",
            active=False,
            source="operator",
        )
        s.add(h)
        await s.flush()
        await reroute.set_hazard_active(s, h, True, audit.DISPATCHER)
    return h


async def _toggle(hazard_id: str, active: bool) -> Hazard:
    async with unit_of_work() as s:
        h = await s.get(Hazard, hazard_id)
        if h is None:
            raise WorkflowError("not_found", f"Hazard {hazard_id} not found", 404)
        await reroute.set_hazard_active(s, h, active, audit.DISPATCHER)
    return h


@router.post("/hazards/{hazard_id}/activate", response_model=HazardOut)
async def activate_hazard(hazard_id: str):
    return await _toggle(hazard_id, True)


@router.post("/hazards/{hazard_id}/deactivate", response_model=HazardOut)
async def deactivate_hazard(hazard_id: str):
    return await _toggle(hazard_id, False)


# ---------------- volunteers & assignments


@router.get("/volunteers", response_model=list[VolunteerOut])
async def list_volunteers(session: AsyncSession = Depends(get_session)):
    return (await session.scalars(select(Volunteer).order_by(Volunteer.id))).all()


@router.get("/volunteers/{volunteer_id}", response_model=VolunteerOut)
async def get_volunteer(volunteer_id: str, session: AsyncSession = Depends(get_session)):
    v = await session.get(Volunteer, volunteer_id)
    if v is None:
        raise WorkflowError("not_found", f"Volunteer {volunteer_id} not found", 404)
    return v


@router.get("/assignments", response_model=list[AssignmentOut])
async def list_assignments(session: AsyncSession = Depends(get_session)):
    return (await session.scalars(select(Assignment).order_by(Assignment.created_at))).all()


@router.get("/assignments/{assignment_id}", response_model=AssignmentOut)
async def get_assignment(assignment_id: str, session: AsyncSession = Depends(get_session)):
    a = await session.get(Assignment, assignment_id)
    if a is None:
        raise WorkflowError("not_found", f"Assignment {assignment_id} not found", 404)
    return a


@router.post("/assignments/{assignment_id}/complete", response_model=AssignmentOut)
async def complete_assignment(assignment_id: str):
    async with unit_of_work() as s:
        return await workflow.complete_assignment(s, assignment_id, audit.DISPATCHER)


# ---------------- audit


@router.get("/audit", response_model=list[AuditOut])
async def list_audit(limit: int = 200, after_seq: int = 0, session: AsyncSession = Depends(get_session)):
    q = select(AuditEntry).where(AuditEntry.seq > after_seq).order_by(AuditEntry.seq).limit(min(limit, 1000))
    return (await session.scalars(q)).all()


@router.get("/audit/{entity_id}", response_model=list[AuditOut])
async def audit_for_entity(entity_id: str, session: AsyncSession = Depends(get_session)):
    q = (
        select(AuditEntry)
        .where((AuditEntry.entity_id == entity_id) | (AuditEntry.report_id == entity_id))
        .order_by(AuditEntry.seq)
    )
    return (await session.scalars(q)).all()


# ---------------- scenario


@router.post("/scenario/start", response_model=ScenarioStatusOut)
async def scenario_start(body: ScenarioStartIn | None = None):
    body = body or ScenarioStartIn()
    return await simulator.start(body.scenario_id, body.mode)


@router.post("/scenario/next", response_model=ScenarioStatusOut)
async def scenario_next():
    return await simulator.next_event()


@router.get("/scenario/status", response_model=ScenarioStatusOut)
async def scenario_status():
    return simulator.run.status_out()


@router.post("/scenario/reset")
async def reset_scenario() -> dict:
    simulator.stop()
    pipeline.bump_generation()
    async with unit_of_work() as s:
        await intel.clear(s)
        await reset_operational_state(s)
    bus.publish("system.reset")
    return {"ok": True}


# ---------------- realtime


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
