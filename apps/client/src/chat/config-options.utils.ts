import type { SessionConfigOption, SessionConfigSelectOption } from "@agentclientprotocol/sdk";
import { SESSION_MODES, type SessionMode } from "./chat.store-slice";
import type { DropdownOption } from "../ui/floating-menu.utils";

export type SelectConfigOption = Extract<SessionConfigOption, { type: "select" }>;

/** A dropdown config option by ID, e.g. `model` or `effort`; `null` when the agent does not offer it. */
export function findSelectOption(options: SessionConfigOption[], id: string): SelectConfigOption | null {
  const option = options.find((candidate) => candidate.id === id);
  return option?.type === "select" ? option : null;
}

/** Flattens grouped select options into one list of choices. */
export function listChoices(option: SelectConfigOption): SessionConfigSelectOption[] {
  return option.options.flatMap((entry) => ("options" in entry ? entry.options : [entry]));
}

/**
 * The choices of a select option as dropdown entries, with the agent's description of each. Of the models only the
 * current ones: the agent lists the current model of each family by its alias (`opus`, `fable`) and older versions by
 * their full ID (`claude-fable-5-1`), which stays only while the session runs on it.
 */
export function listChoiceOptions(option: SelectConfigOption): DropdownOption[] {
  return listChoices(option)
    .filter((choice) => option.id !== "model" || !choice.value.startsWith("claude-") || choice.value === option.currentValue)
    .map((choice) => ({ id: choice.value, name: choice.name, description: choice.description }));
}

/**
 * Modes the agent offers for a session, from its `mode` config option: auto only for models that support it, bypass
 * only when the agent allows it. Falls back to the full catalog before the agent has announced its options.
 */
export function listModes(options: SessionConfigOption[]): SessionMode[] {
  const option = findSelectOption(options, "mode");
  if (!option) return SESSION_MODES;
  return listChoiceOptions(option);
}
