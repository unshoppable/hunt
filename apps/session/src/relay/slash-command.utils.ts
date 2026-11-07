/**
 * Whether a prompt runs one of the session's slash commands (`/compact`, a skill, …) rather than talking to the agent,
 * free of I/O. Claude Code runs such a command as a turn of its own; one steered into a running turn ends that turn
 * first, so the agent stops where it was. The relay reports it in `lastTurnTookCommand` of its status.
 */
import { isRecord, type JsonRpcNotification } from "../../../../libs/domain/src/shared/json-rpc.utils.ts";

/** `/name` at the start of a prompt's text, the name the first group. */
const COMMAND_PATTERN = /^\/([^\s/]+)(?:\s|$)/;

/**
 * Whether the `session/prompt` (or steered) params `params` start with a command that `commands`, the session's latest
 * `available_commands_update`, lists; without that update no prompt counts as a command.
 */
export function isCommandPrompt(params: unknown, commands: JsonRpcNotification | null): boolean {
  const blocks = isRecord(params) && Array.isArray(params.prompt) ? params.prompt : [];
  const first: unknown = blocks[0];
  if (!isRecord(first) || first.type !== "text" || typeof first.text !== "string") return false;
  const match = COMMAND_PATTERN.exec(first.text.trimStart());
  return match !== null && commandNames(commands).has(match[1]);
}

/** The names of the commands an `available_commands_update` lists. */
function commandNames(commands: JsonRpcNotification | null): Set<string> {
  const params = commands?.params;
  const update = isRecord(params) && isRecord(params.update) ? params.update : null;
  const available = update && Array.isArray(update.availableCommands) ? update.availableCommands : [];
  return new Set(available.flatMap((command) => (isRecord(command) && typeof command.name === "string" ? [command.name] : [])));
}
