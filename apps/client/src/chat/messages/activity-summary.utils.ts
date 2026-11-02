import type { ToolCallStatus } from "@agentclientprotocol/sdk";
import type { ChatItem } from "../chat.types";
import { pluralize, stripBasePath } from "./tool-display.utils";

export type ActivitySummary = {
  /** Header of the folded activity card, e.g. `7 tool calls` or `3 tool calls, 1 thought`. */
  label: string;
  /** `in_progress` while one tool still runs, then `failed` when one failed, otherwise `completed`. */
  status: ToolCallStatus;
  /** Worktree-relative paths the card's tools wrote or edited, in the order first touched. */
  files: string[];
};

/** What the folded card of consecutive tool calls and thoughts shows instead of their rows. */
export function summarizeActivity(items: ChatItem[], basePath: string): ActivitySummary {
  const toolCalls = items.flatMap((item) => (item.kind === "tool" ? [item.toolCall] : []));
  const thoughtCount = items.filter((item) => item.kind === "thought").length;
  const statuses = toolCalls.map((toolCall) => toolCall.status);
  let status: ToolCallStatus = "completed";
  if (statuses.some((entry) => entry === "pending" || entry === "in_progress")) status = "in_progress";
  else if (statuses.includes("failed")) status = "failed";

  const files = new Set<string>();
  for (const toolCall of toolCalls) {
    if (toolCall.kind !== "edit" || toolCall.status !== "completed") continue;
    const diffPaths = toolCall.content.flatMap((entry) => (entry.type === "diff" ? [entry.path] : []));
    for (const path of diffPaths.length ? diffPaths : toolCall.locations.map((location) => location.path)) files.add(stripBasePath(path, basePath));
  }

  const counts = [toolCalls.length ? pluralize(toolCalls.length, "tool call") : null, thoughtCount ? pluralize(thoughtCount, "thought") : null];
  return { label: counts.filter(Boolean).join(", "), status, files: [...files] };
}
