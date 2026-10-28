/** Writes the relay's `status.json` (`libs/domain/src/relay/relay-status.types.ts`) on every change and as a heartbeat. */
import type { RelayStatus } from "../../../../libs/domain/src/relay/relay-status.types.ts";
import { writeJsonAtomic } from "./json-file.utils.ts";

/** How often the relay rewrites an unchanged status as its heartbeat. */
export const HEARTBEAT_INTERVAL_MS = 30_000;

export function writeStatusFile(path: string, status: RelayStatus): void {
  writeJsonAtomic(path, status);
}
