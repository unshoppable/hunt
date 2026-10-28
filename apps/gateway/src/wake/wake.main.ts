/**
 * hunt-wake on the gateway (`hunt-wake.service`): starts a stopped session VM when someone opens its preview.
 *
 *   node /srv/hunt/current/gateway/wake.mjs      (listens on 127.0.0.1:9180)
 *
 * It serves the Waker of `wake/wake.service.ts` on LISTEN_HOST:LISTEN_PORT, calls Compute Engine with the gateway's service account (token and
 * project from the metadata server) and logs to the journal. Runs on Node 24 through type stripping; no dependencies.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createCompute } from "../gcp/compute-engine.client.ts";
import { createMetadata } from "../gcp/metadata-server.client.ts";
import { writeLog } from "../shared/journal.utils.ts";
import { createWakeServer, LISTEN_HOST, LISTEN_PORT, Waker } from "./wake.service.ts";

function main(): void {
  const log = writeLog;
  const server = createWakeServer(new Waker({ compute: createCompute(createMetadata(), fetch, log), now: Date.now, log }), log);
  server.on("error", (error) => {
    log(`failed to serve ${LISTEN_HOST}:${LISTEN_PORT}: ${error.message}`, "fatal");
    process.exit(1);
  });
  server.listen(LISTEN_PORT, LISTEN_HOST, () => log(`listening on ${LISTEN_HOST}:${LISTEN_PORT}`));
}

// Node resolves the symlink /srv/hunt/current in the module's URL, not in argv.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
