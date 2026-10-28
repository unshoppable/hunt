import * as z from "zod/mini";
import { ValueObject } from "../../../../libs/domain/src/model/value-object.model.ts";
import { ZodPreviewDomain } from "../../../../libs/domain/src/session/preview-domain.rules.ts";
import { ZodSessionShortId } from "../../../../libs/domain/src/session/session-id.rules.ts";
import { parseField, Problems } from "./problems.utils.ts";

const ZodSessionHostState = z.object({
  /** The first 8 hex digits of the session ID. */
  short: ZodSessionShortId,
  domain: ZodPreviewDomain,
});

export interface SessionHost extends z.infer<typeof ZodSessionHostState> {}

/**
 * The host names of a session's preview below the gateway's preview domain: `<short>-<port>.<domain>` for every port,
 * behind IAP's Google login, `<short>-<port>-open.<domain>` for the port of a service that is not guarded, and
 * `<short>.<domain>`, which has no service.
 */
export class SessionHost extends ValueObject<typeof ZodSessionHostState> {
  static readonly schema = ZodSessionHostState;

  constructor(value: z.input<typeof ZodSessionHostState>) {
    super(value);
  }

  /** The host of `parts` (the command line's `--short` and `--domain`), or every problem of them, its path the flag's name. */
  static fromParts(
    parts: Pick<SessionHost, "short" | "domain">,
  ): { sessionHost: SessionHost; problems?: undefined } | { sessionHost?: undefined; problems: string[] } {
    const problems = new Problems();
    const short = parseField(ZodSessionShortId, parts.short, "short", problems);
    const domain = parseField(ZodPreviewDomain, parts.domain, "domain", problems);
    if (!short || !domain) return { problems: problems.messages };
    return { sessionHost: new SessionHost({ short, domain }) };
  }

  /** `<short>.<domain>`. */
  get mainHost(): string {
    return `${this.short}.${this.domain}`;
  }

  /** The URL of a port host with `{port}` in place of the port. */
  get previewUrlTemplate(): string {
    return `https://${this.portHost("{port}")}`;
  }

  /** `<short>-<port>.<domain>`, the host of `port` behind IAP; `port` may be a placeholder that stands for one. */
  portHost(port: number | string): string {
    return `${this.short}-${port}.${this.domain}`;
  }

  /** `<short>-<port>-open.<domain>`, the host of `port` without IAP, which only a service that is not guarded has. */
  openHost(port: number): string {
    return `${this.short}-${port}-open.${this.domain}`;
  }
}
