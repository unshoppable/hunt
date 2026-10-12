/**
 * `hunt-session.json`, written by Hunt before the container starts: the conversation the relay loads (`null` starts a
 * new one), its working directory, the system prompt addition and the mode and config options to restore. The relay
 * writes back the ID of a new conversation and every mode or config option a client changes.
 */
import { readFileSync } from "node:fs";
import { writeJsonAtomic } from "./files.ts";
import { isRecord } from "./jsonRpc.ts";

export const DEFAULT_MODE_ID = "bypassPermissions";

export interface HuntSessionConfig {
  acpSessionId: string | null;
  cwd: string;
  systemPromptAppend: string;
  modeId: string;
  /** Config option values by option ID (`model`, `effort`, …), applied in this order. */
  configOptions: Record<string, string>;
}

/** Fields the relay writes back; `configOptions` entries are merged into the stored ones. */
export interface ConfigChanges {
  acpSessionId?: string;
  modeId?: string;
  configOptions?: Record<string, string>;
}

/** Parses the file's text; unknown fields are ignored, missing optional ones get their defaults. */
export function parseConfig(text: string): HuntSessionConfig {
  const raw: unknown = JSON.parse(text);
  if (!isRecord(raw)) throw new Error("expected a JSON object");
  const { acpSessionId, cwd, systemPromptAppend, modeId, configOptions } = raw;
  if (typeof cwd !== "string" || !cwd) throw new Error("cwd must be a non-empty string");
  if (acpSessionId && typeof acpSessionId !== "string") throw new Error("acpSessionId must be a string or null");
  if (systemPromptAppend && typeof systemPromptAppend !== "string") throw new Error("systemPromptAppend must be a string");
  if (modeId && typeof modeId !== "string") throw new Error("modeId must be a string");
  return {
    acpSessionId: typeof acpSessionId === "string" && acpSessionId ? acpSessionId : null,
    cwd,
    systemPromptAppend: typeof systemPromptAppend === "string" ? systemPromptAppend : "",
    modeId: typeof modeId === "string" && modeId ? modeId : DEFAULT_MODE_ID,
    configOptions: parseConfigOptions(configOptions),
  };
}

function parseConfigOptions(value: unknown): Record<string, string> {
  if (!value) return {};
  if (!isRecord(value)) throw new Error("configOptions must be an object");
  const options: Record<string, string> = {};
  for (const [configId, optionValue] of Object.entries(value)) {
    if (typeof optionValue !== "string") throw new Error(`configOptions.${configId} must be a string`);
    options[configId] = optionValue;
  }
  return options;
}

export function readConfig(path: string): HuntSessionConfig {
  try {
    return parseConfig(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`failed to read ${path}: ${(error as Error).message}`);
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
