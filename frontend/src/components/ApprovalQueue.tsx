"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useAction } from "@/lib/useAction";
import { useHighlight } from "@/lib/useHighlight";
import type { Approval, OpsState, ReviewCorrections } from "@/lib/types";
import { eta, label, percent } from "@/lib/format";
import VolunteerFunnel from "./VolunteerFunnel";

interface Props {
  state: OpsState | null;
  selectedReportId: string | null;
  onSelect: (id: string) => void;
  refresh: () => Promise<void>;
  onError: (error: unknown) => void;
}
export default function ApprovalQueue(props: Props) {
  const pending =
    props.state?.approvals
      .filter((a) => a.status === "PENDING")
      .sort(
        (a, b) =>
          (props.state?.reports.find((r) => r.id === b.report_id)
            ?.priority_score ?? -1) -
            (props.state?.reports.find((r) => r.id === a.report_id)
              ?.priority_score ?? -1) ||
          b.created_at.localeCompare(a.created_at),
      ) ?? [];
  const resolved =
    props.state?.approvals
      .filter((a) => a.status !== "PENDING")
      .sort((a, b) =>
        (b.resolved_at ?? b.created_at).localeCompare(
          a.resolved_at ?? a.created_at,
        ),
      ) ?? [];
  return (
    <div>
      <div className="panel-heading">
        <h2>Governance · approvals</h2>
        <span className="count-badge text-amber-300">
          {pending.length} pending
        </span>
      </div>
      {!props.state ? (
        <p className="empty-state">Loading approval queue…</p>
      ) : pending.length === 0 ? (
        <div className="empty-state">
          No approvals pending.
          <span className="block mt-1 text-slate-600">
            Governed decisions will appear here.
          </span>
        </div>
      ) : (
        pending.map((approval) => (
          <ApprovalCard
            key={approval.id}
            {...props}
            state={props.state!}
            approval={approval}
          />
        ))
      )}
      {resolved.length > 0 && (
        <details className="history-list">
          <summary className="section-label">
            Resolved history · {resolved.length}
          </summary>
          {resolved.map((a) => (
            <button
              key={a.id}
              className="history-row"
              onClick={() => props.onSelect(a.report_id)}
            >
              <span className="font-mono">
                {a.id} · {a.report_id}
              </span>
              <span
                className={
                  a.status === "APPROVED" ? "text-emerald-300" : "text-red-300"
                }
              >
                {a.status}
              </span>
              <span className="muted col-span-2">
                {a.resolution_note ??
                  `${label(a.action_type)} ${a.status.toLowerCase()} by ${a.approved_by ?? "dispatcher"}`}
              </span>
            </button>
          ))}
        </details>
      )}
    </div>
  );
}
export function ApprovalCard({
  approval,
  state,
  selectedReportId,
  onSelect,
  refresh,
  onError,
}: Props & { approval: Approval; state: OpsState }) {
  const report = state.reports.find((r) => r.id === approval.report_id);
  const assignment = state.assignments.find(
    (a) => a.id === approval.assignment_id,
  );
  const volunteer = state.volunteers.find(
    (v) => v.id === assignment?.volunteer_id,
  );
  const [note, setNote] = useState("");
  const [location, setLocation] = useState(report?.location_text ?? "");
  const [latitude, setLatitude] = useState(report?.latitude?.toString() ?? "");
  const [longitude, setLongitude] = useState(
    report?.longitude?.toString() ?? "",
  );
  const [need, setNeed] = useState<ReviewCorrections["need_type"]>(
    report?.need_type ?? undefined,
  );
  const action = useAction(onError, refresh);
  const card = useRef<HTMLElement>(null);
  useHighlight(card, `${approval.status}-${approval.resolved_at}`);
  useEffect(() => {
    if (approval.report_id === selectedReportId)
      card.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [approval.report_id, selectedReportId]);
  const review = approval.action_type === "review";
  async function approve(form: React.FormEvent<HTMLFormElement>) {
    form.preventDefault();
    const corrections: ReviewCorrections | undefined = review
      ? {
          location_text: location.trim(),
          latitude: Number(latitude),
          longitude: Number(longitude),
          need_type: need,
        }
      : undefined;
    await action.execute(() =>
      api.approve(approval.id, {
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(corrections ? { corrections } : {}),
      }),
    );
  }
  return (
    <article
      ref={card}
      className={`approval-card ${approval.report_id === selectedReportId ? "selected" : ""}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="badge badge-amber">
          {approval.action_type.toUpperCase()}
        </span>
        {approval.policy_rule && (
          <span className="badge badge-amber font-mono">
            {approval.policy_rule}
          </span>
        )}
      </div>
      <button
        className="text-left mt-3 w-full"
        onClick={() => onSelect(approval.report_id)}
      >
        <span className="font-mono text-xs text-slate-500">
          {approval.id} / {approval.report_id}
        </span>
        <h3 className="mt-1 font-semibold">
          {report?.location_text ?? "Unresolved location"}
        </h3>
      </button>
      <p className="mt-2 text-xs text-slate-300">{approval.reason}</p>
      {report && (
        <>
          <div className="approval-metrics">
            <span>{report.need_type?.toUpperCase() ?? "UNKNOWN NEED"}</span>
            <span className="font-mono">
              PRI{" "}
              <b className="text-amber-300">{report.priority_score ?? "—"}</b>
            </span>
            <span className="font-mono">
              TRUST {percent(report.trust_score)}
            </span>
          </div>
          <p className="muted">
            {label(report.source_type)} · {report.people_affected ?? "Unknown"}{" "}
            people
          </p>
          <p className="line-clamp-2 text-xs text-slate-400 mt-2">
            {report.raw_text}
          </p>
        </>
      )}
      {assignment && (
        <div className="proposed-volunteer">
          <div className="section-label">PROPOSED VOLUNTEER</div>
          <div className="flex justify-between font-mono text-sm">
            <span>
              {assignment.volunteer_id}{" "}
              <span className="text-emerald-300">
                {volunteer?.medical_certified ? "✓ certified" : ""}
              </span>
            </span>
            <span>{eta(assignment.route_eta_seconds)}</span>
          </div>
          <p className="muted">{volunteer?.name}</p>
          <p className="mt-2 text-xs text-slate-300">
            {assignment.explanation ?? "Dispatch explanation not available."}
          </p>
          <VolunteerFunnel
            selection={assignment.selection}
            total={state.volunteers.length}
          />
        </div>
      )}
      <form onSubmit={approve} className="mt-3">
        {review && (
          <fieldset disabled={action.pending} className="review-fields">
            <legend className="section-label">CORRECT INTAKE DETAILS</legend>
            <label>
              Location
              <input
                required
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="Landmark / locality"
              />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label>
                Latitude
                <input
                  type="number"
                  step="any"
                  min="-90"
                  max="90"
                  required
                  value={latitude}
                  onChange={(e) => setLatitude(e.target.value)}
                  placeholder="26.1890"
                />
              </label>
              <label>
                Longitude
                <input
                  type="number"
                  step="any"
                  min="-180"
                  max="180"
                  required
                  value={longitude}
                  onChange={(e) => setLongitude(e.target.value)}
                  placeholder="91.7530"
                />
              </label>
            </div>
            <label>
              Need type
              <select
                required
                value={need ?? ""}
                onChange={(e) =>
                  setNeed(e.target.value as ReviewCorrections["need_type"])
                }
              >
                <option value="">Select need</option>
                <option value="rescue">Rescue</option>
                <option value="medical">Medical</option>
                <option value="food">Food & water</option>
              </select>
            </label>
          </fieldset>
        )}
        <label className="field-label">
          Resolution note <span className="muted">(optional)</span>
          <input
            value={note}
            maxLength={1000}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Dispatcher note"
            disabled={action.pending}
          />
        </label>
        {action.error && (
          <div role="alert" className="inline-error">
            {action.error.message}{" "}
            {action.error.policyRule && (
              <span className="badge badge-red">{action.error.policyRule}</span>
            )}
          </div>
        )}
        <div className="flex gap-2 mt-3">
          <button
            type="submit"
            className="button button-emerald flex-1"
            disabled={action.pending}
          >
            {action.pending
              ? "Resolving…"
              : review
                ? "Approve corrections"
                : "Approve"}
          </button>
          <button
            type="button"
            className="button button-danger"
            disabled={action.pending}
            onClick={() =>
              void action.execute(() =>
                api.reject(approval.id, {
                  ...(note.trim() ? { note: note.trim() } : {}),
                }),
              )
            }
          >
            Reject
          </button>
        </div>
      </form>
    </article>
  );
}
