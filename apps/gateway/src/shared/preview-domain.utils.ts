/**
 * The preview domain of the gateway's edge proxy: `hunt-ctl install --domain` stores it in `/etc/hunt/preview-domain`,
 * and the edge serves `<short>.<domain>` and `<short>-<port>.<domain>` behind IAP and `<short>-<port>-open.<domain>`
 * without it.
 */
import { readFileSync } from "node:fs";
import { ZodPreviewDomain } from "../../../../libs/domain/src/session/preview-domain.rules.ts";
import { messageOf } from "../../../../libs/domain/src/shared/errors.utils.ts";

export const DOMAIN_FILE = "/etc/hunt/preview-domain";

/** The domain in `path`. Throws without one. */
export function readDomain(path = DOMAIN_FILE): string {
  let domain: string;
  try {
    domain = readFileSync(path, "utf8").trim();
  } catch (error) {
    throw new Error(`no preview domain in ${path}: ${messageOf(error)}`);
  }
  if (!ZodPreviewDomain.safeParse(domain).success) throw new Error(`${path} holds no host name`);
  return domain;
}
