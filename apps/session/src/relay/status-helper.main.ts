/**
 * The live status of a session VM's relay for the desktop client, which starts it over the session's SSH connection and
 * keeps it open, to show whether the agent runs a turn or waits for an answer, when the pipeline record of a
 * software-factory session changed, and the annotations of the review widget on the session's preview pages:
 *
 *   sudo -n -u agent /opt/hunt/node/bin/node /srv/hunt/current/session/statusHelper.mjs [status file [annotations folder [session config]]]
 *
 * It writes the NDJSON messages of `status-report.utils.ts` to stdout and diagnostics to stderr. Every second it polls the
 * relay's `status.json` (`/run/hunt/status.json` unless given) instead of watching it: the relay replaces the file by a
 * rename, which swaps its inode, and `/run/hunt` is the relay's systemd RuntimeDirectory, which vanishes whenever the
 * relay stops. In the same poll it reads when `.hunt/swf/pipeline.json` of the session's worktree was last written: the
 * worktree is the `cwd` of the relay's `hunt-session.json` (`~agent/.claude/hunt-session.json` unless given,
 * `hunt-session-config.value-object.ts`), read once it exists; the swf runner rewrites the record after every change of
 * the pipeline, and the desktop pulls it then. It also takes the annotations waiting in the review server's spool folder
 * (`/run/hunt-review/annotations` unless given, `../review/annotation-spool.service.ts`) and sends each one once. Reading those
 * files and deleting the annotations is all it does, so it does not count as activity of the VM for `hunt-idle-check`:
 * it is not hunt-ctl, has no terminal, never touches the activity file and never connects to the relay's socket. It
 * exits when stdin ends or stdout breaks.
 */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { messageOf } from "../../../../libs/domain/src/shared/errors.utils.ts";
import { encodeLine } from "../../../../libs/domain/src/shared/ndjson.utils.ts";
import { AnnotationSpool, DEFAULT_SPOOL_DIR } from "../review/annotation-spool.service.ts";
import { HuntSessionConfig } from "./hunt-session-config.value-object.ts";
import { reportOf, type AnnotationReport } from "./status-report.utils.ts";

const USAGE = "usage: statusHelper.mjs [status file [annotations folder [session config]]]";
/** Where `hunt-relay.service` keeps the relay's status. */
const DEFAULT_STATUS_PATH = "/run/hunt/status.json";
/** The relay's `hunt-session.json`, which `hunt-ctl` writes into the agent's Claude home. */
const DEFAULT_CONFIG_PATH = "/home/agent/.claude/hunt-session.json";
/** The pipeline record of a software-factory session, relative to the worktree (`SWF_DIR` of `hunt-ctl`). */
const SWF_RECORD = ".hunt/swf/pipeline.json";
const POLL_INTERVAL_MS = 1_000;

function main(): void {
  const args = process.argv.slice(2);
  if (args.length > 3) {
    console.error(USAGE);
    process.exit(2);
  }
  const statusPath = args[0] || DEFAULT_STATUS_PATH;
  const spool = new AnnotationSpool(args[1] || DEFAULT_SPOOL_DIR);
  const configPath = args[2] || DEFAULT_CONFIG_PATH;
  const startedAt = Date.now();
  let hasLoggedReadError = false;
  let hasLoggedSpoolError = false;
  let hasLoggedConfigError = false;
  /** The pipeline record of the session's worktree; null until the session's config names the worktree. */
  let swfRecordPath: string | null = null;
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

  /**
   * When the worktree's pipeline record was last written; null while there is none, or while the session's config, which
   * names the worktree, is missing or unreadable (logged once). The worktree of a session never changes, so the config is
   * read until it is found, then kept.
   */
  function readSwfRecordAt(): number | null {
    if (swfRecordPath === null) {
      try {
        swfRecordPath = join(HuntSessionConfig.fromJson(readFileSync(configPath, "utf8")).cwd, SWF_RECORD);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !hasLoggedConfigError) {
          hasLoggedConfigError = true;
          console.error(`failed to read the worktree from ${configPath}: ${messageOf(error)}`);
        }
        return null;
      }
    }
    try {
      return Math.round(statSync(swfRecordPath).mtimeMs);
    } catch {
      return null;
    }
  }

  /** Sends every waiting annotation; a failure to read the folder is logged once and leaves them for the next poll. */
  function sendAnnotations(): void {
    try {
      for (const annotation of spool.takeAll((name) => console.error(`skipped ${name}, which holds no annotation`))) {
        const report: AnnotationReport = { t: "annotation", annotation };
        process.stdout.write(encodeLine(report));
      }
    } catch (error) {
      if (!hasLoggedSpoolError) {
        hasLoggedSpoolError = true;
        console.error(`failed to take the annotations of ${spool.dir}: ${messageOf(error)}`);
      }
    }
  }

  /**
   * Sends the report when it changed and the annotations that arrived; a client that stops reading gets the report of
   * the time it catches up, and the annotations stay in the spool folder until then.
   */
  function poll(): void {
    if (process.stdout.writableNeedDrain) return;
    const line = encodeLine(reportOf(readStatus(), Date.now(), startedAt, readSwfRecordAt()));
    if (line !== lastLine) {
      lastLine = line;
      process.stdout.write(line);
    }
    sendAnnotations();
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

// Node resolves the symlink /srv/hunt/current in the module's URL, not in argv.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
