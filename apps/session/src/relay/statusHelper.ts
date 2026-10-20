/**
 * The live status of a session VM's relay for the desktop client, which starts it over the session's SSH connection and
 * keeps it open, to show whether the agent runs a turn or waits for an answer:
 *
 *   sudo -n -u agent /opt/hunt/node/bin/node /srv/hunt/current/session/statusHelper.mjs [status file]
 *
 * It writes the NDJSON messages of `statusReport.ts` to stdout and diagnostics to stderr. It polls the relay's
 * `status.json` (`/run/hunt/status.json` unless given) every second instead of watching it: the relay replaces the file
 * by a rename, which swaps its inode, and `/run/hunt` is the relay's systemd RuntimeDirectory, which vanishes whenever
 * the relay stops. Reading that file is all it does, so it does not count as activity of the VM for `hunt-idle-check`:
 * it is not hunt-ctl, has no terminal, never touches the activity file and never connects to the relay's socket. It
 * exits when stdin ends or stdout breaks.
 */
import { readFileSync } from "node:fs";
import { messageOf } from "../../../../libs/domain/src/errors.ts";
import { encodeLine } from "../../../../libs/domain/src/ndjson.ts";
import { reportOf } from "./statusReport.ts";

const USAGE = "usage: statusHelper.mjs [status file]";
/** Where `hunt-relay.service` keeps the relay's status. */
const DEFAULT_STATUS_PATH = "/run/hunt/status.json";
const POLL_INTERVAL_MS = 1_000;

function main(): void {
  const args = process.argv.slice(2);
  if (args.length > 1) {
    console.error(USAGE);
    process.exit(2);
  }
  const statusPath = args[0] || DEFAULT_STATUS_PATH;
  const startedAt = Date.now();
  let hasLoggedReadError = false;
  let lastLine = "";

  /** The content of the status file; null when it is missing or cannot be read, which is logged once. */
  function readStatus(): string | null {
    try {
      return readFileSync(statusPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !hasLoggedReadError) {
        hasLoggedReadError = true;
        console.error(`failed to read ${statusPath}: ${messageOf(error)}`);
      }
      return null;
    }
  }

  /** Sends the report when it changed; a client that stops reading gets the report of the time it catches up. */
  function poll(): void {
    const line = encodeLine(reportOf(readStatus(), Date.now(), startedAt));
    if (line === lastLine || process.stdout.writableNeedDrain) return;
    lastLine = line;
    process.stdout.write(line);
  }

  const timer = setInterval(poll, POLL_INTERVAL_MS);
  function exit(): void {
    clearInterval(timer);
    process.exit(0);
  }
  process.stdout.on("error", exit);
  process.stdout.write(encodeLine({ t: "ready" }));
  poll();
  // The client sends nothing; stdin only tells when it is gone.
  process.stdin.resume();
  process.stdin.on("end", exit);
}

main();
