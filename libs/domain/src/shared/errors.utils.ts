/** The error's message, with the cause that wrappers such as fetch's "fetch failed" hide. */
export function messageOf(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.cause instanceof Error ? `${error.message}: ${error.cause.message}` : error.message;
}
