import type { ToolCallContent } from "@agentclientprotocol/sdk";
import type { ToolCallView } from "../ipc/types";
import { imageDataUrl, imagePlaceholder } from "./imageData";

export type ToolTitle = { name: string; argument: string | null };

type DiffContent = Extract<ToolCallContent, { type: "diff" }>;

export type ToolResult = {
  /** Short trailing label of the tool row, e.g. `120 lines`, `3 files`, `+12 −3` or `4 lines, 1 image`. */
  summary: string | null;
  /** Text output of the tool (terminal output or text content blocks, with a placeholder for an image the chat does not show). */
  text: string;
  /** `data:` URLs of the images the tool returned, e.g. a browser screenshot or a PNG file it read. */
  images: string[];
  diffs: DiffContent[];
  /** Bodies stay folded behind the summary unless expanded; failures open by default. */
  isCollapsedByDefault: boolean;
};

/** Turns an ACP tool title into the terminal's `Name(argument)` form, e.g. `Bash(ls -la)` or `Update(src/app.ts)`. */
export function formatToolTitle(toolCall: ToolCallView): ToolTitle {
  const title = toolCall.title.trim();
  switch (toolCall.kind) {
    case "execute":
      return { name: "Bash", argument: title === "Terminal" ? null : title };
    case "read":
      return { name: "Read", argument: stripPrefix(title, "Read ") };
    case "edit":
      if (title.startsWith("Write ")) return { name: "Write", argument: title.slice("Write ".length) };
      if (title.startsWith("Edit ")) return { name: "Update", argument: title.slice("Edit ".length) };
      return { name: title, argument: null };
    case "search":
      if (title.startsWith("Find")) return { name: "Glob", argument: stripPrefix(title, "Find ")?.replace(/`/g, "") ?? null };
      return { name: "Search", argument: title };
    case "fetch":
      if (title.startsWith("Fetch ")) return { name: "Fetch", argument: title.slice("Fetch ".length) };
      if (title.startsWith("Search ")) return { name: "Web Search", argument: title.slice("Search ".length) };
      return { name: title, argument: null };
    default:
      return { name: title, argument: null };
  }
}

function stripPrefix(text: string, prefix: string): string | null {
  if (!text.startsWith(prefix)) return text || null;
  const rest = text.slice(prefix.length).trim();
  return rest || null;
}

export function describeToolResult(toolCall: ToolCallView): ToolResult {
  const diffs = toolCall.content.filter((entry): entry is DiffContent => entry.type === "diff");
  const { texts, images } = readContent(toolCall.content);
  const text = [toolCall.terminalOutput ?? "", ...texts].filter(Boolean).join("\n");
  const lineCount = countLines(text);
  const isFailed = toolCall.status === "failed";
  const isDone = toolCall.status === "completed" || isFailed;

  if (diffs.length) {
    return { summary: describeDiffs(diffs), text: "", images, diffs, isCollapsedByDefault: !isFailed };
  }
  if (!text && !images.length) {
    if (isFailed) return { summary: "Error", text: "", images, diffs, isCollapsedByDefault: false };
    if (isDone) return { summary: "no output", text: "", images, diffs, isCollapsedByDefault: true };
    return { summary: null, text: "", images, diffs, isCollapsedByDefault: true };
  }
  const unit = toolCall.kind === "search" && (toolCall.title.startsWith("Find") || toolCall.title.includes(" -l ")) ? "file" : "line";
  const textSummary = isFailed ? "Error" : text ? pluralize(lineCount, unit) : null;
  const imageSummary = images.length ? pluralize(images.length, "image") : null;
  return { summary: [textSummary, imageSummary].filter(Boolean).join(", "), text, images, diffs, isCollapsedByDefault: !isFailed };
}

/** The texts and image `data:` URLs of a tool's content blocks; an image the chat does not show adds its placeholder to the texts. */
function readContent(content: ToolCallContent[]): { texts: string[]; images: string[] } {
  const texts: string[] = [];
  const images: string[] = [];
  for (const entry of content) {
    if (entry.type !== "content") continue;
    const block = entry.content;
    const url = block.type === "image" ? imageDataUrl(block) : null;
    if (url) {
      images.push(url);
    } else if (block.type === "image") {
      texts.push(imagePlaceholder(block));
    } else {
      texts.push(block.type === "text" ? block.text : `[${block.type}]`);
    }
  }
  return { texts, images };
}

/** `+12 −3` for edits, `+18` for a fresh write. */
function describeDiffs(diffs: DiffContent[]): string {
  const additions = diffs.reduce((total, diff) => total + countLines(diff.newText), 0);
  const removals = diffs.reduce((total, diff) => total + countLines(diff.oldText ?? ""), 0);
  const isWrite = diffs.every((diff) => diff.oldText === null || diff.oldText === undefined);
  return isWrite ? `+${additions}` : `+${additions} −${removals}`;
}

export function countLines(text: string): number {
  if (!text) return 0;
  return text.replace(/\n$/, "").split("\n").length;
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
