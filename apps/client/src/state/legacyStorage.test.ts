import { describe, expect, it } from "vitest";
import { renameLegacyKeys } from "./legacyStorage";

/** In-memory stand-in for localStorage. */
function storageOf(entries: Record<string, string>) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    get length() {
      return map.size;
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

describe("renameLegacyKeys", () => {
  it("moves every harness entry to its hunt name and leaves the rest alone", () => {
    const storage = storageOf({
      "harness-settings": '{"a":1}',
      "harness.lastRepoPath": "/repo",
      "react-resizable-panels:harness-main": "[1,2]",
      other: "kept",
    });

    renameLegacyKeys(storage);

    expect(Object.fromEntries(storage.map)).toEqual({
      "hunt-settings": '{"a":1}',
      "hunt.lastRepoPath": "/repo",
      "react-resizable-panels:hunt-main": "[1,2]",
      other: "kept",
    });
  });

  it("keeps a value already stored under the new name and drops the old entry", () => {
    const storage = storageOf({ "harness-settings": "old", "hunt-settings": "new" });

    renameLegacyKeys(storage);

    expect(Object.fromEntries(storage.map)).toEqual({ "hunt-settings": "new" });
  });
});
