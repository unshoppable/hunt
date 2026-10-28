import { describe, expect, it } from "vitest";
import { redact } from "./redaction.utils.ts";

describe("redact", () => {
  it("redacts the known secrets and anything shaped like a GitHub or Claude token, a JWT or a private key", () => {
    const text = "token github_pat_11ABCDEFG0123456789_abcdefghijkl and sk-ant-oat01-abcdefghijklmnopqrstuvwxyz, ghp_abcdefghijklmnopqrstuvwxyz0123 and s3cr3t-value!";
    expect(redact(text, ["s3cr3t-value", "short"])).toBe("token [redacted] and [redacted], [redacted] and [redacted]!");
    const jwt = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJpYXQiOjEsImV4cCI6MiwiaXNzIjoiMSJ9.c2lnbmF0dXJlLXNpZ25hdHVyZQ";
    const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIE\nAB==\n-----END RSA PRIVATE KEY-----";
    expect(redact(`Bearer ${jwt} ghs_abcdefghijklmnopqrstuvwxyz0123 key ${key} end`, [])).toBe("Bearer [redacted] [redacted] key [redacted] end");
  });
});
