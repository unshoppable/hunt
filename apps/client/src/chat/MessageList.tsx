import { Fragment, isValidElement, memo, useState, type ReactNode } from "react";
import { stripGuardrailMarker } from "./guardrailSuggestion";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "../code/CodeBlock";
import { monacoLanguageForFence } from "../diff/monaco";
import type { ChatItem, PlanEntry } from "../ipc/types";
import { ChatImages } from "./ChatImages";
import { splitFencedCode } from "./codePaste";
import { huntPromptNotice } from "./huntPromptNotice";
import { formatMessageTime } from "./messageTime";
import { ToolCallCard } from "./ToolCallCard";
import { WorkingIndicator } from "./WorkingIndicator";

/** Consecutive tool calls and thoughts render as one activity card between the chat messages. */
type Block = { kind: "message"; item: ChatItem } | { kind: "activity"; id: string; items: ChatItem[] };

function groupItems(items: ChatItem[]): Block[] {
  const blocks: Block[] = [];
  for (const item of items) {
    const isActivity = item.kind === "tool" || item.kind === "thought";
    const last = blocks[blocks.length - 1];
    if (isActivity && last?.kind === "activity") {
      last.items.push(item);
    } else if (isActivity) {
      blocks.push({ kind: "activity", id: item.id, items: [item] });
    } else {
      blocks.push({ kind: "message", item });
    }
  }
  return blocks;
}

export function MessageList({
  items,
  plan,
  isBusy,
  isVerbose,
  basePath,
}: {
  items: ChatItem[];
  plan: PlanEntry[];
  isBusy: boolean;
  isVerbose: boolean;
  /** Worktree path of the session, stripped from tool arguments. */
  basePath: string;
}) {
  const lastItem = items[items.length - 1];
  return (
    <div className="flex flex-col gap-5">
      {groupItems(items).map((block) => {
        if (block.kind === "activity") {
          return (
            <div key={block.id} className="divide-y divide-(--line) overflow-hidden rounded-lg border border-(--line) bg-(--surface-inset)">
              {block.items.map((item) =>
                item.kind === "tool" ? (
                  <ToolCallCard key={item.id} toolCall={item.toolCall} isVerbose={isVerbose} basePath={basePath} />
                ) : item.kind === "thought" ? (
                  <ThoughtRow key={item.id} text={item.text} isStreaming={isBusy && item === lastItem} isVerbose={isVerbose} />
                ) : null,
              )}
            </div>
          );
        }
        const item = block.item;
        if (item.kind === "user") {
          const notice = huntPromptNotice(item.text);
          if (notice) {
            return (
              <div key={item.id} title={item.text} className="flex items-center gap-3 text-[13px] text-neutral-500">
                <span className="h-px flex-1 bg-(--line)" />
                {notice}
                {item.at ? <MessageTime at={item.at} /> : null}
                <span className="h-px flex-1 bg-(--line)" />
              </div>
            );
          }
          return (
            <div key={item.id} className="ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-(--row-active) px-4 py-2.5 whitespace-pre-wrap break-words text-neutral-100">
              <ChatImages urls={item.images} className={item.text ? "mb-2" : ""} />
              <UserText text={item.text} />
              {item.at ? <MessageTime at={item.at} className="-mb-1 mt-0.5 block text-right text-neutral-400" /> : null}
            </div>
          );
        }
        return item.kind === "agent" ? <AgentMessage key={item.id} text={item.text} images={item.images} at={item.at} /> : null;
      })}
      {plan.length ? <PlanCard entries={plan} /> : null}
      {isBusy ? <WorkingIndicator /> : null}
    </div>
  );
}

/** A prompt as written, with its fenced code shown as code blocks like the agent's. */
const UserText = memo(function UserText({ text }: { text: string }) {
  return splitFencedCode(text).map((segment, index) =>
    segment.kind === "code" ? (
      <CodeBlock
        key={index}
        text={segment.text}
        language={monacoLanguageForFence(segment.language)}
        className="my-1.5 overflow-x-auto whitespace-pre rounded-lg border border-(--line) bg-(--surface-inset) px-3 py-2 text-[0.85em] text-[#d4d4d4]"
      />
    ) : (
      <Fragment key={index}>{segment.text}</Fragment>
    ),
  );
});

/** When a message was written, with the full date and time on hover. */
function MessageTime({ at, className = "" }: { at: string; className?: string }) {
  return (
    <time dateTime={at} title={new Date(at).toLocaleString()} className={`text-[12px] tabular-nums ${className}`}>
      {formatMessageTime(at, new Date())}
    </time>
  );
}

/** Markdown-rendered agent turn with its images below, the time it was written and a copy button that appears on hover. */
const AgentMessage = memo(function AgentMessage({ text: reply, images, at }: { text: string; images: string[]; at?: string }) {
  const text = stripGuardrailMarker(reply);
  const [isCopied, setIsCopied] = useState(false);

  function copy() {
    void navigator.clipboard.writeText(text).then(() => {
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 1500);
    });
  }

  return (
    <div className="group flex flex-col gap-1">
      {text ? <MarkdownText text={text} /> : null}
      <ChatImages urls={images} className={text ? "mt-1" : ""} />
      {text || at ? (
        <div className="flex h-7 items-center gap-1">
          {at ? <MessageTime at={at} className="text-neutral-500" /> : null}
          {text ? (
            <button
              type="button"
              onClick={copy}
              className={`${at ? "" : "-ml-2 "}inline-flex h-7 w-fit items-center gap-1 rounded-md px-2 text-[13px] font-medium text-neutral-500 opacity-0 transition-opacity hover:bg-(--row-hover) hover:text-neutral-300 group-hover:opacity-100`}
              title="Copy message"
            >
              <CopyIcon />
              {isCopied ? "Copied" : "Copy"}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

/** Agent markdown rendered as a document with the chat's code blocks. */
export function MarkdownText({ text, className = "" }: { text: string; className?: string }) {
  return (
    <div className={`markdown min-w-0 ${className}`}>
      <Markdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
        {text}
      </Markdown>
    </div>
  );
}

/** Fenced code block colored like the editors; the fence's language comes in as the `language-*` class of the inner `code`. */
function MarkdownCodeBlock({ children }: { children?: ReactNode }) {
  const code = isValidElement<{ className?: string; children?: ReactNode }>(children) ? children.props : null;
  if (typeof code?.children !== "string") return <pre>{children}</pre>;
  const language = monacoLanguageForFence(code.className?.match(/language-(\S+)/)?.[1]);
  return <CodeBlock text={code.children.replace(/\n$/, "")} language={language} />;
}

const MARKDOWN_COMPONENTS: Components = { pre: MarkdownCodeBlock };

/** Collapsed thinking row inside the activity card; open while streaming or in verbose mode. */
const ThoughtRow = memo(function ThoughtRow({ text, isStreaming, isVerbose }: { text: string; isStreaming: boolean; isVerbose: boolean }) {
  return (
    <details open={isStreaming || isVerbose} className="chat-mono">
      <summary className="flex select-none items-center gap-2.5 px-3 py-1.5 text-neutral-400 marker:content-none hover:bg-(--row-hover)">
        <span className={`size-1.5 shrink-0 rounded-full bg-neutral-500 ${isStreaming ? "animate-pulse" : ""}`} />
        <span className="italic">{isStreaming ? "Thinking…" : "Thought"}</span>
      </summary>
      <div className="whitespace-pre-wrap break-words border-t border-(--line) px-3 py-2 italic text-neutral-500">{text}</div>
    </details>
  );
});

/** The agent's todo list; the in-progress entry is highlighted. */
function PlanCard({ entries }: { entries: PlanEntry[] }) {
  return (
    <div className="rounded-lg border border-(--line) bg-(--surface-inset) px-3 py-2">
      <div className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-neutral-500">Todos</div>
      <ul className="flex flex-col gap-0.5">
        {entries.map((entry, index) => (
          <li key={index} className={`flex gap-2 ${PLAN_STATUS_STYLE[entry.status] ?? "text-neutral-300"}`}>
            <span className="shrink-0 select-none">{entry.status === "completed" ? "☑" : "☐"}</span>
            <span className="min-w-0 break-words">{entry.content}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const PLAN_STATUS_STYLE: Record<string, string> = {
  pending: "text-neutral-300",
  in_progress: "font-semibold text-neutral-100",
  completed: "text-neutral-500 line-through",
};

function CopyIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
    </svg>
  );
}
