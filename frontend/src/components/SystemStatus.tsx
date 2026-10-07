"use client";
import { USE_MOCK } from "@/lib/api";
import type { SystemInfo } from "@/lib/types";

export default function SystemStatus({ connected }: { connected: boolean }) {
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
      <span title="Duplicate merges avoid repeated pipeline processing">
        <b>{stats?.duplicates_merged ?? "—"}</b> duplicates merged{" "}
        <small>(pipeline runs saved)</small>
      </span>
    </div>
  );
}
