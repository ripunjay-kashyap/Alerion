"use client";

import { useEffect, useState } from "react";
import { API_URL, USE_MOCK } from "./api";

/** The backend runs on a free tier that sleeps when idle. A cold start takes ~30–60 s and reports no
 * progress, so poll /api/health until it answers and let the UI show an honest, time-based wait. */
export function useServerWake() {
  const [ready, setReady] = useState(USE_MOCK);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (USE_MOCK) return;
    let alive = true;
    const started = Date.now();
    const tick = setInterval(() => setElapsed((Date.now() - started) / 1000), 250);
    async function poll() {
      while (alive) {
        const abort = new AbortController();
        const timeout = setTimeout(() => abort.abort(), 10_000);
        try {
          const response = await fetch(`${API_URL}/api/health`, {
            signal: abort.signal,
            cache: "no-store",
          });
          if (response.ok) {
            clearInterval(tick);
            if (alive) setReady(true);
            return;
          }
        } catch {
          // asleep or still booting: try again
        } finally {
          clearTimeout(timeout);
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
    void poll();
    return () => {
      alive = false;
      clearInterval(tick);
    };
  }, []);
  return { ready, elapsed };
}
