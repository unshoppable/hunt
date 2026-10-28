import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Metadata } from "../gcp/metadata-server.client.ts";
import { secretsReader } from "./swf-secrets.utils.ts";

const CLAUDE_TOKEN = "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz";

describe("secretsReader", () => {
  const metadata: Metadata = { project: async () => "medconomy-hunt", zone: async () => "europe-west3-a", accessToken: async () => "ya29.x", attribute: async () => null };
  const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();

  /** A Secret Manager answering the three secrets with `values`, counting the reads. */
  function fakeSecrets(values: Record<string, string>) {
    let reads = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      reads++;
      const name = /secrets\/([A-Z_]+)\/versions/.exec(String(input))?.[1] ?? "";
      return Response.json({ payload: { data: Buffer.from(values[name] ?? "").toString("base64") } });
    }) as typeof fetch;
    return { fetchImpl, reads: () => reads };
  }

  it("reads the app's id and key and the Claude token, and reads them again after their ttl", async () => {
    let now = 0;
    const { fetchImpl, reads } = fakeSecrets({ HUNT_SWF_GITHUB_APP_ID: "4711\n", HUNT_SWF_GITHUB_APP_KEY: pem, HUNT_SWF_CLAUDE_TOKEN: CLAUDE_TOKEN });
    const read = secretsReader(metadata, fetchImpl, () => now);
    const secrets = await read();
    expect(secrets.claude).toBe(CLAUDE_TOKEN);
    expect(secrets.app.appId).toBe("4711");
    expect(secrets.app.privateKey.asymmetricKeyType).toBe("rsa");
    now = 9 * 60_000;
    expect(await read()).toBe(secrets);
    expect(reads()).toBe(3);
    now = 11 * 60_000;
    expect(await read()).not.toBe(secrets);
    expect(reads()).toBe(6);
  });

  it("rejects an id that is no number and a key that is no private key, without quoting either", async () => {
    const badId = secretsReader(metadata, fakeSecrets({ HUNT_SWF_GITHUB_APP_ID: "Iv1.abc", HUNT_SWF_GITHUB_APP_KEY: pem, HUNT_SWF_CLAUDE_TOKEN: CLAUDE_TOKEN }).fetchImpl);
    await expect(badId()).rejects.toThrow("failed to read the secret HUNT_SWF_GITHUB_APP_ID: its latest version is no GitHub App id");
    const badKey = secretsReader(metadata, fakeSecrets({ HUNT_SWF_GITHUB_APP_ID: "4711", HUNT_SWF_GITHUB_APP_KEY: "not a key", HUNT_SWF_CLAUDE_TOKEN: CLAUDE_TOKEN }).fetchImpl);
    await expect(badKey()).rejects.toThrow(/^failed to read the secret HUNT_SWF_GITHUB_APP_KEY: its latest version is no private key: (?!.*not a key)/);
  });
});
