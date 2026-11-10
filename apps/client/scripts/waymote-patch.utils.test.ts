import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { isWaymoteSdk, patchWaymoteSdk } from "./waymote-patch.utils.ts";

describe("patchWaymoteSdk", () => {
  it("makes room for a whole burst in both queues", () => {
    const patched = patchWaymoteSdk("if (pendingDecoderMessages.length >= 6) {}\nif (discontinuity || decoder.decodeQueueSize > 6) {}");
    expect(patched).toBe("if (pendingDecoderMessages.length >= 64) {}\nif (discontinuity || decoder.decodeQueueSize > 64) {}");
  });

  it("applies to the installed SDK", () => {
    const sdk = readFileSync(createRequire(import.meta.url).resolve("@rockorager/waymote"), "utf8");
    expect(patchWaymoteSdk(sdk)).not.toBe(sdk);
  });

  it("rejects a source without one of the places", () => {
    expect(() => patchWaymoteSdk("if (pendingDecoderMessages.length >= 6) {}")).toThrow("decoder.decodeQueueSize > 6");
  });

  it("rejects a source with a place twice", () => {
    const place = "pendingDecoderMessages.length >= 6";
    expect(() => patchWaymoteSdk(`${place}; ${place}; decoder.decodeQueueSize > 6`)).toThrow("found it 2 times");
  });
});

describe("isWaymoteSdk", () => {
  it("matches the SDK file with and without a query", () => {
    expect(isWaymoteSdk("/repo/node_modules/@rockorager/waymote/waymote.js")).toBe(true);
    expect(isWaymoteSdk("/repo/node_modules/@rockorager/waymote/waymote.js?v=1")).toBe(true);
    expect(isWaymoteSdk("/repo/node_modules/@rockorager/waymote/audio-player.js")).toBe(false);
  });
});
