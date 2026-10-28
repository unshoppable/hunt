import { journalLine, type LogLevel } from "../../../../libs/domain/src/shared/journal.utils.ts";

/**
 * The log of the gateway's services: stdout, which systemd hands to the journal under the unit's SyslogIdentifier, so
 * a line names no service; `level` becomes the entry's priority. One call is one journal entry: line breaks, such as
 * the stderr tail of a failed command, become ` | `.
 */
export function writeLog(message: string, level: LogLevel = "info"): void {
  console.log(journalLine(oneLine(message), level));
}

export function oneLine(message: string): string {
  return message.trim().replace(/\s*\n\s*/g, " | ");
}
