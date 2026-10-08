"use client";
import { useState } from "react";
import type { AuditEntry } from "@/lib/types";
import { stageOf, stages, type Stage } from "@/lib/audit";
import { eventText, stageText } from "@/lib/copy";
import { clockTime } from "@/lib/format";
import { ActorBadge } from "./AuditDetails";

export default function AuditTimeline({
  audit,
  selectedReportId,
  loading,
}: {
  audit: AuditEntry[];
  selectedReportId: string | null;
  loading: boolean;
}) {
  const [scope, setScope] = useState<"all" | "selected">("all");
  const [stage, setStage] = useState<Stage | "all">("all");
  const entries = [...audit]
    .reverse()
    .filter(
      (e) =>
        (scope === "all" ||
          (!!selectedReportId &&
            (e.report_id === selectedReportId ||
              e.entity_id === selectedReportId))) &&
        (stage === "all" || stageOf(e.event_type) === stage),
    );
  return (
    <div className="timeline-panel">
      <div className="timeline-toolbar">
        <div className="mode-toggle" role="group" aria-label="Which entries">
          <button
            className={scope === "all" ? "active" : ""}
            onClick={() => setScope("all")}
          >
            Everything
          </button>
          <button
            className={scope === "selected" ? "active" : ""}
            disabled={!selectedReportId}
            onClick={() => setScope("selected")}
          >
            This incident
          </button>
        </div>
        <select
          aria-label="Filter the log by step"
          value={stage}
          onChange={(e) => setStage(e.target.value as Stage | "all")}
        >
          <option value="all">All steps</option>
          {stages.map((stage) => (
            <option key={stage} value={stage}>
              {stageText[stage]}
            </option>
          ))}
        </select>
        <span className="muted">{entries.length} entries</span>
      </div>
      <div className="audit-scroll">
        {entries.length ? (
          entries.map((e) => (
            <div
              key={e.seq}
              className={`audit-row stage-${stageOf(e.event_type).toLowerCase()}`}
            >
              <time>{clockTime(e.created_at)}</time>
              <ActorBadge entry={e} />
              <span className="event-name">{eventText(e.event_type)}</span>
              {e.policy_rule ? (
                <span className="badge badge-amber">rule {e.policy_rule}</span>
              ) : (
                <span />
              )}
              <p>{e.message}</p>
            </div>
          ))
        ) : (
          <p className="muted p-4">
            {loading
              ? "Loading the log…"
              : scope === "selected" && !selectedReportId
                ? "Pick an incident to filter the log."
                : "Nothing logged for this filter yet."}
          </p>
        )}
      </div>
    </div>
  );
}
