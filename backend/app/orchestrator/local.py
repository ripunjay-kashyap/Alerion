"""Local orchestrator: the safe fallback pipeline + the Nuroen pickup watchdog.

Runs the exact same workflow steps the Nuroen agents call through /tools, with deterministic
intake/triage (fixtures + keyword rules) instead of LLM agents.
"""

import asyncio
import logging

from sqlalchemy import or_, select

from app.models import Orchestrator, Report, ReportStatus
from app.services import audit, workflow
from app.services.audit import local
from app.services.intake_fallback import extract
from app.services.uow import unit_of_work
from app.services.workflow import WorkflowError

log = logging.getLogger(__name__)

STEP_DELAY_S = 0.8  # pacing so the UI visibly walks through stages during the demo
_tasks: set[asyncio.Task] = set()
_generation = 0  # bumped on reset so stale tasks stop


def bump_generation() -> None:
    global _generation
    _generation += 1
    for t in list(_tasks):
        t.cancel()


def spawn(coro) -> asyncio.Task:
    t = asyncio.create_task(coro)
    _tasks.add(t)
    t.add_done_callback(_tasks.discard)
    return t


def kick(report_id: str) -> None:
    """Called after a report is committed (or handed to local)."""
    spawn(process_report(report_id))


async def process_report(report_id: str) -> None:
    gen = _generation
    actor_intake, actor_triage, actor_dispatch = local("intake"), local("triage"), local("dispatch")
    try:
        async with unit_of_work() as s:
            report = await workflow.get_report(s, report_id)
            status, raw = report.workflow_status, report.raw_text
            if report.orchestrator == Orchestrator.NUROEN:
                return
        intake, triage = extract(raw)

        if status in {ReportStatus.RECEIVED, ReportStatus.STRUCTURING}:
            await asyncio.sleep(STEP_DELAY_S)
            if gen != _generation:
                return
            async with unit_of_work() as s:
                res = await workflow.submit_intake(s, report_id, intake, actor_intake)
            if res["needs_review"]:
                return
            status = ReportStatus.STRUCTURED

        if status == ReportStatus.STRUCTURED:
            await asyncio.sleep(STEP_DELAY_S)
            if gen != _generation:
                return
            async with unit_of_work() as s:
                await workflow.submit_triage(s, report_id, triage, actor_triage)
            status = ReportStatus.TRIAGED

        if status == ReportStatus.TRIAGED:
            await asyncio.sleep(STEP_DELAY_S)
            if gen != _generation:
                return
            async with unit_of_work() as s:
                sel = await workflow.eligible_volunteers(s, report_id, actor_dispatch)
            if not sel["selected"]:
                async with unit_of_work() as s:
                    report = await workflow.get_report(s, report_id)
                    await workflow._request_approval(
                        s,
                        report,
                        None,
                        workflow.ApprovalAction.ESCALATION,
                        "No eligible volunteer with a safe route — dispatcher decision needed",
                        None,
                    )
                return
            await asyncio.sleep(STEP_DELAY_S / 2)
            if gen != _generation:
                return
            async with unit_of_work() as s:
                await workflow.propose_assignment(s, report_id, sel["selected"], None, actor_dispatch)
    except WorkflowError as e:
        if e.code not in {"report_owned_by_nuroen", "not_found"}:
            log.warning("local pipeline stopped for %s: %s", report_id, e.message)
    except asyncio.CancelledError:
        raise
    except Exception:
        log.exception("local pipeline crashed for %s", report_id)


async def watchdog(interval_s: float = 2.0) -> None:
    """Reports waiting for (or stalled in) Nuroen past their lease fall back to local processing."""
    while True:
        await asyncio.sleep(interval_s)
        try:
            taken: list[str] = []
            async with unit_of_work() as s:
                now = workflow._now()
                q = select(Report).where(
                    Report.workflow_status.in_(
                        [
                            ReportStatus.RECEIVED,
                            ReportStatus.STRUCTURING,
                            ReportStatus.STRUCTURED,
                            ReportStatus.TRIAGED,
                        ]
                    ),
                    or_(Report.orchestrator.is_(None), Report.orchestrator == Orchestrator.NUROEN),
                    Report.lease_until.is_not(None),
                )
                for r in (await s.scalars(q)).all():
                    lease = workflow._aware(r.lease_until)
                    if lease and lease < now:
                        waited = "pickup" if r.orchestrator is None else "progress"
                        r.orchestrator = Orchestrator.LOCAL
                        r.lease_until = None
                        audit.record(
                            s,
                            actor=audit.SYSTEM,
                            event_type="FALLBACK_ACTIVATED",
                            message=f"Nuroen {waited} timed out for {r.id} — using local safe fallback workflow",
                            entity_type="report",
                            entity_id=r.id,
                            report_id=r.id,
                        )
                        taken.append(r.id)
                if taken:
                    state = await workflow.system_state(s)
                    state.nuroen_status = "degraded"
                    audit.emit(s, "system.updated", reason="fallback_activated", report_ids=taken)
            for rid in taken:
                kick(rid)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("watchdog iteration failed")


async def force_local(report_id: str) -> None:
    async with unit_of_work() as s:
        r = await workflow.get_report(s, report_id)
        if r.workflow_status not in {
            ReportStatus.RECEIVED,
            ReportStatus.STRUCTURING,
            ReportStatus.STRUCTURED,
            ReportStatus.TRIAGED,
        }:
            raise WorkflowError("invalid_transition", f"{r.id} is {r.workflow_status}; nothing to process")
        r.orchestrator, r.lease_until = Orchestrator.LOCAL, None
        audit.record(
            s,
            actor=audit.DISPATCHER,
            event_type="FALLBACK_ACTIVATED",
            message=f"Dispatcher forced local processing of {r.id}",
            entity_type="report",
            entity_id=r.id,
            report_id=r.id,
        )
    kick(report_id)
