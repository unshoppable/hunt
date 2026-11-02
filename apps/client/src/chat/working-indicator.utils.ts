/** A running turn's `seconds` as the working indicator shows them: `42s` below a minute, `41m 05s` from one on. */
export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}
