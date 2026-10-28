/** `just now`, `5 minutes ago`, `yesterday`, `3 weeks ago`: how long ago `timestamp` (unix milliseconds) was. */
export function formatRelativeTime(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) return "just now";
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return formatter.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return formatter.format(-hours, "hour");
  const days = Math.round(hours / 24);
  if (days < 7) return formatter.format(-days, "day");
  if (days < 30) return formatter.format(-Math.round(days / 7), "week");
  if (days < 365) return formatter.format(-Math.round(days / 30), "month");
  return formatter.format(-Math.round(days / 365), "year");
}
