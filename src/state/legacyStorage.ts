/**
 * Moves the localStorage entries of the time the application was called harness (`harness-settings`,
 * `harness-agent-defaults`, pane layouts, …) to their Hunt names, so settings and layouts survive the rename. An entry
 * already stored under the new name wins. Every window's bootstrap imports this module first, before any store hydrates.
 */
export function renameLegacyKeys(storage: Pick<Storage, "length" | "key" | "getItem" | "setItem" | "removeItem">): void {
  const legacyKeys: string[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key?.includes("harness")) {
      legacyKeys.push(key);
    }
  }
  for (const key of legacyKeys) {
    const renamed = key.replace(/harness/g, "hunt");
    const value = storage.getItem(key);
    if (value !== null && storage.getItem(renamed) === null) {
      storage.setItem(renamed, value);
    }
    storage.removeItem(key);
  }
}

if (typeof window !== "undefined") {
  renameLegacyKeys(window.localStorage);
}
