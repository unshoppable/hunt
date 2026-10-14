/**
 * The built gateway artifact (`nx build gateway`): every entry point runs only its own `main`, although esbuild bundles
 * the modules it imports, CLI guards included, into the same file, and the scripts work without the sources.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ARTIFACT = fileURLToPath(new URL("../../../dist/apps/gateway", import.meta.url));
const ENTRY_GUARD = /realpathSync\d*\(process\.argv\[1\]\)/g;

function node(script: string, args: string[], input = "") {
  const result = spawnSync(process.execPath, [join(ARTIFACT, "gateway", script), ...args], { input, encoding: "utf8", timeout: 20_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("the gateway artifact", () => {
  it("holds the entry points with one main each, the VM files and a release hash", () => {
    const bundles = readdirSync(join(ARTIFACT, "gateway")).sort();
    expect(bundles).toEqual(["api.mjs", "apiClient.mjs", "swf.mjs", "wake.mjs"]);
    for (const bundle of bundles) {
      expect(readFileSync(join(ARTIFACT, "gateway", bundle), "utf8").match(ENTRY_GUARD)?.length ?? 0, bundle).toBeLessThanOrEqual(1);
    }
    expect(statSync(join(ARTIFACT, "vm", "hunt-api")).mode & 0o111).not.toBe(0);
    expect(readFileSync(join(ARTIFACT, ".hash"), "utf8")).toMatch(/^[0-9a-f]{16}\n$/);
    expect(JSON.parse(readFileSync(join(ARTIFACT, "protocol.json"), "utf8"))).toMatchObject({ protocol: expect.any(Number), api: expect.any(Number) });
  });

  it("refuses a malformed API call without the sources", () => {
    expect(node("apiClient.mjs", ["hello; id"])).toMatchObject({
      status: 1,
      stdout: '{"type":"error","code":"invalidParams","message":"usage: hunt-api <method>; \\"hello; id\\" is no method"}\n',
    });
  });
});
