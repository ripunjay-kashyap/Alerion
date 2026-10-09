"""Report pipeline: runs every new report through intake → triage → dispatch.

Each stage calls the same workflow steps as the operator API, with deterministic
intake/triage (scenario fixtures + keyword rules).
"""

import asyncio
import logging

from app.models import ReportStatus
from app.services import audit, intel, workflow
from app.services.intake import extract
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
    """Called after a report is committed, or when a dispatcher approval hands it back."""
    spawn(process_report(report_id))


async def process_report(report_id: str) -> None:
    gen = _generation
    actor_intake, actor_triage, actor_dispatch = (
        audit.stage("intake"),
        audit.stage("triage"),
        audit.stage("dispatch"),
    )
    try:
        async with unit_of_work() as s:
            report = await workflow.get_report(s, report_id)
            status, raw, source = report.workflow_status, report.raw_text, report.source_type
        intake, triage = extract(raw)

        if status == ReportStatus.RECEIVED:
            await intel.prefetch(intake.location_text, raw, source)  # SerpApi off the global lock
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
        if e.code != "not_found":
            log.warning("pipeline stopped for %s: %s", report_id, e.message)
    except asyncio.CancelledError:
        raise
    except Exception:
        log.exception("pipeline crashed for %s", report_id)
