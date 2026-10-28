import * as z from "zod/mini";

/** At least two labels, the last of letters only; hunt-ctl's DOMAIN_PATTERN and apps/client/src-tauri/src/remote/preview.rs check the same. */
const PREVIEW_DOMAIN = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
/** Leaves room for the `<short>-<port>-open.` in front of the domain within the 253 characters of a host name. */
const MAX_PREVIEW_DOMAIN_LENGTH = 253 - "01234567-65535-open.".length;
const PREVIEW_DOMAIN_RULE = "must be a lowercase host name with at least two labels, the last of letters only";

/**
 * The preview domain of the gateway's edge proxy, below which the hosts of every session's preview lie
 * (`<short>-<port>-open.<domain>` the longest); hunt-ctl's MAX_DOMAIN_LENGTH caps it the same.
 */
export const ZodPreviewDomain = z.string({ error: PREVIEW_DOMAIN_RULE }).check(
  z.refine((domain) => domain.length <= MAX_PREVIEW_DOMAIN_LENGTH && PREVIEW_DOMAIN.test(domain), PREVIEW_DOMAIN_RULE),
);
