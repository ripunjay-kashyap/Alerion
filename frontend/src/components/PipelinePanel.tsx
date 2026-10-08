import type { AuditEntry, Report } from "@/lib/types";
import { stages, stageOf, stageStatus } from "@/lib/audit";
import { stageStatusText, stageText } from "@/lib/copy";
import { clockTime } from "@/lib/format";
import AuditDetails, { ActorBadge } from "./AuditDetails";

const icon = { done: "✓", blocked: "!", running: "•", pending: "…" } as const;

export default function PipelinePanel({
  report,
  audit,
}: {
  report: Report | undefined;
  audit: AuditEntry[];
}) {
  if (!report)
    return (
      <div className="pipeline-panel">
        <p className="empty-state">
          <strong>Pick an incident</strong>
          Click a card or a pin on the map to see each step the system took,
          and who took it.
        </p>
      </div>
    );
  const entries = audit.filter(
    (e) => e.report_id === report.id || e.entity_id === report.id,
  );
  return (
    <div className="pipeline-panel">
      <div className="panel-heading">
        <h2>
          Steps for {report.location_text ?? report.id}
        </h2>
        <span className="muted">{report.id}</span>
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
                    <span className="stage-icon" aria-hidden="true">
                      {icon[status]}
                    </span>
                    {stageText[stage]}
                  </div>
                  <span className="stage-status">
                    {stageStatusText[status]}
                    {latest && (
                      <>
                        {" "}
                        by <ActorBadge entry={latest} />
                      </>
                    )}
                  </span>
                  {latest && (
                    <>
                      <p title={latest.message}>{latest.message}</p>
                      <time>{clockTime(latest.created_at)}</time>
                    </>
                  )}
                </summary>
                <div className="pipeline-entries">
                  {rows.length ? (
                    [...rows]
                      .reverse()
                      .map((e) => <AuditDetails key={e.seq} entry={e} />)
                  ) : (
                    <p className="muted">Nothing here yet.</p>
                  )}
                </div>
              </details>
            );
          })}
      </div>
    </div>
  );
}
