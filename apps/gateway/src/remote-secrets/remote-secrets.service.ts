/**
 * The remote secrets (`libs/domain/src/remote-secrets/remote-secrets.utils.ts`) in the Secret Manager secret HUNT_REMOTE_SECRETS, whose
 * latest version holds all of them as one JSON object. hunt-api lists and changes them for the gateway API, one change
 * at a time: it reads the latest version, adds the changed object as a new version and destroys every other one, so
 * that a replaced or deleted value does not linger. The session VM service (`session-vm/session-vm.service.ts`) reads them
 * for each session VM it brings up. Values never reach a log line or an error message.
 */
import { messageOf } from "../../../../libs/domain/src/shared/errors.utils.ts";
import type { Log } from "../../../../libs/domain/src/shared/journal.utils.ts";
import { RemoteSecret, type RemoteSecretSummary } from "../../../../libs/domain/src/remote-secrets/remote-secret.value-object.ts";
import { MAX_REMOTE_SECRETS, parseRemoteSecrets, REMOTE_SECRETS_SECRET } from "../../../../libs/domain/src/remote-secrets/remote-secrets.utils.ts";
import { ApiError } from "../../../../libs/domain/src/gateway-api/api.error.ts";
import type { Metadata } from "../gcp/metadata-server.client.ts";
import {
  addSecretVersion,
  destroySecretVersion,
  listEnabledSecretVersions,
  NO_SECRET_VERSION,
  readOptionalSecretBytes,
  type OptionalSecret,
} from "../gcp/secret-manager.client.ts";

/** The largest payload of a Secret Manager version. */
const MAX_STORED_BYTES = 64 * 1024;

export interface RemoteSecretStore {
  /** The remote secrets by name, each with the hint of its value. */
  list(): Promise<RemoteSecretSummary[]>;
  /** Every remote secret by name, for a session VM; none, with a warning, while the gateway may not read the secret. */
  all(): Promise<Record<string, string>>;
  /** Stores `secret`, replacing the remote secret of the same name. */
  set(secret: RemoteSecret): Promise<void>;
  /** Deletes the remote secret `name`; false when there was none. */
  delete(name: string): Promise<boolean>;
}

export interface RemoteSecretStoreDeps {
  read(name: string): Promise<OptionalSecret>;
  addVersion(name: string, bytes: Buffer): Promise<string>;
  listVersions(name: string): Promise<string[]>;
  destroyVersion(version: string): Promise<void>;
  log: Log;
}

/** The store of the gateway's project, through Secret Manager with the gateway's access token. */
export function remoteSecretStore(metadata: Metadata, log: Log): RemoteSecretStore {
  return createRemoteSecretStore({
    read: (name) => readOptionalSecretBytes(metadata, name),
    addVersion: (name, bytes) => addSecretVersion(metadata, name, bytes),
    listVersions: (name) => listEnabledSecretVersions(metadata, name),
    destroyVersion: (version) => destroySecretVersion(metadata, version),
    log,
  });
}

export function createRemoteSecretStore(deps: RemoteSecretStoreDeps): RemoteSecretStore {
  let changes: Promise<unknown> = Promise.resolve();

  /** The stored secrets, or why the gateway cannot read them; a secret without a version holds none. */
  async function read(): Promise<{ secrets: Record<string, string> } | { absent: string }> {
    const stored = await deps.read(REMOTE_SECRETS_SECRET);
    if (stored.absent !== undefined) return stored.absent === NO_SECRET_VERSION ? { secrets: {} } : { absent: stored.absent };
    try {
      return { secrets: parseRemoteSecrets(stored.bytes.toString("utf8")) };
    } catch (error) {
      throw new Error(`failed to read the remote secrets from the secret ${REMOTE_SECRETS_SECRET}: ${messageOf(error)}`);
    }
  }

  async function readable(): Promise<Record<string, string>> {
    const stored = await read();
    if ("absent" in stored) {
      throw new ApiError("unavailable", `the secret ${REMOTE_SECRETS_SECRET} ${stored.absent}; the infrastructure repository creates it for the gateway`);
    }
    return stored.secrets;
  }

  /** Stores `secrets` as the latest version and destroys the others; a version left behind is only logged. */
  async function write(secrets: Record<string, string>): Promise<void> {
    const names = Object.keys(secrets).sort();
    if (names.length > MAX_REMOTE_SECRETS) throw new ApiError("invalidParams", `there may be at most ${MAX_REMOTE_SECRETS} remote secrets`);
    const bytes = Buffer.from(JSON.stringify(Object.fromEntries(names.map((name) => [name, secrets[name]]))));
    if (bytes.length > MAX_STORED_BYTES) throw new ApiError("invalidParams", `the remote secrets may take at most ${MAX_STORED_BYTES} bytes together`);
    const added = await deps.addVersion(REMOTE_SECRETS_SECRET, bytes);
    try {
      for (const version of await deps.listVersions(REMOTE_SECRETS_SECRET)) {
        if (version === added) continue;
        await deps.destroyVersion(version);
      }
    } catch (error) {
      deps.log(`failed to destroy the older versions of the secret ${REMOTE_SECRETS_SECRET}: ${messageOf(error)}`, "error");
    }
  }

  /** Runs `change` on the stored secrets after every change before it. */
  function serialized<T>(change: (secrets: Record<string, string>) => Promise<T>): Promise<T> {
    const result = changes.then(async () => change(await readable()));
    changes = result.catch(() => {});
    return result;
  }

  return {
    async list() {
      const secrets = await readable();
      return Object.keys(secrets)
        .sort()
        .map((name) => new RemoteSecret({ name, value: secrets[name] }).summary());
    },
    async all() {
      const stored = await read();
      if ("secrets" in stored) return stored.secrets;
      deps.log(`no remote secrets for the session VM: the secret ${REMOTE_SECRETS_SECRET} ${stored.absent}`, "warn");
      return {};
    },
    set(secret) {
      return serialized(async (secrets) => {
        await write({ ...secrets, [secret.name]: secret.value });
      });
    },
    delete(name) {
      return serialized(async (secrets) => {
        if (!Object.hasOwn(secrets, name)) return false;
        const rest = { ...secrets };
        delete rest[name];
        await write(rest);
        return true;
      });
    },
  };
}
