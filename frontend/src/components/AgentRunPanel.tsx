import type { AuditEntry, Report } from "@/lib/types";
import { stages, stageOf, stageStatus } from "@/lib/audit";
import { clockTime } from "@/lib/format";
import AuditDetails, { ActorBadge } from "./AuditDetails";

export default function AgentRunPanel({
  report,
  audit,
}: {
  report: Report | undefined;
  audit: AuditEntry[];
}) {
  if (!report)
    return (
      <div className="empty-state">
        Select an incident to inspect its agent pipeline.
      </div>
    );
  const entries = audit.filter(
    (e) => e.report_id === report.id || e.entity_id === report.id,
  );
  return (
    <div className="agent-run-panel">
      <div className="panel-heading">
        <h2>
          Agent pipeline{" "}
          <span className="font-mono text-slate-300">/ {report.id}</span>
        </h2>
        <span
          className={`badge ${report.orchestrator === "nuroen" ? "badge-purple" : "badge-slate"}`}
        >
          {report.orchestrator?.toUpperCase() ?? "UNCLAIMED"}
        </span>
      </div>
      <div className="pipeline">
        {stages
          .filter((s) => s !== "System")
          .map((stage) => {
            const rows = entries.filter((e) => stageOf(e.event_type) === stage);
            const latest = rows.at(-1);
            const status = stageStatus(latest);
            return (
              <details
                key={`${report.id}-${stage}`}
                className={`pipeline-stage ${status}`}
              >
                <summary>
                  <div className="pipeline-stage-name">
                    <span>
                      {status === "done"
                        ? "✓"
                        : status === "blocked"
                          ? "!"
                          : status === "running"
                            ? "◉"
                            : "○"}
                    </span>{" "}
                    {stage}
                  </div>
                  <span className="stage-status">{status.toUpperCase()}</span>
                  {latest && (
                    <>
                      <ActorBadge entry={latest} />
                      <time className="font-mono muted">
                        {clockTime(latest.created_at)}
                      </time>
                      <p title={latest.message}>{latest.message}</p>
                    </>
                  )}
                </summary>
                <div className="pipeline-entries">
                  {rows.length ? (
                    [...rows]
                      .reverse()
                      .map((e) => <AuditDetails key={e.seq} entry={e} />)
                  ) : (
                    <p className="muted">
                      No {stage.toLowerCase()} events recorded.
                    </p>
                  )}
                </div>
              </details>
            );
          })}
      </div>
    </div>
  );
}
