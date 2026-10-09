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
import SystemStatus, { KpiStrip } from "./SystemStatus";
import { clockTime } from "@/lib/format";
import ReportForm from "./ReportForm";
import PipelinePanel from "./PipelinePanel";
import AuditTimeline from "./AuditTimeline";
import IntelPanel from "./IntelPanel";
import ServerWake, { SLOW_AFTER_S } from "./ServerWake";
import { useServerWake } from "@/lib/useServerWake";
import { SerpApiChip, useFacilities } from "./SerpApiEvidence";
import type { IntelSuggestion } from "@/lib/types";

const MapView = dynamic(() => import("./MapView"), {
  ssr: false,
  loading: () => <div className="map-loading">Loading the map…</div>,
});
const FloodIntro = dynamic(() => import("./FloodIntro"), { ssr: false });

export default function Dashboard() {
  const [intro, setIntro] = useState(true);
  const {
    state,
    audit,
    connected,
    error,
    refresh,
    routeInvalidation,
    resetVersion,
  } = useOpsState();
  const wake = useServerWake();
  useEffect(() => {
    if (wake.ready) void refresh(); // load the dashboard the moment a sleeping server answers
  }, [wake.ready, refresh]);
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
  const [focus, setFocus] = useState<{ lng: number; lat: number; key: number } | null>(null);
  const onFocus = useCallback(
    (s: IntelSuggestion) => setFocus({ lng: s.longitude, lat: s.latitude, key: Date.now() }),
    [],
  );
  const facilities = useFacilities(state?.reports.find((r) => r.id === selectedReportId));
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
      {intro && <FloodIntro onDone={() => setIntro(false)} />}
      <ServerWake ready={wake.ready} elapsed={wake.elapsed} />
      <div className="ops-dashboard" inert={intro}>
        <header className="app-bar">
          <div className="brand">
            <div className="brand-mark" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none">
                <path
                  d="M12 2.5c3.6 4.4 6 7.9 6 11a6 6 0 0 1-12 0c0-3.1 2.4-6.6 6-11Z"
                  stroke="currentColor"
                  strokeWidth="1.8"
                />
                <path
                  d="M8.5 14.5c1.2 1.4 2.4 1.4 3.5 0s2.3-1.4 3.5 0"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              </svg>
            </div>
            <h1>Disaster Relief Router</h1>
            <span className="brand-divider" aria-hidden="true" />
            <p>Guwahati flood operations</p>
          </div>
          <div className="app-bar-actions">
            <ScenarioControls
              system={state?.system ?? null}
              resetVersion={resetVersion}
              connecting={!wake.ready}
              refresh={refresh}
              onError={onError}
            />
            <SerpApiChip state={state} />
            <SystemStatus connected={connected} />
          </div>
        </header>
        <KpiStrip state={state} />
        {error && (wake.ready || wake.elapsed > SLOW_AFTER_S) && (
          <div className="connection-error" role="alert" title={error}>
            <span>
              Can’t reach the dispatch server.{" "}
              {state
                ? "You’re seeing the last update."
                : "Start the backend, then try again."}
            </span>
            <button
              className="button button-danger"
              onClick={() => void refresh()}
            >
              Try again
            </button>
          </div>
        )}
        <div className="ops-workspace">
          <aside className="panel left-panel" aria-label="Incidents">
            <IncidentFeed
              state={state}
              selectedReportId={selectedReportId}
              onSelect={onSelect}
              facilities={facilities}
            />
            <ReportForm
              refresh={refresh}
              onError={onError}
              onSelect={onSelect}
              disabled={!state}
            />
          </aside>
          <main className="panel hero-map" aria-label="Operations map">
            <MapView
              state={state}
              selectedReportId={selectedReportId}
              onSelect={onSelect}
              onAction={refresh}
              onError={onError}
              facilities={facilities?.results ?? []}
              focus={focus}
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
          <aside className="panel right-panel" aria-label="Decisions">
            <ApprovalQueue
              state={state}
              selectedReportId={selectedReportId}
              onSelect={onSelect}
              refresh={refresh}
              onError={onError}
            />
            <IntelPanel
              state={state}
              refresh={refresh}
              onError={onError}
              onFocus={onFocus}
            />
            <section className="policy-decisions">
              <div className="panel-heading">
                <h2>Blocked by safety rules</h2>
                <span className="count-badge">{policyEvents.length}</span>
              </div>
              {!state ? (
                <p className="muted panel-pad">Loading…</p>
              ) : policyEvents.length === 0 ? (
                <p className="empty-state">
                  Nothing blocked yet. Unqualified responders and unsafe routes
                  appear here.
                </p>
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
                    <p>{entry.message}</p>
                    <span>
                      {entry.report_id} at {clockTime(entry.created_at)}
                    </span>
                  </button>
                ))
              )}
            </section>
          </aside>
        </div>
        <section className={`panel audit-drawer ${drawerOpen ? "open" : ""}`}>
          <div className="drawer-heading">
            <button
              className="drawer-toggle"
              aria-expanded={drawerOpen}
              onClick={() => setDrawerOpen((v) => !v)}
            >
              <span className="chevron" aria-hidden="true">
                {drawerOpen ? "▾" : "▸"}
              </span>
              Decision trace
              <small>{audit.length} log entries</small>
            </button>
            <span className="muted">
              {selectedReportId
                ? `Showing ${selectedReportId}`
                : "Pick an incident to see its steps"}
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
                <span className="badge badge-red mt-2">
                  Rule {toast.policyRule}
                </span>
              )}
            </div>
            <button aria-label="Dismiss" onClick={() => setToast(null)}>
              ×
            </button>
          </div>
        )}
      </div>
    </>
  );
}
