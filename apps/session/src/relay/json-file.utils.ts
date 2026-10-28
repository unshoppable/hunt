import { renameSync, writeFileSync } from "node:fs";

/** Writes `value` as JSON through a temporary file next to `path` and a rename, so readers never see a partial file. */
export function writeJsonAtomic(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}
