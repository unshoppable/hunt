import type { AvailableCommand } from "@agentclientprotocol/sdk";

/** Most suggestions the prompt box lists for one query. */
export const MAX_SUGGESTIONS = 10;

/**
 * `/clear` as the chat offers it: the agent handles the prompt but leaves the command out of its announced list, so
 * the chat adds it in front of the agent's commands.
 */
export const CLEAR_COMMAND: AvailableCommand = { name: "clear", description: "Clear the conversation and start over with an empty context" };

/**
 * The command query the prompt text holds, without the leading slash: the text starts with `/` and has no whitespace
 * yet, so the user is still naming the command. `null` for every other text.
 */
export function slashQueryOf(text: string): string | null {
  if (!text.startsWith("/") || /\s/.test(text)) return null;
  return text.slice(1);
}

/**
 * The commands matching `query` in the order the prompt box lists them: names starting with the query, then names
 * containing it, then descriptions containing it; each group keeps the agent's order. Case-insensitive.
 */
export function matchCommands(commands: AvailableCommand[], query: string, limit = MAX_SUGGESTIONS): AvailableCommand[] {
  const needle = query.toLowerCase();
  const byName = commands.filter((command) => command.name.toLowerCase().startsWith(needle));
  const inName = commands.filter((command) => !byName.includes(command) && command.name.toLowerCase().includes(needle));
  const inDescription = needle
    ? commands.filter((command) => !byName.includes(command) && !inName.includes(command) && command.description.toLowerCase().includes(needle))
    : [];
  return [...byName, ...inName, ...inDescription].slice(0, limit);
}
