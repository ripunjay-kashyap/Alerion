"use client";
import { api, USE_MOCK } from "@/lib/api";
import { useAction } from "@/lib/useAction";
import type { SystemInfo } from "@/lib/types";

export default function SystemStatus({
  system,
  connected,
  refresh,
  onError,
}: {
  system: SystemInfo | null;
  connected: boolean;
  refresh: () => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const action = useAction(onError, refresh);
  return (
    <div className="system-status">
      {USE_MOCK && <span className="badge badge-amber">MOCK DEMO</span>}
      <span
        className={`connection-status ${connected ? "text-emerald-300" : "text-red-300"}`}
      >
        <span
          className={`status-dot ${connected ? "bg-emerald-400" : "bg-red-400"}`}
        />
        {USE_MOCK
          ? connected
            ? "MOCK CONNECTED"
            : "CONNECTING"
          : connected
            ? "SSE LIVE"
            : "SSE DISCONNECTED"}
      </span>
      <span className="connection-status">
        <span
          className={`status-dot ${system?.nuroen_status === "ok" ? "bg-emerald-400" : system?.nuroen_status === "degraded" ? "bg-amber-400" : "bg-slate-500"}`}
        />
        NUROEN {system?.nuroen_status.toUpperCase() ?? "UNKNOWN"}
      </span>
      <div className="mode-toggle" role="group" aria-label="Orchestration mode">
        {(["local", "nuroen"] as const).map((mode) => (
          <button
            key={mode}
            aria-pressed={system?.orchestration_mode === mode}
            className={
              system?.orchestration_mode === mode ? `active ${mode}` : ""
            }
            disabled={!system || action.pending}
            onClick={() => void action.execute(() => api.setMode(mode))}
          >
            {mode.toUpperCase()}
          </button>
        ))}
      </div>
    </div>
  );
}
export function StatsChips({ system }: { system: SystemInfo | null }) {
  const stats = system?.stats;
  return (
    <div className="stats-chips">
      <span>
        <b>{stats?.reports_received ?? "—"}</b> reports
      </span>
      <span title="Duplicate merges avoid repeated agent processing">
        <b>{stats?.duplicates_merged ?? "—"}</b> duplicates merged{" "}
        <small>(agent runs saved)</small>
      </span>
      <span className="text-violet-300">
        <b>{stats?.nuroen_processed ?? "—"}</b> Nuroen
      </span>
      <span>
        <b>{stats?.local_processed ?? "—"}</b> local
      </span>
    </div>
  );
}
export function FallbackModeBanner({
  system,
  fallback,
}: {
  system: SystemInfo | null;
  fallback: boolean;
}) {
  if (
    !fallback &&
    !(
      system?.orchestration_mode === "nuroen" &&
      system.nuroen_status === "degraded"
    )
  )
    return null;
  return (
    <div className="fallback-banner" role="status">
      ⚠ Nuroen orchestration unavailable — using local safe fallback workflow{" "}
      <span className="font-mono">
        {system?.stats.fallbacks ?? 0} fallback
        {system?.stats.fallbacks === 1 ? "" : "s"}
      </span>
    </div>
  );
}
