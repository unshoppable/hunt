/**
 * hunt-api on the gateway (`hunt-api.service`, user hunt-gw): the gateway API of `libs/domain/src/gateway-api/gateway-api.types.ts`, the
 * control plane of remote sessions.
 *
 *   node /srv/hunt/current/gateway/api.mjs      (listens on /run/hunt-api/api.sock)
 *
 * People reach it over SSH as `hunt-api <method>`: sshd forces that command on everyone outside google-sudoers (`vm/hunt-api`), which runs
 * the forwarder `gateway-api/gateway-api-forwarder.main.ts` as hunt-gw through sudo. The forwarder sends one line `{caller, method, params}`
 * over the socket, which only hunt-gw can open, with sudo's SUDO_USER as the caller, and copies the NDJSON events of the answer to stdout.
 * hunt-api serves the API server of `gateway-api/gateway-api.service.ts` on that socket, wired to the session VM service
 * (`createSessionVmService` in `session-vm/session-vm.service.ts`) and the remote secrets in Secret Manager with the gateway's service
 * account. A request's log lines and its outcome, every Compute Engine call and every command on a session VM go to the journal
 * (`shared/journal.utils.ts`). SIGHUP (the unit's reload, after an install) closes the socket and exits once the running requests ended,
 * so that systemd starts the new release. Runs on Node 24 through type stripping; no dependencies.
 */
import { chmodSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { messageOf } from "../../../../libs/domain/src/shared/errors.utils.ts";
import { SOCKET_PATH } from "./gateway-api-protocol.utils.ts";
import { createApiServer } from "./gateway-api.service.ts";
import { createCompute } from "../gcp/compute-engine.client.ts";
import { createMetadata } from "../gcp/metadata-server.client.ts";
import { writeLog } from "../shared/journal.utils.ts";
import { createSessionVmService } from "../session-vm/session-vm.service.ts";
import { readDomain } from "../shared/preview-domain.utils.ts";
import { remoteSecretStore } from "../remote-secrets/remote-secrets.service.ts";
import { ensureSshKey } from "../session-vm/session-vm-ssh.client.ts";

const RELEASE_VERSION_FILE = "/srv/hunt/current/.version";

function readRelease(): string {
  try {
    return readFileSync(RELEASE_VERSION_FILE, "utf8").trim();
  } catch {
    return "";
  }
}

async function main(): Promise<void> {
  const log = writeLog;
  ensureSshKey("hunt-api");
  const metadata = createMetadata();
  const location = { project: await metadata.project(), zone: await metadata.zone() };
  const compute = createCompute(metadata, fetch, log);
  const secrets = remoteSecretStore(metadata, log);
  const sessionVmService = await createSessionVmService(metadata, compute, log, secrets);
  const api = createApiServer({
    sessionVmService,
    secrets,
    gatewayInfo: async () => ({ release: readRelease(), ...location, previewDomain: readDomain() }),
    log,
  });

  // Only hunt-gw opens the socket; the forwarder runs as hunt-gw.
  process.umask(0o077);
  rmSync(SOCKET_PATH, { force: true });
  api.server.on("error", (error) => {
    log(`failed to serve ${SOCKET_PATH}: ${error.message}`, "fatal");
    process.exit(1);
  });
  api.server.listen(SOCKET_PATH, () => {
    chmodSync(SOCKET_PATH, 0o600);
    log(`listening on ${SOCKET_PATH} for ${location.project}/${location.zone}`);
  });
  process.on("SIGHUP", () => {
    log("reload: exiting once the running requests ended");
    void api.drain().then(() => process.exit(0));
  });
}

// Node resolves the symlink /srv/hunt/current in the module's URL, not in argv.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    writeLog(messageOf(error), "fatal");
    process.exit(1);
  });
}
