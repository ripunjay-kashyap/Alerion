"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import type { SystemInfo, ScenarioStatus } from "@/lib/types";
import { useAction } from "@/lib/useAction";

export default function ScenarioControls({
  system,
  resetVersion,
  connecting,
  refresh,
  onError,
}: {
  system: SystemInfo | null;
  resetVersion: number;
  connecting: boolean; // the server is still waking up: not an error yet
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
  const stepping = running && current?.mode === "manual";
  const next = current?.events[current.next_event_index];
  return (
    <div className="scenario-controls" aria-label="Demo scenario">
      {stepping ? (
        <button
          className="button button-primary"
          disabled={action.pending}
          title={next?.label}
          onClick={() => void run(api.nextScenarioEvent)}
        >
          Next step
        </button>
      ) : (
        <>
          <button
            className="button button-primary"
            disabled={disabled}
            onClick={() => void run(() => api.startScenario("timed"))}
          >
            Run demo
          </button>
          <button
            className="button"
            disabled={disabled}
            onClick={() => void run(() => api.startScenario("manual"))}
          >
            Step through
          </button>
        </>
      )}
      {current && current.status !== "idle" && (
        <span className="scenario-progress" aria-live="polite">
          <span className="scenario-steps" aria-hidden="true">
            {current.events.map((e, i) => (
              <i key={i} className={e.fired ? "fired" : ""} />
            ))}
          </span>
          {current.status === "done"
            ? "Demo finished"
            : `Step ${current.next_event_index} of ${current.total_events}`}
        </span>
      )}
      {error && !connecting && (
        <span className="scenario-error" title={error}>
          Demo unavailable
        </span>
      )}
      <button
        className="button button-quiet"
        disabled={!system || action.pending}
        onClick={() => void action.execute(api.resetScenario)}
      >
        Reset
      </button>
    </div>
  );
}
