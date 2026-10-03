"""Audit trail + post-commit event publishing.

`record()` adds an AuditEntry to the session and queues SSE events; events are only published
after the transaction commits (so the UI never refetches state that isn't there yet) and are
dropped on rollback.
"""

from dataclasses import dataclass
from typing import Any

from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from app.events import bus
from app.models import AuditEntry

_PENDING = "pending_events"


@dataclass
class Actor:
    """Who did something. `kind`: agent | human | system."""

    id: str
    kind: str
    run_id: str | None = None

    @property
    def is_nuroen(self) -> bool:
        return self.id.startswith("nuroen:")


SYSTEM = Actor("system", "system")
POLICY = Actor("policy-engine", "system")
SAFETY = Actor("safety-monitor", "system")
SIMULATOR = Actor("simulator", "system")
DISPATCHER = Actor("dispatcher", "human")


def local(stage: str) -> Actor:
    return Actor(f"local:{stage}", "agent")


def nuroen(agent: str | None, run_id: str | None) -> Actor:
    name = (agent or "coordinator").strip().lower().replace(" ", "-")
    return Actor(f"nuroen:{name}", "agent", run_id)


def emit(session: AsyncSession, name: str, **data: Any) -> None:
    session.sync_session.info.setdefault(_PENDING, []).append((name, data))


def record(
    session: AsyncSession,
    *,
    actor: Actor,
    event_type: str,
    message: str,
    entity_type: str,
    entity_id: str,
    report_id: str | None = None,
    policy_rule: str | None = None,
    input_snapshot: dict[str, Any] | None = None,
    output_snapshot: dict[str, Any] | None = None,
) -> None:
    session.add(
        AuditEntry(
            entity_type=entity_type,
            entity_id=entity_id,
            report_id=report_id,
            event_type=event_type,
            actor_type=actor.kind,
            actor_id=actor.id,
            run_id=actor.run_id,
            message=message,
            policy_rule=policy_rule,
            input_snapshot=input_snapshot,
            output_snapshot=output_snapshot,
        )
    )
    emit(session, "audit.appended", report_id=report_id, event_type=event_type)


@event.listens_for(Session, "after_commit")
def _publish_after_commit(sync_session: Session) -> None:
    pending = sync_session.info.pop(_PENDING, [])
    # collapse duplicate invalidation hints; keep ones carrying UI-trigger payloads
    seen: set[str] = set()
    for name, data in pending:
        key = f"{name}:{sorted(data.items())}" if data.get("reason") else name + str(data.get("report_id"))
        if key in seen:
            continue
        seen.add(key)
        bus.publish(name, data)


@event.listens_for(Session, "after_rollback")
def _drop_after_rollback(sync_session: Session) -> None:
    sync_session.info.pop(_PENDING, None)
