"use client";
import { useEffect, useRef } from "react";
import { api } from "@/lib/api";
import type { OpsState, Report } from "@/lib/types";
import { percent, label, eta } from "@/lib/format";
import { useAction } from "@/lib/useAction";
import { useHighlight } from "@/lib/useHighlight";
import GovernanceBadge from "./GovernanceBadge";

interface Props {
  state: OpsState | null;
  selectedReportId: string | null;
  onSelect: (id: string) => void;
  refresh: () => Promise<void>;
  onError: (error: unknown) => void;
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
        <h2>Live incident feed</h2>
        <span className="count-badge">{reports.length} incidents</span>
      </div>
      <div className="feed-subtitle">
        PRIORITY ↓ <span>BACKEND STATE</span>
      </div>
      {!props.state ? (
        <p className="empty-state">Loading reports…</p>
      ) : reports.length === 0 && orphaned.length === 0 ? (
        <p className="empty-state">
          No incident reports yet.
          <span className="block mt-1 text-slate-600">
            Start a scenario or submit a report.
          </span>
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
export function IncidentCard({
  report,
  state,
  selectedReportId,
  onSelect,
  refresh,
  onError,
}: Props & { report: Report; state: OpsState }) {
  const selected = report.id === selectedReportId;
  const ref = useRef<HTMLElement>(null);
  useHighlight(ref, report.updated_at);
  const action = useAction(onError, refresh);
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
  const waitForNuroen =
    state.system.orchestration_mode === "nuroen" &&
    report.workflow_status === "RECEIVED";
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
        <div className="flex justify-between items-center gap-2">
          <span className="font-mono text-xs text-slate-300">{report.id}</span>
          <span className="badge badge-slate">
            {label(report.source_type).toUpperCase()}
          </span>
        </div>
        <h3 className="incident-location">
          {report.location_text ?? "Location unresolved"}
        </h3>
        <p className="line-clamp-2 text-xs leading-relaxed text-slate-400">
          {report.raw_text}
        </p>
      </button>
      <div className="incident-metrics">
        <span className="need-label">
          <span aria-hidden="true">
            {report.need_type === "rescue"
              ? "◈"
              : report.need_type === "medical"
                ? "+"
                : report.need_type === "food"
                  ? "▤"
                  : "?"}
          </span>{" "}
          {report.need_type?.toUpperCase() ?? "UNKNOWN"}
        </span>
        <ScoreBreakdown report={report} />
        <TrustBreakdown report={report} />
      </div>
      <div className="flex flex-wrap items-center gap-1.5 mt-2">
        <span
          className={`badge ${report.workflow_status === "AWAITING_APPROVAL" ? "badge-amber" : report.workflow_status === "DISPATCHED" || report.workflow_status === "COMPLETED" ? "badge-green" : report.workflow_status === "FAILED" || report.workflow_status === "REJECTED" ? "badge-red" : "badge-slate"}`}
        >
          {label(report.workflow_status)}
        </span>
        <span
          className={`badge font-mono ${report.orchestrator === "nuroen" ? "badge-purple" : "badge-slate"}`}
        >
          {report.orchestrator?.toUpperCase() ?? "UNCLAIMED"}
        </span>
      </div>
      <div className="mt-2">
        <GovernanceBadge
          decision={report.policy_decision}
          rule={report.policy_rule}
        />
      </div>
      {assignment && (
        <div className="mt-2 flex justify-between font-mono text-xs">
          <span className="text-emerald-300">
            {assignment.volunteer_id} · {label(assignment.status)}
          </span>
          <span className="text-slate-300">
            ETA {eta(assignment.route_eta_seconds)}
          </span>
        </div>
      )}
      {report.duplicate_count > 0 && (
        <details className="duplicates">
          <summary className="text-xs text-blue-300">
            +{report.duplicate_count} duplicate
            {report.duplicate_count === 1 ? "" : "s"} merged
          </summary>
          {children.length ? (
            children.map((r) => (
              <p className="mt-2 muted" key={r.id}>
                <span className="font-mono">{r.id}</span> · {r.raw_text}
              </p>
            ))
          ) : (
            <p className="muted mt-1">
              Duplicate details not available in this snapshot.
            </p>
          )}
        </details>
      )}
      {waitForNuroen && (
        <div className="waiting-nuroen">
          <p>Waiting for Nuroen pickup…</p>
          <button
            className="button mt-2"
            disabled={action.pending}
            onClick={() =>
              void action.execute(() => api.processLocally(report.id))
            }
          >
            {action.pending ? "Processing…" : "Process locally"}
          </button>
        </div>
      )}
      {action.error && (
        <p role="alert" className="inline-error">
          {action.error.message} {action.error.policyRule}
        </p>
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
      aria-label={`Priority ${report.priority_score ?? "unscored"}`}
    >
      <span className="metric-label">PRI</span>
      <strong className="font-mono score">
        {report.priority_score ?? "—"}
      </strong>
      <div className="score-tooltip">
        <div className="section-label">PRIORITY BREAKDOWN</div>
        {b ? (
          <>
            <p>
              Severity <b>{b.severity}/50</b>
            </p>
            <p>
              Wait time <b>{b.wait_time}/20</b>
            </p>
            <p>
              Vulnerability <b>{b.vulnerability}/20</b>
            </p>
            <p>
              Hazard <b>{b.hazard_escalation}/10</b>
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
      <span className="metric-label">TRUST</span>
      <strong className="font-mono text-slate-200">
        {percent(report.trust_score)}
      </strong>
      <div className="score-tooltip">
        <div className="section-label">TRUST BREAKDOWN</div>
        {b ? (
          <>
            <p>
              Source base <b>{percent(b.base)}</b>
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
              Final score <b>{percent(b.score)}</b>
            </p>
          </>
        ) : (
          <p>Not evaluated yet.</p>
        )}
      </div>
    </div>
  );
}
