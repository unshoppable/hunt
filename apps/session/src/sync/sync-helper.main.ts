/**
 * The live file sync of a session VM's worktree with the desktop client, which starts it over the session's SSH
 * connection and keeps it open:
 *
 *   sudo -n -u agent /opt/hunt/node/bin/node /srv/hunt/current/session/syncHelper.mjs <worktree>
 *
 * It speaks the NDJSON protocol of `sync-protocol.types.ts` on stdin and stdout through the SyncHelper of
 * `sync-helper.service.ts` and writes diagnostics to stderr. It exits when stdin ends.
 */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { messageOf } from "../../../../libs/domain/src/shared/errors.utils.ts";
import { createLineDecoder, encodeLine } from "../../../../libs/domain/src/shared/ndjson.utils.ts";
import { SyncHelper, type HelperOutput } from "./sync-helper.service.ts";

const USAGE = "usage: syncHelper.mjs <worktree>";
/** Output the client has not read yet beyond which the helper stops reporting and asks for a full sync. */
const MAX_OUTPUT_BACKLOG_BYTES = 64 * 1024 * 1024;

function main(): void {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !args[0]) {
    console.error(USAGE);
    process.exit(2);
  }
  let isBehind = false;
  const output: HelperOutput = {
    send(message) {
      process.stdout.write(encodeLine(message));
      if (process.stdout.writableLength > MAX_OUTPUT_BACKLOG_BYTES) {
        isBehind = true;
      }
    },
    isBehind: () => isBehind,
  };
  const helper = new SyncHelper(resolve(args[0]), output, (message) => console.error(message));
  process.stdout.on("drain", () => {
    if (!isBehind) return;
    isBehind = false;
    helper.onCaughtUp();
  });
  process.stdout.on("error", () => process.exit(0));
  try {
    helper.start();
  } catch (error) {
    console.error(`failed to start the sync of ${args[0]}: ${messageOf(error)}`);
    process.exit(1);
  }
  process.stdin.setEncoding("utf8");
  const lines = createLineDecoder((line) => {
    try {
      helper.handleLine(line);
    } catch (error) {
      console.error(`failed to handle a request: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      output.send({ t: "error", message: `failed to handle a request: ${messageOf(error)}` });
    }
  });
  process.stdin.on("data", (chunk: string) => lines.push(chunk));
  process.stdin.on("end", () => process.exit(0));
}

// Node resolves the symlink /srv/hunt/current in the module's URL, not in argv.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
