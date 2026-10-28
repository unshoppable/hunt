/**
 * The relay's access to `hunt-session.json` (`hunt-session-config.value-object.ts`): it reads the config at its start
 * and writes back the ID of a new conversation and every mode or config option a client changes. The writes go into the
 * file's object as it is, not through the value object, which drops the fields the relay does not know.
 */
import { readFileSync } from "node:fs";
import { messageOf } from "../../../../libs/domain/src/shared/errors.utils.ts";
import { isRecord } from "../../../../libs/domain/src/shared/json-rpc.utils.ts";
import { HuntSessionConfig } from "./hunt-session-config.value-object.ts";
import { writeJsonAtomic } from "./json-file.utils.ts";

/** Fields the relay writes back; `configOptions` entries are merged into the stored ones. */
export interface ConfigChanges {
  acpSessionId?: string;
  modeId?: string;
  configOptions?: Record<string, string>;
}

/** The config in the file at `path`; the error names the file. */
export function readHuntSessionConfig(path: string): HuntSessionConfig {
  try {
    return HuntSessionConfig.fromJson(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`failed to read ${path}: ${messageOf(error)}`);
  }
}

/** The stored object with `changes` applied; fields the relay does not know are kept. */
export function applyConfigChanges(raw: Record<string, unknown>, changes: ConfigChanges): Record<string, unknown> {
  const next = { ...raw };
  if (changes.acpSessionId) {
    next.acpSessionId = changes.acpSessionId;
  }
  if (changes.modeId) {
    next.modeId = changes.modeId;
  }
  if (changes.configOptions) {
    next.configOptions = { ...(isRecord(raw.configOptions) ? raw.configOptions : {}), ...changes.configOptions };
  }
  return next;
}

/** Applies `changes` to the file as it is now, so edits of other writers in between survive, and replaces it atomically. */
export function updateConfigFile(path: string, changes: ConfigChanges): void {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(raw)) throw new Error(`failed to update ${path}: expected a JSON object`);
  writeJsonAtomic(path, applyConfigChanges(raw, changes));
}
