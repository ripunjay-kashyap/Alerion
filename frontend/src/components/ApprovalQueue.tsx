"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useAction } from "@/lib/useAction";
import { useHighlight } from "@/lib/useHighlight";
import type { Approval, OpsState, ReviewCorrections } from "@/lib/types";
import { eta, percent } from "@/lib/format";
import { approvalTitle, needText, sourceText } from "@/lib/copy";
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
        <h2>Your decisions</h2>
        <span className={`count-badge ${pending.length ? "attention" : ""}`}>
          {pending.length} waiting
        </span>
      </div>
      {!props.state ? (
        <p className="muted panel-pad">Loading…</p>
      ) : pending.length === 0 ? (
        <p className="empty-state">
          <strong>Nothing needs you right now</strong>
          Dispatches from unverified sources and unclear reports will wait here
          for your approval.
        </p>
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
          <summary>Decided earlier ({resolved.length})</summary>
          {resolved.map((a) => (
            <button
              key={a.id}
              className="history-row"
              onClick={() => props.onSelect(a.report_id)}
            >
              <span>{a.report_id}</span>
              <span
                className={
                  a.status === "APPROVED" ? "text-emerald-300" : "text-red-300"
                }
              >
                {a.status === "APPROVED" ? "Approved" : "Rejected"}
              </span>
              <span className="muted col-span-2">
                {a.resolution_note ?? approvalTitle[a.action_type]}
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
    // Send only what the dispatcher filled in; the backend geocodes known places.
    const corrections: ReviewCorrections = {};
    if (location.trim()) corrections.location_text = location.trim();
    if (latitude.trim() && longitude.trim()) {
      corrections.latitude = Number(latitude);
      corrections.longitude = Number(longitude);
    }
    if (need) corrections.need_type = need;
    await action.execute(() =>
      api.approve(approval.id, {
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(review ? { corrections } : {}),
      }),
    );
  }
  return (
    <article
      ref={card}
      className={`approval-card ${approval.report_id === selectedReportId ? "selected" : ""}`}
    >
      <button
        className="text-left w-full"
        onClick={() => onSelect(approval.report_id)}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="badge badge-amber">
            {approvalTitle[approval.action_type]}
          </span>
          <span className="muted">{approval.report_id}</span>
        </div>
        <h3 className="mt-2">
          {report?.location_text ?? "Location not clear yet"}
        </h3>
      </button>
      <p className="approval-reason" title={approval.reason}>
        {approval.policy_rule === "GOV-01"
          ? "Someone’s life may be at risk, but the report comes from a source we can’t verify yet. A person should confirm before a responder goes."
          : approval.policy_rule === "UNC-01"
            ? "We couldn’t tell where this is or what help is needed, so nobody was sent. Fill in what’s missing and it continues automatically."
            : approval.action_type === "escalation"
              ? "No responder can reach this safely right now. Approve to try again with whoever is free."
              : approval.reason}
      </p>
      {report && (
        <>
          <div className="approval-metrics">
            <span>{needText(report.need_type)}</span>
            <span>
              Urgency <b>{report.priority_score ?? "—"}</b>
            </span>
            <span>
              Trust <b>{percent(report.trust_score)}</b>
            </span>
            <span>
              {sourceText[report.source_type]},{" "}
              {report.people_affected ?? "unknown number of"}{" "}
              {report.people_affected === 1 ? "person" : "people"}
            </span>
          </div>
          <p className="incident-text">“{report.raw_text}”</p>
        </>
      )}
      {assignment && (
        <div className="proposed-volunteer">
          <div className="section-label">Suggested responder</div>
          <div className="proposed-volunteer-head">
            <span>
              {volunteer?.name ?? assignment.volunteer_id}{" "}
              <span className="muted">({assignment.volunteer_id})</span>
            </span>
            <span>{eta(assignment.route_eta_seconds)}</span>
          </div>
          {volunteer?.medical_certified && (
            <span className="badge badge-green mt-1">Medically certified</span>
          )}
          <p className="muted mt-2">
            {assignment.explanation ?? "No explanation recorded."}
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
            <legend className="section-label">
              Fill in what the report was missing
            </legend>
            <label>
              Where is it?
              <input
                required
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="A landmark or area, e.g. Pan Bazar"
              />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label>
                Latitude (optional)
                <input
                  type="number"
                  step="any"
                  min="-90"
                  max="90"
                  value={latitude}
                  onChange={(e) => setLatitude(e.target.value)}
                  placeholder="26.1890"
                />
              </label>
              <label>
                Longitude (optional)
                <input
                  type="number"
                  step="any"
                  min="-180"
                  max="180"
                  value={longitude}
                  onChange={(e) => setLongitude(e.target.value)}
                  placeholder="91.7530"
                />
              </label>
            </div>
            <label>
              What kind of help?
              <select
                required
                value={need ?? ""}
                onChange={(e) =>
                  setNeed(e.target.value as ReviewCorrections["need_type"])
                }
              >
                <option value="">Choose one</option>
                <option value="rescue">Rescue</option>
                <option value="medical">Medical</option>
                <option value="food">Food & water</option>
              </select>
            </label>
          </fieldset>
        )}
        <label className="field-label">
          Note (optional)
          <input
            value={note}
            maxLength={1000}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Confirmed by phone"
            disabled={action.pending}
          />
        </label>
        {action.error && (
          <div role="alert" className="inline-error">
            {action.error.message}{" "}
            {action.error.policyRule && (
              <span className="badge badge-red">
                Rule {action.error.policyRule}
              </span>
            )}
          </div>
        )}
        <div className="flex gap-2 mt-3">
          <button
            type="submit"
            className="button button-go flex-1"
            disabled={action.pending}
          >
            {action.pending
              ? "Saving…"
              : review
                ? "Save and continue"
                : "Approve dispatch"}
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
