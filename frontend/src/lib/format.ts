export const eta = (seconds: number | null | undefined) =>
  seconds == null ? "—" : `${Math.ceil(seconds / 60)} min`;
export const percent = (score: number | null | undefined) =>
  score == null ? "—" : `${Math.round(score * 100)}%`;
export const clockTime = (timestamp: string) =>
  new Date(timestamp).toLocaleTimeString("en-GB", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
export const label = (value: string) => value.replaceAll("_", " ");
