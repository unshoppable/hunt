import type { ChecksStatus } from "../checks/checks.types";
import { checkRows } from "../checks/checks.utils";

/** Throws an Error when the hunt.json of `status` declares no check `name`. */
export function ensureDeclaredCheck(status: ChecksStatus, name: string): void {
  if (status.definitions.some((definition) => definition.name === name)) return;
  const names = status.definitions.map((definition) => definition.name);
  throw new Error(names.length ? `hunt.json declares no check ${name}; its checks are ${names.join(", ")}` : `hunt.json declares no checks`);
}

/** Throws an Error when the check `name` of `status` is not declared or not running. */
export function ensureRunningCheck(status: ChecksStatus, name: string): void {
  ensureDeclaredCheck(status, name);
  const row = checkRows(status).find((candidate) => candidate.definition.name === name);
  if (row?.run?.state !== "running") throw new Error(`the check ${name} is not running`);
}
