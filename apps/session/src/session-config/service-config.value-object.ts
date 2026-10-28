import * as z from "zod/mini";
import { ValueObject } from "../../../../libs/domain/src/model/value-object.model.ts";
import { REMOTE_SECRET_NAME } from "../../../../libs/domain/src/remote-secrets/remote-secret.value-object.ts";
import {
  PUBLIC_URL_PLACEHOLDER,
  SERVICE_PLACEHOLDER,
  ZodCommandLine,
  ZodEnvValue,
  ZodEnvVariableName,
  ZodFlag,
  ZodGlobPatterns,
  ZodNoContract2Placeholders,
  ZodServiceName,
  ZodServicePlaceholder,
  ZodServicePort,
  ZodWorktreeFolder,
} from "./hunt-json.rules.ts";
import type { SessionHost } from "./session-host.value-object.ts";

/** The name of a remote secret, which ZodRemoteSecretReference reads from its `$<NAME>`. */
const ZodRemoteSecretName = z.string().check(z.regex(REMOTE_SECRET_NAME, `must be the name of a remote secret matching ${REMOTE_SECRET_NAME.source}`));

const ZodServiceConfigState = z
  .object({
    name: ZodServiceName,
    command: ZodCommandLine,
    /** Relative to the worktree; null for the worktree itself. */
    cwd: z._default(z.nullable(ZodWorktreeFolder), null),
    port: ZodServicePort,
    /** Whether the service speaks HTTPS; its certificate is not checked. */
    tls: z._default(ZodFlag, false),
    /** Whether only its port host behind IAP serves it; one that is not guarded also answers at its open host. */
    guarded: z._default(ZodFlag, true),
    /** Whether the HTML pages of its guarded host get the review widget. */
    review: z._default(ZodFlag, true),
    /** The service's variables as hunt.json declares them, placeholders unresolved. */
    env: z._default(z.record(ZodEnvVariableName, ZodEnvValue), () => ({})),
    /** The service's variables whose values are remote secrets: variable → name of the remote secret, without the `$`. */
    remoteSecrets: z._default(z.record(ZodEnvVariableName, ZodRemoteSecretName), () => ({})),
    /** The glob patterns of the ignored files the service needs in a worktree, relative to the worktree. */
    worktreeInclude: z._default(ZodGlobPatterns, () => []),
  })
  .check(
    z.refine(
      (state) => Object.values(state.env).every(hasOnlyContract3Placeholders),
      "the env values hold no placeholder of contract 2 and each ${services.…} as ${services.<name>.publicUrl}",
    ),
    z.refine(
      (state) => Object.keys(state.remoteSecrets).every((key) => !Object.hasOwn(state.env, key)),
      "a variable is set in env or in remoteSecrets, not in both",
    ),
  );

export interface ServiceConfig extends z.infer<typeof ZodServiceConfigState> {}

/**
 * A service of hunt.json, which Hunt runs on a session's VM as a systemd unit: its command line and folder, its port and
 * how the preview proxy serves it, its variables and the ignored files it needs in a worktree.
 */
export class ServiceConfig extends ValueObject<typeof ZodServiceConfigState> {
  static readonly schema = ZodServiceConfigState;

  constructor(value: z.input<typeof ZodServiceConfigState>) {
    super(value);
  }

  /** The services the `${services.<name>.publicUrl}` placeholders of its variables name, each once, in their order. */
  get referencedServices(): string[] {
    const names = Object.values(this.env).flatMap((value) => [...value.matchAll(PUBLIC_URL_PLACEHOLDER)].map(([, name]) => name));
    return [...new Set(names)];
  }

  /** The URL that `${services.<name>.publicUrl}` stands for: the open host of a service that is not guarded, else its port host. */
  publicUrl(host: SessionHost): string {
    return `https://${this.guarded ? host.portHost(this.port) : host.openHost(this.port)}`;
  }

  /** Its variables with each `${services.<name>.publicUrl}` replaced by the URL of that service in `publicUrls`; one it lacks stays. */
  resolveEnv(publicUrls: ReadonlyMap<string, string>): Record<string, string> {
    const resolve = (value: string) => value.replace(PUBLIC_URL_PLACEHOLDER, (placeholder, name: string) => publicUrls.get(name) ?? placeholder);
    return Object.fromEntries(Object.entries(this.env).map(([key, value]) => [key, resolve(value)]));
  }
}

function hasOnlyContract3Placeholders(value: string): boolean {
  if (!ZodNoContract2Placeholders.safeParse(value).success) return false;
  return [...value.matchAll(SERVICE_PLACEHOLDER)].every(([placeholder]) => ZodServicePlaceholder.safeParse(placeholder).success);
}
