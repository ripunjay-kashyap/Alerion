"use client";
import { useState } from "react";
import type { AuditEntry } from "@/lib/types";
import { stageOf, stages, type Stage } from "@/lib/audit";
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
        <div className="mode-toggle">
          <button
            className={scope === "all" ? "active" : ""}
            onClick={() => setScope("all")}
          >
            All
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
          aria-label="Filter audit by stage"
          value={stage}
          onChange={(e) => setStage(e.target.value as Stage | "all")}
        >
          <option value="all">All stages</option>
          {stages.map((stage) => (
            <option key={stage} value={stage}>
              {stage}
            </option>
          ))}
        </select>
        <span className="font-mono muted">{entries.length} events</span>
      </div>
      <div className="audit-scroll">
        {entries.length ? (
          entries.map((e) => (
            <div
              key={e.seq}
              className={`audit-row stage-${stageOf(e.event_type).toLowerCase()}`}
            >
              <time className="font-mono muted">{clockTime(e.created_at)}</time>
              <ActorBadge entry={e} />
              <span className="font-mono text-xs">{e.event_type}</span>
              <p>{e.message}</p>
              {e.policy_rule && (
                <span className="badge badge-amber font-mono">
                  {e.policy_rule}
                </span>
              )}
            </div>
          ))
        ) : (
          <p className="empty-state">
            {loading
              ? "Loading audit events…"
              : scope === "selected" && !selectedReportId
                ? "Select an incident to filter the audit."
                : "No audit events for this filter."}
          </p>
        )}
      </div>
    </div>
  );
}
