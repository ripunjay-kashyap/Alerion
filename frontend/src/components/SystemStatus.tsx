"use client";
import { USE_MOCK } from "@/lib/api";
import type { OpsState } from "@/lib/types";

export default function SystemStatus({ connected }: { connected: boolean }) {
  return (
    <div className="system-status">
      {USE_MOCK && <span className="badge badge-amber">Sample data</span>}
      <span className={`connection-status ${connected ? "live" : "offline"}`}>
        <span className="status-dot" />
        {connected ? "Live" : "Reconnecting"}
      </span>
    </div>
  );
}

// The numbers an operator scans first, all derived from the live snapshot.
export function KpiStrip({ state }: { state: OpsState | null }) {
  const open =
    state?.reports.filter(
      (r) => !["MERGED", "COMPLETED", "REJECTED"].includes(r.workflow_status),
    ).length ?? 0;
  const waiting =
    state?.approvals.filter((a) => a.status === "PENDING").length ?? 0;
  const enRoute =
    state?.volunteers.filter((v) => v.status === "en_route").length ?? 0;
  const free =
    state?.volunteers.filter((v) => v.available && v.status === "idle")
      .length ?? 0;
  const kpis = [
    { label: "Open incidents", value: open },
    {
      label: "Awaiting your decision",
      value: waiting,
      tone: waiting ? "decide" : "",
    },
    { label: "Responders en route", value: enRoute },
    {
      label: "Responders available",
      value: free,
      hint: state ? `of ${state.volunteers.length}` : undefined,
    },
    { label: "Reports received", value: state?.system.stats.reports_received ?? 0 },
    {
      label: "Duplicates merged",
      value: state?.system.stats.duplicates_merged ?? 0,
      hint: "no second dispatch",
    },
  ];
  return (
    <section className="kpi-strip" aria-label="Key figures">
      {kpis.map((k) => (
        <div key={k.label} className={`kpi ${k.tone ?? ""}`}>
          <span className="kpi-label">{k.label}</span>
          <span className="kpi-value">
            {state ? k.value : "–"}
            {k.hint && state && <small>{k.hint}</small>}
          </span>
        </div>
      ))}
    </section>
  );
}
