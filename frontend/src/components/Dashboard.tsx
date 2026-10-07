"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { useOpsState } from "@/lib/useOpsState";
import { ApiError, errorMessage } from "@/lib/errors";
import IncidentFeed from "./IncidentFeed";
import ApprovalQueue from "./ApprovalQueue";
import GovernanceBadge from "./GovernanceBadge";
import RouteInvalidatedBanner from "./RouteInvalidatedBanner";
import ScenarioControls from "./ScenarioControls";
import SystemStatus, { StatsChips } from "./SystemStatus";
import { clockTime } from "@/lib/format";
import ReportForm from "./ReportForm";
import PipelinePanel from "./PipelinePanel";
import AuditTimeline from "./AuditTimeline";

const MapView = dynamic(() => import("./MapView"), {
  ssr: false,
  loading: () => <div className="map-loading">Loading operations map…</div>,
});

export default function Dashboard() {
  const [starting, setStarting] = useState(true);
  useEffect(() => {
    const timer = window.setTimeout(() => setStarting(false), 3000);
    return () => window.clearTimeout(timer);
  }, []);
  const {
    state,
    audit,
    connected,
    error,
    refresh,
    routeInvalidation,
    resetVersion,
  } = useOpsState();
  const [selection, setSelection] = useState<{
    id: string | null;
    reset: number;
  }>({ id: null, reset: 0 });
  const selectedReportId =
    selection.reset === resetVersion &&
    state?.reports.some((r) => r.id === selection.id)
      ? selection.id
      : null;
  const onSelect = useCallback(
    (id: string | null) => setSelection({ id, reset: resetVersion }),
    [resetVersion],
  );
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [toast, setToast] = useState<{
    message: string;
    policyRule?: string;
  } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onError = useCallback((cause: unknown) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({
      message: errorMessage(cause),
      policyRule: cause instanceof ApiError ? cause.policyRule : undefined,
    });
    toastTimer.current = setTimeout(() => setToast(null), 7000);
  }, []);
  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );
  const policyEvents = [...audit]
    .reverse()
    .filter((e) =>
      ["ASSIGNMENT_REFUSED", "ROUTE_REJECTED", "VOLUNTEER_REJECTED"].includes(
        e.event_type,
      ),
    )
    .slice(0, 12);
  return (
    <>
      {starting && (
        <div className="startup-loader" role="status" aria-live="polite">
          <div className="startup-loader-content">
            <p>GUWAHATI / FLOOD RESPONSE</p>
            <h2>Loading operations map…</h2>
            <div className="startup-progress" aria-hidden="true">
              <span />
            </div>
          </div>
        </div>
      )}
      <div className="ops-dashboard" inert={starting}>
        <header className="ops-header">
          <div className="header-main">
            <div className="brand">
              <div className="brand-mark" aria-hidden="true">
                ◈
              </div>
              <div>
                <h1>DISASTER RELIEF ROUTER</h1>
                <p>
                  GUWAHATI, ASSAM <span> / FLOOD RESPONSE</span>
                </p>
              </div>
            </div>
            <SystemStatus connected={connected} />
          </div>
          <div className="header-stats">
            <StatsChips system={state?.system ?? null} />
            <span className="section-label">
              INTAKE → TRIAGE → GOVERNANCE → DISPATCH
            </span>
          </div>
          <ScenarioControls
            system={state?.system ?? null}
            resetVersion={resetVersion}
            refresh={refresh}
            onError={onError}
          />
        </header>
        {error && (
          <div className="connection-error" role="alert">
            <span>
              Backend unavailable · {error}{" "}
              {state
                ? "Showing the last good snapshot."
                : "Check NEXT_PUBLIC_API_URL or enable mock mode."}
            </span>
            <button className="text-link" onClick={() => void refresh()}>
              Retry
            </button>
          </div>
        )}
        <div className="ops-workspace">
          <aside className="left-panel">
            <IncidentFeed
              state={state}
              selectedReportId={selectedReportId}
              onSelect={onSelect}
            />
            <ReportForm
              refresh={refresh}
              onError={onError}
              onSelect={onSelect}
              disabled={!state}
            />
          </aside>
          <main className="hero-map" aria-label="Operations map">
            <MapView
              state={state}
              selectedReportId={selectedReportId}
              onSelect={onSelect}
              onAction={refresh}
              onError={onError}
            />
            {routeInvalidation && (
              <RouteInvalidatedBanner
                key={`${resetVersion}-${routeInvalidation.key}`}
                event={routeInvalidation}
                state={state}
                onSelect={onSelect}
              />
            )}
          </main>
          <aside className="right-panel">
            <ApprovalQueue
              state={state}
              selectedReportId={selectedReportId}
              onSelect={onSelect}
              refresh={refresh}
              onError={onError}
            />
            <section className="policy-decisions">
              <div className="panel-heading">
                <h2>Policy decisions</h2>
                <span className="count-badge">{policyEvents.length}</span>
              </div>
              {!state ? (
                <p className="empty-state">Loading policy audit…</p>
              ) : policyEvents.length === 0 ? (
                <p className="muted">No policy refusals recorded.</p>
              ) : (
                policyEvents.map((entry) => (
                  <button
                    key={entry.seq}
                    className="policy-row"
                    disabled={!entry.report_id}
                    onClick={() => {
                      if (entry.report_id) onSelect(entry.report_id);
                    }}
                  >
                    <GovernanceBadge
                      event={entry.event_type}
                      rule={entry.policy_rule}
                    />
                    <p className="mt-2 text-xs">{entry.message}</p>
                    <span className="muted font-mono">
                      {entry.report_id} · {clockTime(entry.created_at)}
                    </span>
                  </button>
                ))
              )}
            </section>
          </aside>
        </div>
        <section className={`audit-drawer ${drawerOpen ? "open" : ""}`}>
          <div className="drawer-heading">
            <button
              className="section-label"
              aria-expanded={drawerOpen}
              onClick={() => setDrawerOpen((v) => !v)}
            >
              {drawerOpen ? "▾" : "▸"} PIPELINE / AUDIT{" "}
              <span className="text-slate-500">{audit.length} EVENTS</span>
            </button>
            <span className="font-mono muted">
              {selectedReportId ?? "Select an incident to inspect decisions"}
            </span>
          </div>
          {drawerOpen && (
            <div className="drawer-content">
              <PipelinePanel
                report={state?.reports.find((r) => r.id === selectedReportId)}
                audit={audit}
              />
              <AuditTimeline
                audit={audit}
                selectedReportId={selectedReportId}
                loading={!state}
              />
            </div>
          )}
        </section>
        {toast && (
          <div className="error-toast" role="alert">
            <div>
              <p>{toast.message}</p>
              {toast.policyRule && (
                <span className="badge badge-red mt-2">{toast.policyRule}</span>
              )}
            </div>
            <button aria-label="Dismiss error" onClick={() => setToast(null)}>
              ×
            </button>
          </div>
        )}
      </div>
    </>
  );
}
