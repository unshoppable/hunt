import { describe, expect, it } from "vitest";
import { NO_SECRET_VERSION, type OptionalSecret } from "./gcp.ts";
import { createRemoteSecretStore } from "./remoteSecretStore.ts";

const VERSION_PREFIX = "projects/123/secrets/HUNT_REMOTE_SECRETS/versions/";

/** Secret Manager's HUNT_REMOTE_SECRETS in memory: its enabled versions, the latest last, and every call. */
function fakeSecretManager(initial: Record<string, string> | null, readAs: OptionalSecret | null = null) {
  const versions: { name: string; text: string }[] = initial ? [{ name: `${VERSION_PREFIX}1`, text: JSON.stringify(initial) }] : [];
  const calls: string[] = [];
  const logs: string[] = [];
  let next = versions.length + 1;
  const store = createRemoteSecretStore({
    read: async (name) => {
      calls.push(`read ${name}`);
      if (readAs) return readAs;
      const latest = versions.at(-1);
      return latest ? { bytes: Buffer.from(latest.text) } : { absent: NO_SECRET_VERSION };
    },
    addVersion: async (name, bytes) => {
      calls.push(`add ${name}`);
      const version = { name: `${VERSION_PREFIX}${next++}`, text: bytes.toString("utf8") };
      versions.push(version);
      return version.name;
    },
    listVersions: async (name) => {
      calls.push(`list ${name}`);
      return versions.map((version) => version.name).reverse();
    },
    destroyVersion: async (version) => {
      calls.push(`destroy ${version.slice(VERSION_PREFIX.length)}`);
      versions.splice(versions.findIndex((entry) => entry.name === version), 1);
    },
    log: (message, level = "info") => logs.push(`${level}: ${message}`),
  });
  const stored = () => versions.map((version) => JSON.parse(version.text) as Record<string, string>);
  return { store, calls, logs, stored };
}

describe("the remote secret store", () => {
  it("lists the names with the hints of their values, sorted", async () => {
    const { store } = fakeSecretManager({ TOKEN: "short", MED_OPENAI_API_KEY: "sk-proj-abcdefgh1234" });
    expect(await store.list()).toEqual([
      { name: "MED_OPENAI_API_KEY", hint: "1234" },
      { name: "TOKEN", hint: "" },
    ]);
  });

  it("holds no secrets while the secret has no version", async () => {
    const { store, logs } = fakeSecretManager(null);
    expect(await store.list()).toEqual([]);
    expect(await store.all()).toEqual({});
    expect(logs).toEqual([]);
  });

  it("adds a changed object as the latest version and destroys every other one", async () => {
    const { store, calls, stored } = fakeSecretManager({ A: "1" });

    await store.set("B", "2");
    expect(stored()).toEqual([{ A: "1", B: "2" }]);
    expect(calls).toEqual(["read HUNT_REMOTE_SECRETS", "add HUNT_REMOTE_SECRETS", "list HUNT_REMOTE_SECRETS", "destroy 1"]);
    await store.set("A", "replaced");
    expect(await store.all()).toEqual({ A: "replaced", B: "2" });
    expect(await store.delete("A")).toBe(true);
    expect(await store.delete("A")).toBe(false);
    expect(stored()).toEqual([{ B: "2" }]);
    await store.delete("B");
    expect(stored()).toEqual([{}]);
  });

  it("applies concurrent changes one after the other", async () => {
    const { store, stored } = fakeSecretManager({});
    await Promise.all([store.set("A", "1"), store.set("B", "2"), store.set("C", "3"), store.delete("A")]);
    expect(stored()).toEqual([{ B: "2", C: "3" }]);
  });

  it("refuses a change while the gateway may not read the secret and gives a session VM none, with a warning", async () => {
    const denied = { absent: "cannot be read by the gateway: failed to read it: HTTP 403 denied" };
    const { store, calls, logs } = fakeSecretManager({ A: "sk-secret" }, denied);

    const expected = "the secret HUNT_REMOTE_SECRETS cannot be read by the gateway: failed to read it: HTTP 403 denied; the infrastructure repository creates it";
    await expect(store.set("B", "2")).rejects.toMatchObject({ code: "unavailable", message: expect.stringContaining(expected) });
    await expect(store.list()).rejects.toMatchObject({ code: "unavailable" });
    expect(calls.filter((call) => !call.startsWith("read"))).toEqual([]);
    expect(await store.all()).toEqual({});
    expect(logs).toEqual([`warn: no remote secrets for the session VM: ${expected.slice(0, expected.indexOf(";"))}`]);
  });

  it("refuses more secrets than fit into one version and never names a value", async () => {
    const big = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`K${index}`, "x".repeat(8000)]));
    const { store, calls } = fakeSecretManager(big);
    await expect(store.set("K9", "sk-secret".repeat(100))).rejects.toMatchObject({
      code: "invalidParams",
      message: "the remote secrets may take at most 65536 bytes together",
    });
    expect(calls).toEqual(["read HUNT_REMOTE_SECRETS"]);

    const corrupt = fakeSecretManager(null, { bytes: Buffer.from('{"lower": "sk-secret"}') });
    const reading = corrupt.store.all();
    await expect(reading).rejects.toThrow('failed to read the remote secrets from the secret HUNT_REMOTE_SECRETS: the remote secret "lower" is invalid');
    expect(String(await corrupt.store.list().catch((reason: unknown) => reason))).not.toContain("sk-secret");
  });

  it("logs a version it failed to destroy and keeps the change", async () => {
    const logs: string[] = [];
    const failing = createRemoteSecretStore({
      read: async () => ({ bytes: Buffer.from('{"A": "1"}') }),
      addVersion: async () => `${VERSION_PREFIX}2`,
      listVersions: async () => [`${VERSION_PREFIX}2`, `${VERSION_PREFIX}1`],
      destroyVersion: async () => {
        throw new Error("failed to destroy the secret version 1: HTTP 403 denied");
      },
      log: (message, level = "info") => logs.push(`${level}: ${message}`),
    });
    await expect(failing.set("B", "2")).resolves.toBeUndefined();
    expect(logs).toEqual([
      "error: failed to destroy the older versions of the secret HUNT_REMOTE_SECRETS: failed to destroy the secret version 1: HTTP 403 denied",
    ]);
  });
});
