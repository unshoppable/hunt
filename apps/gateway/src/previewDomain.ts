/**
 * The preview domain of the gateway's edge proxy: `hunt-ctl install --domain` stores it in `/etc/hunt/preview-domain`,
 * and the edge serves `<short>.<domain>` and `<short>-<port>.<domain>` from it.
 */
import { readFileSync } from "node:fs";
import { messageOf } from "../../../libs/domain/src/errors.ts";

export const DOMAIN_FILE = "/etc/hunt/preview-domain";
/** The check of `DOMAIN_PATTERN` in `libs/vm/hunt-ctl`. */
const DOMAIN_PATTERN = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** The domain in `path`. Throws without one. */
export function readDomain(path = DOMAIN_FILE): string {
  let domain: string;
  try {
    domain = readFileSync(path, "utf8").trim();
  } catch (error) {
    throw new Error(`no preview domain in ${path}: ${messageOf(error)}`);
  }
  if (!DOMAIN_PATTERN.test(domain)) throw new Error(`${path} holds no host name`);
  return domain;
}
