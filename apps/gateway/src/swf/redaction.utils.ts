/**
 * The redaction of secrets in what hunt-swf writes: its log lines (`swf/swf.main.ts`) and the errors the poller
 * (`swf/poller.service.ts`) logs or comments on an issue.
 */

/** Placeholder for secrets in messages. */
const REDACTED = "[redacted]";
/**
 * Token formats of GitHub and Claude, a JWT (the GitHub App's signed assertion) and a PEM private key, in case one
 * appears that is not among the known secrets.
 */
const TOKEN_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/** `text` with every secret of `secrets` and every token-like string replaced, for logs and issue comments. */
export function redact(text: string, secrets: string[]): string {
  let result = text;
  for (const secret of secrets) {
    if (secret.length >= 8) {
      result = result.split(secret).join(REDACTED);
    }
  }
  for (const pattern of TOKEN_PATTERNS) {
    result = result.replace(pattern, REDACTED);
  }
  return result;
}
