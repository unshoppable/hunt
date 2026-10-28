/**
 * The environments on a session VM: the session's own, which every command inherits, and that of each service, with
 * its placeholders resolved and its remote secrets, in the format of a systemd EnvironmentFile.
 */
import { join } from "node:path";
import type { ServiceConfig } from "./service-config.value-object.ts";
import type { SessionHost } from "./session-host.value-object.ts";

/** The session's environment: `HUNT_PREVIEW_URL_TEMPLATE`, the URL of a port with `{port}` in its place. */
export function sessionEnv(host: SessionHost): Record<string, string> {
  return { HUNT_PREVIEW_URL_TEMPLATE: host.previewUrlTemplate };
}

/**
 * The environment of each service by name: its variables with `${services.<name>.publicUrl}` resolved, its remote
 * secrets from `secrets` (a missing one is left out), then `HUNT_SERVICE_DIR`, the folder the service runs in in
 * `worktree`, and `HUNT_SERVICE_COMMAND`, its command line.
 */
export function serviceEnvs(
  services: readonly ServiceConfig[],
  host: SessionHost,
  worktree: string,
  secrets: Readonly<Record<string, string>> = {},
): Record<string, Record<string, string>> {
  const publicUrls = new Map(services.map((service) => [service.name, service.publicUrl(host)]));
  const envs: Record<string, Record<string, string>> = {};
  for (const service of services) {
    envs[service.name] = {
      ...service.resolveEnv(publicUrls),
      ...Object.fromEntries(Object.entries(service.remoteSecrets).flatMap(([key, name]) => (Object.hasOwn(secrets, name) ? [[key, secrets[name]]] : []))),
      HUNT_SERVICE_DIR: service.cwd ? join(worktree, service.cwd) : worktree,
      HUNT_SERVICE_COMMAND: service.command,
    };
  }
  return envs;
}

/**
 * `env` as a systemd EnvironmentFile: `header` as a comment line, then one double-quoted assignment per line with `\`,
 * `"`, `` ` `` and `$` escaped, which systemd and a POSIX shell read back verbatim. Values must be single lines.
 */
export function envFile(env: Record<string, string>, header: string): string {
  const lines = Object.entries(env).map(([key, value]) => `${key}="${value.replace(/[\\"`$]/g, "\\$&")}"`);
  return `# ${header}\n${lines.join("\n")}\n`;
}
