import { useState, type ReactNode } from "react";
import type { SelectionContext } from "../editor/selection-context.types";
import { CodeBlock } from "../editor/CodeBlock";
import { monacoLanguage } from "../editor/language-id.utils";
import { ChevronIcon } from "../ui/Icons";
import { Collapsible } from "../ui/Collapsible";
import type { FileLocation } from "./change-references.utils";
import { useFileIconUrl } from "../ui/file-icons/file-icons.hook";
import { SummaryList } from "./SessionSummary";

/** `L3-L9` label of a selection's lines. */
export function describeLines(selection: Pick<FileLocation, "startLine" | "endLine">): string {
  return selection.startLine === selection.endLine ? `L${selection.startLine}` : `L${selection.startLine}-L${selection.endLine}`;
}

/** `path:L3-L9` label of a selection. */
export function describeSelection(selection: FileLocation): string {
  return `${selection.path}:${describeLines(selection)}`;
}

/**
 * Collapsible card showing the code a sub chat was opened from; `label` replaces the `path:lines` summary. With
 * `onOpen`, a click on the summary opens the selection instead of toggling the card.
 */
export function SelectionCard({
  selection,
  isOpen = false,
  label,
  onOpen,
}: {
  selection: SelectionContext;
  isOpen?: boolean;
  label?: string;
  onOpen?: (location: FileLocation) => void;
}) {
  const fileIconUrl = useFileIconUrl();
  const summary = label ?? describeSelection(selection);
  return (
    <CollapsibleCard
      kind="Selection"
      isInitiallyOpen={isOpen}
      summary={
        <>
          {label ? null : <img src={fileIconUrl(selection.path)} alt="" className="size-4 shrink-0" />}
          {onOpen ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onOpen(selection);
              }}
              className="min-w-0 truncate text-left font-mono text-neutral-300 hover:underline"
              title={`Show ${describeSelection(selection)} in the Editor tab`}
            >
              {summary}
            </button>
          ) : (
            <span className="min-w-0 truncate font-mono text-neutral-300" title={describeSelection(selection)}>
              {summary}
            </span>
          )}
        </>
      }
    >
      <CodeBlock
        text={selection.text}
        language={monacoLanguage(selection.path)}
        path={selection.path}
        className="max-h-48 overflow-auto border-t border-(--line) px-3 py-2 font-mono text-[13px] leading-snug text-neutral-300"
      />
    </CollapsibleCard>
  );
}

/** Collapsible card, closed at first, showing text a sub chat's agent gets as context besides the question, e.g. the parent chat's end. */
export function ContextCard({ label, text }: { label: string; text: string }) {
  return (
    <CollapsibleCard kind="Context" isInitiallyOpen={false} summary={<span className="min-w-0 truncate text-neutral-300">{label}</span>}>
      <div className="max-h-48 overflow-auto whitespace-pre-wrap border-t border-(--line) px-3 py-2 text-[13px] leading-snug text-neutral-400">{text}</div>
    </CollapsibleCard>
  );
}

/** Collapsible card, open at first, listing the summary bullets of the context a sub chat's agent gets. */
export function ContextSummaryCard({ label, lines }: { label: string; lines: string[] }) {
  return (
    <CollapsibleCard kind="Summary" isInitiallyOpen summary={<span className="min-w-0 truncate text-neutral-300">{label}</span>}>
      <SummaryList lines={lines} className="border-t border-(--line) px-3 py-2" />
    </CollapsibleCard>
  );
}

/**
 * Card whose header shows a chevron, `kind` and `summary` above `children`. A click anywhere on the header toggles
 * the body, except on a control inside `summary` that stops the click; the chevron button is the header's focusable
 * control.
 */
function CollapsibleCard({ kind, summary, isInitiallyOpen, children }: { kind: string; summary: ReactNode; isInitiallyOpen: boolean; children: ReactNode }) {
  const [isExpanded, setIsExpanded] = useState(isInitiallyOpen);
  return (
    <div className="overflow-hidden rounded-lg border border-(--line) bg-(--surface-inset)">
      <div
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex cursor-pointer select-none items-center gap-2 px-3 py-1.5 text-[13px] text-neutral-400 hover:bg-(--row-hover)"
      >
        <button type="button" aria-expanded={isExpanded} className="flex shrink-0 items-center gap-1.5 text-neutral-500" title={isExpanded ? "Collapse" : "Expand"}>
          <ChevronIcon expanded={isExpanded} className="size-3.5 shrink-0" />
          {kind}
        </button>
        {summary}
      </div>
      <Collapsible isOpen={isExpanded}>{children}</Collapsible>
    </div>
  );
}
