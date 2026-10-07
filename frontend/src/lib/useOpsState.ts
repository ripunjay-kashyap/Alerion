"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, API_URL, USE_MOCK } from "./api";
import { errorMessage } from "./errors";
import type {
  AuditEntry,
  OpsEvent,
  OpsState,
  RouteInvalidation,
} from "./types";

function isEvent(value: unknown): value is OpsEvent {
  return (
    !!value &&
    typeof value === "object" &&
    "event" in value &&
    typeof value.event === "string" &&
    "data" in value &&
    !!value.data &&
    typeof value.data === "object"
  );
}
const stringValue = (value: unknown) =>
  typeof value === "string" ? value : null;
const numberValue = (value: unknown) =>
  typeof value === "number" ? value : null;

/** Domain events invalidate snapshots; workflow state only comes from the API. */
export function useOpsState() {
  const [state, setState] = useState<OpsState | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [routeInvalidation, setRouteInvalidation] =
    useState<RouteInvalidation | null>(null);
  const [resetVersion, setResetVersion] = useState(0);
  const sync = useRef<() => Promise<void>>(async () => {});
  const refresh = useCallback(() => sync.current(), []);

  useEffect(() => {
    let alive = true;
    let epoch = 0;
    let lastSeq = 0;
    let syncing = false;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let dispose: (() => void) | undefined;
    let eventKey = 0;
    async function pull() {
      pending = true;
      if (syncing) return;
      syncing = true;
      try {
        while (pending && alive) {
          pending = false;
          const version = epoch;
          try {
            const [snapshot, entries] = await Promise.all([
              api.state(),
              api.audit(lastSeq),
            ]);
            if (!alive) break;
            if (version !== epoch) {
              pending = true;
              continue;
            }
            setState(snapshot);
            if (entries.length) {
              lastSeq = entries.at(-1)!.seq;
              setAudit((previous) => {
                const known = new Set(previous.map((e) => e.seq));
                return [
                  ...previous,
                  ...entries.filter((e) => !known.has(e.seq)),
                ];
              });
              if (entries.length === 500) pending = true;
            }
            setError(null);
          } catch (cause) {
            if (alive && version === epoch) setError(errorMessage(cause));
          }
        }
      } finally {
        syncing = false;
      }
    }
    sync.current = pull;
    function schedule() {
      clearTimeout(timer);
      timer = setTimeout(() => {
        void pull();
      }, 200);
    }
    function receive(event: OpsEvent) {
      if (!alive) return;
      if (event.event === "system.reset") {
        epoch++;
        lastSeq = 0;
        setAudit([]);
        setRouteInvalidation(null);
        setResetVersion((v) => v + 1);
      }
      if (
        event.event === "assignment.updated" &&
        event.data.reason === "route_invalidated"
      ) {
        setRouteInvalidation({
          key: ++eventKey,
          assignment_id: stringValue(event.data.assignment_id),
          report_id: stringValue(event.data.report_id),
          hazard_id: stringValue(event.data.hazard_id),
          previous_eta_seconds: numberValue(event.data.previous_eta_seconds),
          new_eta_seconds: numberValue(event.data.new_eta_seconds),
        });
      }
      schedule();
    }
    if (USE_MOCK) {
      void import("./mock").then(({ subscribeMock }) => {
        if (!alive) return;
        dispose = subscribeMock(receive);
        setConnected(true);
        void pull();
      });
    } else {
      const es = new EventSource(`${API_URL}/api/events`);
      es.addEventListener("hello", () => {
        if (alive) {
          setConnected(true);
          schedule();
        }
      });
      es.addEventListener("ping", schedule);
      es.addEventListener("message", (message: MessageEvent<string>) => {
        try {
          const event: unknown = JSON.parse(message.data);
          if (isEvent(event)) receive(event);
          else schedule();
        } catch {
          schedule();
        }
      });
      es.onerror = () => {
        if (alive) setConnected(false);
      };
      dispose = () => es.close();
      void pull();
    }
    const poll = setInterval(() => {
      void pull();
    }, 10_000);
    return () => {
      alive = false;
      dispose?.();
      clearTimeout(timer);
      clearInterval(poll);
    };
  }, []);

  return {
    state,
    audit,
    connected,
    error,
    refresh,
    routeInvalidation,
    resetVersion,
  };
}
