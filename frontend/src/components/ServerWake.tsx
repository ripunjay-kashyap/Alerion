"use client";
// Shown only while a sleeping backend wakes up. Render gives no progress signal, so the bar follows the
// typical cold-start time, slows as it goes (never claiming to be done), and completes when the server answers.
import { useEffect, useState } from "react";

const SHOW_AFTER_S = 1.5; // a warm server answers well before this, so normal loads never flash the card
export const SLOW_AFTER_S = 90;

function stage(elapsed: number) {
  if (elapsed < 10) return "Waking the server…";
  if (elapsed < 35) return "Starting the dispatch engine…";
  if (elapsed < SLOW_AFTER_S) return "Almost there…";
  return "This is taking longer than usual. Check your connection or reload the page.";
}

export default function ServerWake({ ready, elapsed }: { ready: boolean; elapsed: number }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(() => setDone(true), 900);
    return () => clearTimeout(t);
  }, [ready]);
  if (done || elapsed < SHOW_AFTER_S) return null;
  const pct = ready ? 100 : Math.round(95 * (1 - Math.exp(-elapsed / 20)));
  return (
    <div className={`server-wake ${ready ? "ready" : ""}`} role="status" aria-live="polite">
      <div className="server-wake-head">
        <b>{ready ? "Connected" : stage(elapsed)}</b>
        <span>{Math.floor(elapsed)} s</span>
      </div>
      <div
        className="server-wake-bar"
        role="progressbar"
        aria-label="Connecting to the dispatch server"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <span style={{ width: `${pct}%` }} />
      </div>
      <p>Free hosting puts the server to sleep when idle. The first load can take up to a minute.</p>
    </div>
  );
}
