"""Deterministic scenario replay (timed or presenter-driven manual mode)."""

import asyncio
import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import select

from app.config import get_settings
from app.models import Hazard
from app.orchestrator import pipeline
from app.services import audit, reroute, workflow
from app.services.uow import unit_of_work
from app.services.workflow import WorkflowError

log = logging.getLogger(__name__)


@dataclass
class ScenarioRun:
    scenario_id: str | None = None
    mode: str = "timed"
    status: str = "idle"  # idle | running | done
    events: list[dict[str, Any]] = field(default_factory=list)
    next_index: int = 0
    started_at: float | None = None
    task: asyncio.Task | None = None

    def status_out(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "scenario_id": self.scenario_id,
            "mode": self.mode,
            "next_event_index": self.next_index,
            "total_events": len(self.events),
            "elapsed_s": round(time.monotonic() - self.started_at, 1) if self.started_at else 0.0,
            "events": [
                {
                    "at_seconds": e["at_seconds"],
                    "type": e["type"],
                    "label": _label(e),
                    "fired": i < self.next_index,
                }
                for i, e in enumerate(self.events)
            ],
        }


run = ScenarioRun()


def _label(e: dict[str, Any]) -> str:
    p = e["payload"]
    if e["type"] == "report":
        return f"[{p['source']}] {p['text']}"
    return f"Hazard {p['hazard_id']} {'activates' if p.get('active', True) else 'deactivates'}"


def load_scenario(scenario_id: str) -> list[dict[str, Any]]:
    path = get_settings().scenarios_dir / f"{scenario_id}.json"
    if not path.exists():
        raise WorkflowError("not_found", f"Scenario {scenario_id} not found", 404)
    events = json.loads(path.read_text())["events"]
    return sorted(events, key=lambda e: e["at_seconds"])


async def start(scenario_id: str, mode: str) -> dict[str, Any]:
    if run.status == "running":
        raise WorkflowError("invalid_transition", "Scenario already running — reset first")
    run.scenario_id, run.mode, run.events = scenario_id, mode, load_scenario(scenario_id)
    run.next_index, run.started_at, run.status = 0, time.monotonic(), "running"
    run_id = f"RUN-{uuid.uuid4().hex[:6].upper()}"
    async with unit_of_work() as s:
        state = await workflow.system_state(s)
        state.scenario_status, state.scenario_run_id = "running", run_id
        audit.record(
            s,
            actor=audit.SIMULATOR,
            event_type="SCENARIO_STARTED",
            message=f"Scenario '{scenario_id}' started ({mode}, {len(run.events)} events)",
            entity_type="system",
            entity_id=run_id,
        )
        audit.emit(s, "scenario.updated")
    if mode == "timed":
        run.task = pipeline.spawn(_timed_loop())
    return run.status_out()


async def next_event() -> dict[str, Any]:
    if run.status != "running":
        raise WorkflowError("invalid_transition", "No scenario running")
    await _fire(run.events[run.next_index])
    return run.status_out()


async def _timed_loop() -> None:
    try:
        while run.status == "running" and run.next_index < len(run.events):
            ev = run.events[run.next_index]
            wait = ev["at_seconds"] - (time.monotonic() - (run.started_at or 0))
            if wait > 0:
                await asyncio.sleep(wait)
            await _fire(ev)
    except asyncio.CancelledError:
        raise
    except Exception:
        log.exception("scenario loop failed")


async def _fire(ev: dict[str, Any]) -> None:
    run.next_index += 1
    p = ev["payload"]
    kick_id: str | None = None
    async with unit_of_work() as s:
        if ev["type"] == "report":
            report = await workflow.ingest_report(
                s,
                text=p["text"],
                source_type=p["source"],
                source_identifier=p.get("source_identifier"),
                actor=audit.SIMULATOR,
            )
            if report.workflow_status == "RECEIVED":
                kick_id = report.id
        elif ev["type"] == "hazard":
            hazard = (await s.scalars(select(Hazard).where(Hazard.id == p["hazard_id"]))).first()
            if hazard:
                await reroute.set_hazard_active(s, hazard, p.get("active", True), audit.SIMULATOR)
        if run.next_index >= len(run.events):
            run.status = "done"
            state = await workflow.system_state(s)
            state.scenario_status = "done"
        audit.emit(s, "scenario.updated")
    if kick_id:
        pipeline.kick(kick_id)


def stop() -> None:
    if run.task:
        run.task.cancel()
    run.__init__()  # type: ignore[misc]
