import type { AuditEntry } from "@/lib/types";
import { actorText, eventText } from "@/lib/copy";
import { clockTime } from "@/lib/format";

export function ActorBadge({ entry }: { entry: AuditEntry }) {
  const actor = actorText(entry);
  const tone =
    entry.actor_type === "human"
      ? "badge-blue"
      : actor === "Safety"
        ? "badge-red"
        : actor === "Rules"
          ? "badge-amber"
          : "badge-slate";
  return (
    <span title={entry.actor_id} className={`badge ${tone}`}>
      {actor}
    </span>
  );
}
export default function AuditDetails({ entry }: { entry: AuditEntry }) {
  return (
    <div className="audit-detail">
      <div className="flex flex-wrap items-center gap-2">
        <time className="muted">{clockTime(entry.created_at)}</time>
        <ActorBadge entry={entry} />
        <b>{eventText(entry.event_type)}</b>
        {entry.policy_rule && (
          <span className="badge badge-amber">rule {entry.policy_rule}</span>
        )}
      </div>
      <p className="mt-2">{entry.message}</p>
      {(["input_snapshot", "output_snapshot"] as const).map(
        (key) =>
          entry[key] && (
            <details key={key} className="snapshot">
              <summary>
                {key === "input_snapshot" ? "What went in" : "What came out"}
              </summary>
              <pre>{JSON.stringify(entry[key], null, 2)}</pre>
            </details>
          ),
      )}
    </div>
  );
}
