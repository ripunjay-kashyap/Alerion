"use client";
import { useState } from "react";
import { api } from "@/lib/api";
import { useAction } from "@/lib/useAction";
import type { SourceType } from "@/lib/types";
const samples = [
  {
    label: "Medical",
    source: "citizen" as const,
    text: "Old couple stuck near Market Road, water is rising and one person needs insulin.",
  },
  {
    label: "Rescue",
    source: "official" as const,
    text: "Official rescue request: five residents stranded at Riverside Apartments, Uzan Bazaar. Water rising at the ground floor.",
  },
  {
    label: "Food",
    source: "citizen" as const,
    text: "Twenty residents on Station Road need food and drinking water. Road access remains open.",
  },
];
export default function ReportForm({
  refresh,
  onError,
  onSelect,
  disabled,
}: {
  refresh: () => Promise<void>;
  onError: (error: unknown) => void;
  onSelect: (id: string) => void;
  disabled: boolean;
}) {
  const [text, setText] = useState("");
  const [source, setSource] = useState<SourceType>("citizen");
  const [submitted, setSubmitted] = useState<string | null>(null);
  const action = useAction(onError, refresh);
  return (
    <details className="report-form">
      <summary className="section-label">+ SUBMIT INCIDENT REPORT</summary>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action.execute(
            () => api.submitReport({ text: text.trim(), source }),
            (report) => {
              setText("");
              setSubmitted(report.id);
              onSelect(report.id);
            },
          );
        }}
      >
        <div className="flex gap-2 mt-3 mb-3">
          {samples.map((sample) => (
            <button
              type="button"
              className="button"
              disabled={action.pending || disabled}
              key={sample.label}
              onClick={() => {
                setText(sample.text);
                setSource(sample.source);
                setSubmitted(null);
              }}
            >
              {sample.label} sample
            </button>
          ))}
        </div>
        <label className="field-label">
          Incident report
          <textarea
            rows={4}
            required
            maxLength={5000}
            disabled={action.pending || disabled}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="What happened, where, who needs help?"
          />
        </label>
        <label className="field-label mt-2">
          Source
          <select
            value={source}
            disabled={action.pending || disabled}
            onChange={(e) => setSource(e.target.value as SourceType)}
          >
            <option value="official">Official</option>
            <option value="verified_operator">Verified operator</option>
            <option value="citizen">Citizen</option>
            <option value="anonymous">Anonymous</option>
          </select>
        </label>
        {action.error && (
          <p className="inline-error" role="alert">
            {action.error.message}
          </p>
        )}
        <button
          className="button button-emerald w-full mt-3"
          disabled={action.pending || disabled || !text.trim()}
        >
          {action.pending ? "Submitting…" : "Submit report"}
        </button>
        {submitted && (
          <p className="mt-2 text-xs text-emerald-300" role="status">
            Report accepted · <span className="font-mono">{submitted}</span>
          </p>
        )}
      </form>
    </details>
  );
}
