"use client";
import { useEffect, useRef } from "react";
import type { Facilities, OpsState, Report } from "@/lib/types";
import { percent, eta } from "@/lib/format";
import { needText, sourceText, statusText } from "@/lib/copy";
import { useHighlight } from "@/lib/useHighlight";
import GovernanceBadge from "./GovernanceBadge";
import { NearbyHelp, SerpEvidence } from "./SerpApiEvidence";

interface Props {
  state: OpsState | null;
  selectedReportId: string | null;
  onSelect: (id: string) => void;
  facilities?: Facilities | null; // for the selected incident
}
export default function IncidentFeed(props: Props) {
  const reports = [...(props.state?.reports ?? [])]
    .filter((r) => r.workflow_status !== "MERGED")
    .sort(
      (a, b) =>
        (b.priority_score ?? -1) - (a.priority_score ?? -1) ||
        b.created_at.localeCompare(a.created_at),
    );
  const orphaned =
    props.state?.reports.filter(
      (r) =>
        r.workflow_status === "MERGED" &&
        !reports.some((parent) => parent.id === r.merged_into),
    ) ?? [];
  return (
    <div className="incident-feed">
      <div className="panel-heading">
        <h2>Incidents</h2>
        <span className="count-badge">
          {reports.length} open, most urgent first
        </span>
      </div>
      {!props.state ? (
        <p className="muted panel-pad">Loading incidents…</p>
      ) : reports.length === 0 && orphaned.length === 0 ? (
        <p className="empty-state">
          <strong>No incidents yet</strong>
          Play the demo above, or report one below.
        </p>
      ) : (
        [...reports, ...orphaned].map((report) => (
          <IncidentCard
            key={report.id}
            {...props}
            report={report}
            state={props.state!}
          />
        ))
      )}
    </div>
  );
}
const needIcon = (need: Report["need_type"]) =>
  need === "rescue" ? "⛑" : need === "medical" ? "✚" : need === "food" ? "◍" : "?";
export function IncidentCard({
  report,
  state,
  selectedReportId,
  onSelect,
  facilities,
}: Props & { report: Report; state: OpsState }) {
  const selected = report.id === selectedReportId;
  const ref = useRef<HTMLElement>(null);
  useHighlight(ref, report.updated_at);
  useEffect(() => {
    if (selected)
      ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selected]);
  const children = state.reports.filter((r) => r.merged_into === report.id);
  const assignment = state.assignments.find(
    (a) =>
      a.report_id === report.id &&
      !["CANCELLED", "FAILED", "COMPLETED"].includes(a.status),
  );
  const severity =
    report.workflow_status === "COMPLETED"
      ? "completed"
      : report.workflow_status === "NEEDS_REVIEW"
        ? "review"
        : (report.priority_score ?? 0) >= 70
          ? "critical"
          : (report.priority_score ?? 0) >= 40
            ? "urgent"
            : "routine";
  const waiting = ["AWAITING_APPROVAL", "NEEDS_REVIEW"].includes(
    report.workflow_status,
  );
  const statusTone =
    report.workflow_status === "AWAITING_APPROVAL"
      ? "badge-amber"
      : report.workflow_status === "DISPATCHED" ||
          report.workflow_status === "COMPLETED"
        ? "badge-green"
        : report.workflow_status === "FAILED" ||
            report.workflow_status === "REJECTED"
          ? "badge-red"
          : "badge-slate";
  return (
    <article
      ref={ref}
      className={`incident-card ${severity} ${selected ? "selected" : ""}`}
      aria-label={`Incident ${report.id}`}
    >
      <button
        className="incident-select"
        aria-pressed={selected}
        onClick={() => onSelect(report.merged_into ?? report.id)}
      >
        <div className="incident-top">
          <span>{report.id}</span>
          <span>From {sourceText[report.source_type].toLowerCase()} source</span>
        </div>
        <h3 className="incident-location">
          {report.location_text ?? "Location not clear yet"}
        </h3>
        <p className="incident-text">“{report.raw_text}”</p>
      </button>
      <div className="incident-metrics">
        <span className={`need-label need-${report.need_type ?? "unknown"}`}>
          <span className="need-icon" aria-hidden="true">
            {needIcon(report.need_type)}
          </span>
          {needText(report.need_type)}
        </span>
        <ScoreBreakdown report={report} />
        <TrustBreakdown report={report} />
      </div>
      <div className="incident-status">
        <span className={`badge ${statusTone}`}>
          {statusText[report.workflow_status]}
          {waiting && report.policy_rule && (
            <span className="rule">rule {report.policy_rule}</span>
          )}
        </span>
        {/* when waiting, the status already says why; otherwise show the decision */}
        {!waiting &&
          (report.policy_decision === "APPROVAL_REQUIRED" &&
          ["DISPATCHED", "IN_PROGRESS", "COMPLETED"].includes(
            report.workflow_status,
          ) ? (
            <span className="badge badge-green">
              Approved by a dispatcher
              {report.policy_rule && (
                <span className="rule">rule {report.policy_rule}</span>
              )}
            </span>
          ) : (
            <GovernanceBadge
              decision={report.policy_decision}
              rule={report.policy_rule}
            />
          ))}
      </div>
      {selected ? (
        <>
          <SerpEvidence report={report} />
          <NearbyHelp facilities={facilities ?? null} />
        </>
      ) : (
        <SerpEvidence report={report} compact />
      )}
      {assignment && (
        <div className="incident-assignment">
          <span>
            <b>{assignment.volunteer_id}</b>{" "}
            {assignment.status === "AWAITING_APPROVAL"
              ? "suggested"
              : "on the way"}
          </span>
          <span>{eta(assignment.route_eta_seconds)} away</span>
        </div>
      )}
      {report.duplicate_count > 0 && (
        <details className="duplicates">
          <summary>
            {report.duplicate_count === 1
              ? "1 more person reported this"
              : `${report.duplicate_count} more people reported this`}
          </summary>
          {children.length ? (
            children.map((r) => (
              <p className="mt-2 muted" key={r.id}>
                {r.id}: “{r.raw_text}”
              </p>
            ))
          ) : (
            <p className="muted mt-1">
              The duplicate reports aren’t loaded yet.
            </p>
          )}
        </details>
      )}
    </article>
  );
}
function ScoreBreakdown({ report }: { report: Report }) {
  const b = report.priority_breakdown;
  return (
    <div
      className="metric-tooltip"
      tabIndex={0}
      aria-label={`Urgency ${report.priority_score ?? "not scored yet"} out of 100`}
    >
      <span className="metric-label">Urgency</span>
      <strong className="score">{report.priority_score ?? "—"}</strong>
      <div className="score-tooltip">
        <div className="section-label">How urgency is scored (out of 100)</div>
        {b ? (
          <>
            <p>
              How serious <b>{b.severity}/50</b>
            </p>
            <p>
              Time waiting <b>{b.wait_time}/20</b>
            </p>
            <p>
              Vulnerable people <b>{b.vulnerability}/20</b>
            </p>
            <p>
              Near flooding <b>{b.hazard_escalation}/10</b>
            </p>
            <p>
              Total <b>{b.total}/100</b>
            </p>
          </>
        ) : (
          <p>Not scored yet.</p>
        )}
      </div>
    </div>
  );
}
function TrustBreakdown({ report }: { report: Report }) {
  const b = report.trust_breakdown;
  return (
    <div
      className="metric-tooltip"
      tabIndex={0}
      aria-label={`Trust ${percent(report.trust_score)}`}
    >
      <span className="metric-label">Trust</span>
      <strong>{percent(report.trust_score)}</strong>
      <div className="score-tooltip">
        <div className="section-label">How much we trust this report</div>
        {b ? (
          <>
            <p>
              Starting point for this source <b>{percent(b.base)}</b>
            </p>
            {b.modifiers.map((m, i) => (
              <p key={i}>
                {m.label}{" "}
                <b>
                  {m.delta >= 0 ? "+" : ""}
                  {Math.round(m.delta * 100)}%
                </b>
              </p>
            ))}
            <p>
              Final trust <b>{percent(b.score)}</b>
            </p>
          </>
        ) : (
          <p>Not checked yet.</p>
        )}
      </div>
    </div>
  );
}
