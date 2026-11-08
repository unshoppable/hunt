/**
 * Prints the plan limits of the Claude account in `CLAUDE_CODE_OAUTH_TOKEN` as one JSON document on stdout
 * (`plan-usage.client.ts`), or the reason it could not read them on stderr with exit status 1. `hunt-ctl plan-usage`
 * runs it as root with the token of the session's relay in its environment only:
 *
 *   CLAUDE_CODE_OAUTH_TOKEN=… /opt/hunt/node/bin/node /srv/hunt/current/session/planUsage.mjs
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { messageOf } from "../../../../libs/domain/src/shared/errors.utils.ts";
import { readPlanUsage } from "./plan-usage.client.ts";

async function main(): Promise<void> {
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) throw new Error("no Claude Code OAuth token in CLAUDE_CODE_OAUTH_TOKEN");
  process.stdout.write(`${JSON.stringify(await readPlanUsage(token))}\n`);
}

// Node resolves the symlink /srv/hunt/current in the module's URL, not in argv.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${messageOf(error)}\n`);
    process.exitCode = 1;
  });
}
