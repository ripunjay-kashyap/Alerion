import type { AuditEntry } from "@/lib/types";
import { clockTime } from "@/lib/format";

export function ActorBadge({ entry }: { entry: AuditEntry }) {
  const actor = entry.actor_id.startsWith("nuroen:")
    ? "NUROEN"
    : entry.actor_type === "human"
      ? "HUMAN"
      : entry.actor_id === "safety-monitor"
        ? "SAFETY"
        : entry.actor_id.startsWith("local:")
          ? "LOCAL"
          : "SYSTEM";
  return (
    <span
      title={entry.actor_id}
      className={`badge ${actor === "NUROEN" ? "badge-purple" : actor === "HUMAN" ? "badge-blue" : actor === "SAFETY" ? "badge-red" : "badge-slate"}`}
    >
      {actor}
    </span>
  );
}
export default function AuditDetails({ entry }: { entry: AuditEntry }) {
  return (
    <div className="audit-detail">
      <div className="flex flex-wrap items-center gap-2">
        <time className="font-mono muted">{clockTime(entry.created_at)}</time>
        <ActorBadge entry={entry} />
        <span className="font-mono text-xs text-slate-400">
          {entry.event_type}
        </span>
        {entry.policy_rule && (
          <span className="badge badge-amber font-mono">
            {entry.policy_rule}
          </span>
        )}
      </div>
      <p className="mt-2 text-xs">{entry.message}</p>
      <p className="muted font-mono mt-1">
        {entry.actor_id}
        {entry.run_id ? ` · run ${entry.run_id}` : ""}
      </p>
      {(["input_snapshot", "output_snapshot"] as const).map(
        (key) =>
          entry[key] && (
            <details key={key} className="snapshot">
              <summary>
                {key === "input_snapshot" ? "Input" : "Output"} snapshot
              </summary>
              <pre>{JSON.stringify(entry[key], null, 2)}</pre>
            </details>
          ),
      )}
    </div>
  );
}
