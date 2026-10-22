import { Fragment, isValidElement, memo, useMemo, useState, type ReactNode } from "react";
import { stripGuardrailMarker } from "./guardrailSuggestion";
import { findChangeReferences, parseFileLocation, stripChangeMarker, type FileTarget } from "./changeReferences";
import Markdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "../code/CodeBlock";
import { monacoLanguage, monacoLanguageForFence } from "../diff/monaco";
import type { ChatItem, PlanEntry } from "../ipc/types";
import { ChatImages } from "./ChatImages";
import { FileReferenceList, FileReferenceRow } from "./FileReferenceList";
import { resolveFileReference, type FileIndex } from "./fileLinks";
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
  fileIndex = null,
  onOpenFile,
}: {
  items: ChatItem[];
  plan: PlanEntry[];
  isBusy: boolean;
  isVerbose: boolean;
  /** Worktree path of the session, stripped from tool arguments and the places a reply changed. */
  basePath: string;
  /** Files of the worktree; inline code in a reply that names one of them opens it. */
  fileIndex?: FileIndex | null;
  /** Shows a file a reply names in the editor; without it the places are listed without a button. */
  onOpenFile?: (target: FileTarget) => void;
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
        return item.kind === "agent" ? (
          <AgentMessage key={item.id} text={item.text} images={item.images} at={item.at} basePath={basePath} fileIndex={fileIndex} onOpenFile={onOpenFile} />
        ) : null;
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

/**
 * Markdown-rendered agent turn with its images and the places it changed below, the time it was written and a copy button
 * that appears on hover.
 */
const AgentMessage = memo(function AgentMessage({
  text: reply,
  images,
  at,
  basePath,
  fileIndex,
  onOpenFile,
}: {
  text: string;
  images: string[];
  at?: string;
  basePath: string;
  fileIndex: FileIndex | null;
  onOpenFile?: (target: FileTarget) => void;
}) {
  const text = stripGuardrailMarker(stripChangeMarker(reply));
  const changes = findChangeReferences(reply, basePath);
  const [isCopied, setIsCopied] = useState(false);

  function copy() {
    void navigator.clipboard.writeText(text).then(() => {
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 1500);
    });
  }

  return (
    <div className="group flex flex-col gap-1">
      {text ? <MarkdownText text={text} basePath={basePath} fileIndex={fileIndex} onOpenFile={onOpenFile} /> : null}
      <ChatImages urls={images} className={text ? "mt-1" : ""} />
      {changes.length ? <FileReferenceList locations={changes} onOpen={onOpenFile} className="mt-1" /> : null}
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
export function MarkdownText({
  text,
  className = "",
  basePath = "",
  fileIndex = null,
  onOpenFile,
}: {
  text: string;
  className?: string;
  /** Worktree path that absolute file places of code blocks and inline code are made relative to. */
  basePath?: string;
  /** Files of the worktree; inline code naming one of them becomes a link when `onOpenFile` is given. */
  fileIndex?: FileIndex | null;
  /** Shows the file place of a code block, or the file inline code names, in the editor; without it nothing is a link. */
  onOpenFile?: (target: FileTarget) => void;
}) {
  const components = useMemo<Components>(
    () => ({
      pre: ({ node, children }) => (
        <MarkdownCodeBlock node={node} basePath={basePath} onOpenFile={onOpenFile}>
          {children}
        </MarkdownCodeBlock>
      ),
      code: ({ className: codeClassName, children }) => {
        const text = typeof children === "string" ? children : null;
        const target = fileIndex && onOpenFile && text ? resolveFileReference(text, fileIndex, basePath) : null;
        if (!target || !onOpenFile || !text) return <code className={codeClassName}>{children}</code>;
        return <FileLink target={target} onOpen={onOpenFile} text={text} />;
      },
    }),
    [basePath, fileIndex, onOpenFile],
  );
  return (
    <div className={`markdown min-w-0 ${className}`}>
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </Markdown>
    </div>
  );
}

/**
 * Fenced code block colored like the editors; the fence's language comes in as the `language-*` class of the inner
 * `code`. A file place after the language (`ts src/a.ts:3-9`) shows as a header row above the code.
 */
function MarkdownCodeBlock({
  node,
  children,
  basePath,
  onOpenFile,
}: {
  node: ExtraProps["node"];
  children?: ReactNode;
  basePath: string;
  onOpenFile?: (target: FileTarget) => void;
}) {
  const code = isValidElement<{ className?: string; children?: ReactNode }>(children) ? children.props : null;
  if (typeof code?.children !== "string") return <pre>{children}</pre>;
  const language = monacoLanguageForFence(code.className?.match(/language-(\S+)/)?.[1]);
  const text = code.children.replace(/\n$/, "");
  const codeNode = node?.children[0];
  const meta = codeNode?.type === "element" ? codeNode.data?.meta : null;
  const location = meta ? parseFileLocation(meta, basePath) : null;
  if (!location) return <CodeBlock text={text} language={language} />;
  return (
    <div className="code-location">
      <FileReferenceRow location={location} onOpen={onOpenFile} className="border-b border-(--line) text-[13px]" />
      <CodeBlock text={text} language={language === "plaintext" ? monacoLanguage(location.path) : language} path={location.path} />
    </div>
  );
}

/** Inline code naming a worktree file, shown as a link that opens it; keyboard users open it with Enter. */
function FileLink({ target, onOpen, text }: { target: FileTarget; onOpen: (target: FileTarget) => void; text: string }) {
  const lines = target.startLine ? `:${target.startLine}${target.endLine && target.endLine !== target.startLine ? `-${target.endLine}` : ""}` : "";
  return (
    <span
      role="link"
      tabIndex={0}
      className="file-link"
      title={`Open ${target.path}${lines} in the editor`}
      onClick={() => onOpen(target)}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        onOpen(target);
      }}
    >
      <code>{text}</code>
    </span>
  );
}

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
