import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

describe("main", () => {
  let close = () => {};

  afterEach(() => {
    close();
  });

  it("listens on 127.0.0.1:9180 when run as a script", async () => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./wake.main.ts", import.meta.url))], { stdio: ["ignore", "pipe", "ignore"] });
    close = () => child.kill();
    const line = await new Promise<string>((resolve) => child.stdout.once("data", (chunk: Buffer) => resolve(chunk.toString())));
    expect(line).toMatch(/^(listening on 127\.0\.0\.1:9180|failed to serve 127\.0\.0\.1:9180: .*EADDRINUSE)/);
  });
});
