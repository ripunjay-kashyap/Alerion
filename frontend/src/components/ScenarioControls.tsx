"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import type { SystemInfo, ScenarioStatus } from "@/lib/types";
import { useAction } from "@/lib/useAction";

export default function ScenarioControls({
  system,
  resetVersion,
  refresh,
  onError,
}: {
  system: SystemInfo | null;
  resetVersion: number;
  refresh: () => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const [scenario, setScenario] = useState<ScenarioStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const action = useAction(onError, refresh);
  const revision = useRef(0);
  const requestId = useRef(0);
  useEffect(() => {
    let alive = true;
    const version = ++revision.current;
    async function pull() {
      const id = ++requestId.current;
      try {
        const status = await api.scenarioStatus();
        if (alive && version === revision.current && id === requestId.current) {
          setScenario(status);
          setError(null);
        }
      } catch (cause) {
        if (alive && version === revision.current && id === requestId.current)
          setError(errorMessage(cause));
      }
    }
    void pull();
    const interval = setInterval(() => void pull(), 2000);
    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, [system?.scenario_status, resetVersion]);
  async function run(operation: () => Promise<ScenarioStatus>) {
    ++requestId.current;
    await action.execute(operation, (value) => {
      ++requestId.current;
      setScenario(value);
      setError(null);
    });
  }
  const running = system?.scenario_status === "running";
  const current =
    scenario?.status === system?.scenario_status ? scenario : null;
  const disabled = !system || action.pending || running;
  return (
    <div className="scenario-controls">
      <span className="section-label">SCENARIO</span>
      <button
        className="button button-emerald"
        disabled={disabled}
        onClick={() => void run(() => api.startScenario("timed"))}
      >
        ▶ Start timed
      </button>
      <button
        className="button"
        disabled={disabled}
        onClick={() => void run(() => api.startScenario("manual"))}
      >
        Start manual
      </button>
      <button
        className="button button-amber"
        disabled={!running || action.pending || current?.mode !== "manual"}
        title={current?.events[current.next_event_index]?.label}
        onClick={() => void run(api.nextScenarioEvent)}
      >
        Next event →
      </button>
      <span className="scenario-progress font-mono" aria-live="polite">
        {current
          ? `${current.next_event_index}/${current.total_events} · ${current.elapsed_s}s · ${current.status.toUpperCase()}`
          : system
            ? system.scenario_status.toUpperCase()
            : "LOADING"}
      </span>
      {error && (
        <span className="text-xs text-red-300" title={error}>
          Scenario unavailable
        </span>
      )}
      <button
        className="button button-danger ml-auto"
        disabled={!system || action.pending}
        onClick={() => void action.execute(api.resetScenario)}
      >
        ↺ Reset
      </button>
    </div>
  );
}
