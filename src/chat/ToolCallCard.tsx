import { useState } from "react";
import type { ToolCallContent } from "@agentclientprotocol/sdk";
import type { ToolCallView } from "../ipc/types";
import { InlineDiff } from "../diff/InlineDiff";
import { describeToolResult, formatToolTitle } from "./toolDisplay";

/** Status dot per tool state: green done, red failed, pulsing while running. */
const STATUS_DOT: Record<string, string> = {
  pending: "bg-neutral-500 animate-pulse",
  in_progress: "bg-sky-400 animate-pulse",
  completed: "bg-emerald-400",
  failed: "bg-red-400",
};

/**
 * One tool use as a compact row: status dot, tool name, argument and a short result label.
 * Clicking the row unfolds the output or diff; `isVerbose` (ctrl+o) unfolds every row at once.
 * `basePath` is stripped from arguments so worktree paths read as repo-relative paths.
 */
export function ToolCallCard({ toolCall, isVerbose, basePath }: { toolCall: ToolCallView; isVerbose: boolean; basePath: string }) {
  const [expandedOverride, setExpandedOverride] = useState<boolean | null>(null);
  const title = formatToolTitle(toolCall);
  const result = describeToolResult(toolCall);
  const isFailed = toolCall.status === "failed";
  const hasBody = Boolean(result.text) || result.diffs.length > 0;
  const isExpanded = hasBody && (expandedOverride ?? (isVerbose || !result.isCollapsedByDefault));
  const argument = title.argument === null ? null : stripBasePath(title.argument, basePath);

  return (
    <div className="chat-mono">
      <button
        type="button"
        onClick={() => setExpandedOverride(!isExpanded)}
        disabled={!hasBody}
        title={argument ?? undefined}
        className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left enabled:hover:bg-(--row-hover)"
      >
        <span className={`size-1.5 shrink-0 rounded-full ${STATUS_DOT[toolCall.status] ?? "bg-neutral-500"}`} />
        <span className={`shrink-0 font-medium ${isFailed ? "text-red-300" : "text-neutral-200"}`}>{title.name}</span>
        {argument !== null ? <span className="min-w-0 flex-1 truncate text-neutral-400">{argument}</span> : <span className="flex-1" />}
        {result.summary ? <span className={`shrink-0 ${isFailed ? "text-red-300" : "text-neutral-500"}`}>{result.summary}</span> : null}
        {hasBody ? <Chevron expanded={isExpanded} /> : null}
      </button>
      {isExpanded ? (
        <div className="flex flex-col gap-1.5 border-t border-(--line) px-3 py-2">
          {result.diffs.map((diff, index) => (
            <InlineDiff key={index} path={diff.path} oldText={diff.oldText ?? ""} newText={diff.newText} showHeader={false} />
          ))}
          {result.text ? <OutputBlock text={result.text} isError={isFailed} /> : null}
        </div>
      ) : null}
    </div>
  );
}

/** Replaces the session's worktree prefix in a tool argument with a repo-relative path. */
function stripBasePath(argument: string, basePath: string): string {
  if (!basePath) return argument;
  return argument.split(`${basePath}/`).join("").split(basePath).join(".");
}

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={`size-3.5 shrink-0 text-neutral-500 transition-transform ${expanded ? "rotate-90" : ""}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  );
}

/** Full tool payload for a permission request: diffs, text content, or the raw input when nothing else is available. */
export function ToolCallBody({ content, rawInput }: { content: ToolCallContent[]; rawInput: unknown }) {
  const diffs = content.filter((entry): entry is Extract<ToolCallContent, { type: "diff" }> => entry.type === "diff");
  const texts = content
    .filter((entry): entry is Extract<ToolCallContent, { type: "content" }> => entry.type === "content")
    .map((entry) => (entry.content.type === "text" ? entry.content.text : `[${entry.content.type}]`));
  const rawText = rawInput === undefined || rawInput === null ? "" : typeof rawInput === "string" ? rawInput : JSON.stringify(rawInput, null, 2);

  return (
    <div className="chat-mono flex flex-col gap-1">
      {diffs.map((diff, index) => (
        <InlineDiff key={index} path={diff.path} oldText={diff.oldText ?? ""} newText={diff.newText} showHeader={false} />
      ))}
      {texts.map((text, index) => (
        <OutputBlock key={index} text={text} />
      ))}
      {!diffs.length && !texts.length && rawText ? <OutputBlock text={rawText} /> : null}
    </div>
  );
}

/** Tool output as preformatted text, scrollable past a fixed height. */
function OutputBlock({ text, isError = false }: { text: string; isError?: boolean }) {
  return (
    <pre className={`max-h-[50vh] overflow-auto whitespace-pre-wrap break-words leading-snug ${isError ? "text-red-300" : "text-neutral-400"}`}>
      {text.replace(/\n$/, "")}
    </pre>
  );
}
