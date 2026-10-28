/** How severe a log line is; it becomes the journal entry's syslog priority and Cloud Logging's severity. */
export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

/** Writes one log line; `level` defaults to info. */
export type Log = (message: string, level?: LogLevel) => void;

const PRIORITIES: Record<LogLevel, number> = { debug: 7, info: 6, warn: 4, error: 3, fatal: 2 };

/**
 * `message` as written to stdout or stderr at `level`. When the stream goes to the journal (systemd sets
 * JOURNAL_STREAM), every line starts with the priority prefix `<N>` of sd-daemon(3), which journald turns into the
 * entry's priority and strips (SyslogLevelPrefix, on by default); elsewhere, such as in a terminal, the lines stay bare.
 */
export function journalLine(message: string, level: LogLevel, toJournal = Boolean(process.env.JOURNAL_STREAM)): string {
  if (!toJournal) return message;
  return message
    .split("\n")
    .map((line) => `<${PRIORITIES[level]}>${line}`)
    .join("\n");
}
