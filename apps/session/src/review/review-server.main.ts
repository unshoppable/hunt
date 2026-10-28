/**
 * The review server of a session VM's preview proxy (`review-server.service.ts`), run by `hunt-review.service` as the
 * user `agent`:
 *
 *   node /srv/hunt/current/session/reviewServer.mjs [--listen <host>:<port>] [--spool <folder>] [--widget <file>]
 *
 * It listens on 127.0.0.1:9232, the spool folder is `/run/hunt-review/annotations` (`annotation-spool.service.ts`) and the
 * widget `review.js` next to this module, unless the options say otherwise. It logs to stderr, which systemd hands to the
 * journal. Runs on Node 24 through type stripping; no dependencies.
 */
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { messageOf } from "../../../../libs/domain/src/shared/errors.utils.ts";
import { AnnotationSpool } from "./annotation-spool.service.ts";
import { createReviewServer, log, parseOptions, type ReviewServerOptions } from "./review-server.service.ts";

function main(): void {
  let options: ReviewServerOptions;
  try {
    options = parseOptions(process.argv.slice(2));
  } catch (error) {
    console.error(messageOf(error));
    process.exit(2);
  }
  const spool = new AnnotationSpool(options.spoolDir);
  let widget: Buffer;
  try {
    widget = readFileSync(options.widgetPath);
    spool.create();
  } catch (error) {
    log(`failed to start the review server: ${messageOf(error)}`, "fatal");
    process.exit(1);
  }
  const server = createReviewServer(widget, spool);
  server.listen(options.port, options.host, () => {
    const address = server.address();
    log(`listening on ${typeof address === "object" && address ? `${address.address}:${address.port}` : String(address)}`);
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => process.exit(0));
  }
}

// Node resolves the symlink /srv/hunt/current in the module's URL, not in argv.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
