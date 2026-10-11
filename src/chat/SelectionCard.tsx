import type { SelectionContext } from "../ipc/types";
import { CodeBlock } from "../code/CodeBlock";
import { monacoLanguage } from "../diff/monaco";

/** `L3-L9` label of a selection's lines. */
export function describeLines(selection: SelectionContext): string {
  return selection.startLine === selection.endLine ? `L${selection.startLine}` : `L${selection.startLine}-L${selection.endLine}`;
}

/** `path:L3-L9` label of a selection. */
export function describeSelection(selection: SelectionContext): string {
  return `${selection.path}:${describeLines(selection)}`;
}

/** Collapsible card showing the code a sub chat was opened from; `label` replaces the `path:lines` summary. */
export function SelectionCard({ selection, isOpen = false, label }: { selection: SelectionContext; isOpen?: boolean; label?: string }) {
  return (
    <details open={isOpen} className="overflow-hidden rounded-lg border border-(--line) bg-(--surface-inset)">
      <summary className="flex cursor-pointer select-none items-center gap-2 px-3 py-1.5 text-[13px] text-neutral-400 marker:content-none hover:bg-(--row-hover)">
        <span className="text-neutral-500">Selection</span>
        <span className="min-w-0 truncate font-mono text-neutral-300" title={describeSelection(selection)}>
          {label ?? describeSelection(selection)}
        </span>
      </summary>
      <CodeBlock
        text={selection.text}
        language={monacoLanguage(selection.path)}
        path={selection.path}
        className="max-h-48 overflow-auto border-t border-(--line) px-3 py-2 font-mono text-[13px] leading-snug text-neutral-300"
      />
    </details>
  );
}
