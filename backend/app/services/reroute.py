"""Live adaptation: when hazards change, invalidate unsafe active routes and recalculate.

Safety-critical and latency-critical → deterministic backend logic (actor: safety-monitor).
"""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    ApprovalAction,
    Assignment,
    AssignmentStatus,
    Hazard,
    Report,
    ReportStatus,
    Volunteer,
    VolunteerStatus,
)
from app.services import audit, routing, safety
from app.services.audit import Actor
from app.services.workflow import _apply_new_route, _request_approval, _set_status, active_hazards

WATCHED = [AssignmentStatus.ACTIVE, AssignmentStatus.AWAITING_APPROVAL]


async def set_hazard_active(session: AsyncSession, hazard: Hazard, active: bool, actor: Actor) -> list[str]:
    if hazard.active == active:
        return []
    hazard.active = active
    audit.record(
        session,
        actor=actor,
        event_type="HAZARD_ACTIVATED" if active else "HAZARD_DEACTIVATED",
        message=f"{hazard.id} {hazard.label} {'activated' if active else 'deactivated'} by {actor.id}",
        entity_type="hazard",
        entity_id=hazard.id,
    )
    audit.emit(session, "hazard.updated", hazard_id=hazard.id)
    return await revalidate_routes(session, trigger=hazard) if active else []


async def revalidate_routes(session: AsyncSession, trigger: Hazard | None = None) -> list[str]:
    """Check every live route against active hazards; reroute the unsafe ones. Returns affected assignment ids."""
    hazards = await active_hazards(session)
    q = select(Assignment).where(Assignment.status.in_(WATCHED))
    affected = []
    for asg in (await session.scalars(q)).all():
        if not asg.route_geometry:
            continue
        check = safety.check_route(asg.route_geometry, hazards)
        if check.safe:
            continue
        affected.append(asg.id)
        await _reroute(session, asg, check, hazards)
    return affected


async def _reroute(
    session: AsyncSession, asg: Assignment, check: safety.SafetyResult, hazards: list[Hazard]
) -> None:
    report = await session.get(Report, asg.report_id)
    vol = await session.get(Volunteer, asg.volunteer_id)
    prior_status = asg.status
    old_eta = asg.route_eta_seconds
    asg.status = AssignmentStatus.REROUTING
    audit.record(
        session,
        actor=audit.SAFETY,
        event_type="ROUTE_INVALIDATED",
        message=f"{asg.id} ({vol.id}) route invalidated: {check.reason}",
        entity_type="assignment",
        entity_id=asg.id,
        report_id=report.id,
        input_snapshot={"hazard_id": check.hazard_id, "previous_eta_seconds": old_eta},
    )
    s = await routing.find_safe_route(
        (vol.longitude, vol.latitude), (report.longitude, report.latitude), hazards
    )
    if s.found:
        _apply_new_route(asg, s)
        asg.status = prior_status
        audit.record(
            session,
            actor=audit.SAFETY,
            event_type="ROUTE_RECALCULATED",
            message=f"Safe route recalculated for {vol.id}: ETA {old_eta / 60:.0f} min → {s.eta_seconds / 60:.0f} min "
            f"({s.strategy})",
            entity_type="assignment",
            entity_id=asg.id,
            report_id=report.id,
            output_snapshot={**s.summary(), "previous_eta_seconds": old_eta},
        )
        audit.emit(
            session,
            "assignment.updated",
            reason="route_invalidated",
            report_id=report.id,
            assignment_id=asg.id,
            volunteer_id=vol.id,
            hazard_id=check.hazard_id,
            previous_eta_seconds=old_eta,
            new_eta_seconds=s.eta_seconds,
        )
        return

    asg.status = AssignmentStatus.FAILED
    vol.status = VolunteerStatus.IDLE
    _set_status(session, report, ReportStatus.TRIAGED)
    audit.record(
        session,
        actor=audit.SAFETY,
        event_type="ASSIGNMENT_FAILED",
        message=f"No safe route for {vol.id} after {check.hazard_id}: {s.error}. Escalating to dispatcher.",
        entity_type="assignment",
        entity_id=asg.id,
        report_id=report.id,
        output_snapshot=s.summary(),
    )
    await _request_approval(
        session,
        report,
        None,
        ApprovalAction.ESCALATION,
        f"No safe route for {vol.id} after {check.hazard_id} — approve to re-dispatch with another volunteer",
        None,
    )
    audit.emit(
        session,
        "assignment.updated",
        reason="route_invalidated",
        report_id=report.id,
        assignment_id=asg.id,
        volunteer_id=vol.id,
        hazard_id=check.hazard_id,
        previous_eta_seconds=old_eta,
        new_eta_seconds=None,
    )
