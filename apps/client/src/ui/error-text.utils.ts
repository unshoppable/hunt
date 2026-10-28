/** The usual error handler: shows `reason` as text. */
export function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
