const TIME = { hour: "2-digit", minute: "2-digit" } as const;

/**
 * When a chat message was written, as its bubble shows it: the time alone for today, day and month before it for an
 * earlier day of this year, and the year too for an earlier year. `locale` defaults to the system's.
 */
export function formatMessageTime(at: string, now: Date, locale?: string): string {
  const date = new Date(at);
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString(locale, TIME);
  const year = date.getFullYear() === now.getFullYear() ? {} : ({ year: "2-digit" } as const);
  return date.toLocaleString(locale, { day: "2-digit", month: "2-digit", ...year, ...TIME });
}
