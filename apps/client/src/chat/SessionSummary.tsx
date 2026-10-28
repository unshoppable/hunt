import { useState, type ReactNode } from "react";
import { CodeBlock } from "../editor/CodeBlock";
import { monacoLanguage } from "../editor/language-id.utils";
import type { SelectionContext } from "../editor/selection-context.types";
import type { SessionView } from "../sessions/session.types";
import { useSettingsStore } from "../settings/settings.store";
import { SECONDARY, SURFACE_BUTTON_MD } from "../ui/buttons.constants";
import { Collapsible } from "../ui/Collapsible";
import type { FileLocation } from "./change-references.utils";
import { FileReferenceList, FileReferenceRow } from "./FileReferenceList";

/**
 * Box above the messages with the session's title followed by `titleActions`; while the "Summary" setting is on, it
 * also lists the code a sub chat was opened from and the session's summary bullets.
 */
export function SessionSummary({ session, titleActions, onOpenFile }: { session: SessionView; titleActions?: ReactNode; onOpenFile: (location: FileLocation) => void }) {
  const showSummary = useSettingsStore((state) => state.showSummary);
  return (
    <div className="border-b border-(--line) bg-white/8 pt-4 pr-12 pb-[18px] pl-5">
      <div className="chat-column">
        <div className="flex min-w-0 items-center gap-1">
          <div className="truncate text-[15px] font-semibold text-neutral-100">{session.title}</div>
          {titleActions}
        </div>
        {showSummary ? (
          <div className="mt-2">
            {session.selection?.text ? (
              <SelectionCodeCard key={session.id} selection={session.selection} onOpen={onOpenFile} />
            ) : session.selection ? (
              <FileReferenceList locations={[session.selection]} onOpen={onOpenFile} className="mb-2.5" />
            ) : null}
            {session.summary.length ? (
              <SummaryList lines={session.summary} />
            ) : (
              <div className="text-[14px] text-neutral-500">No summary yet. It is written after the first finished prompt.</div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** A session summary's lines as a bullet list; `className` adds to its spacing and type. */
export function SummaryList({ lines, className = "" }: { lines: string[]; className?: string }) {
  return (
    <ul className={`space-y-1 text-[14px] leading-snug text-neutral-300 ${className}`}>
      {lines.map((line, index) => (
        <li key={index} className="flex gap-2">
          <span className="mt-[0.55em] size-1 shrink-0 select-none rounded-full bg-neutral-500" />
          <span>{line}</span>
        </li>
      ))}
    </ul>
  );
}

/** Lines above which the selected code starts collapsed in the summary; 16 lines of the card's code are 300 px high. */
const MAX_INITIALLY_EXPANDED_LINES = 16;

/**
 * Card with the file row of the code a sub chat was opened from and the code below it, which the row's chevron shows
 * or hides. The code starts shown unless it has more than `MAX_INITIALLY_EXPANDED_LINES` lines; shown, it scrolls
 * beyond half the window height so the chat below stays visible.
 */
function SelectionCodeCard({ selection, onOpen }: { selection: SelectionContext; onOpen: (location: FileLocation) => void }) {
  const [isExpanded, setIsExpanded] = useState(() => selection.text.split("\n").length <= MAX_INITIALLY_EXPANDED_LINES);
  return (
    <div className="mb-2.5 overflow-hidden rounded-lg border border-(--line) bg-(--surface-inset) text-[13px]">
      <FileReferenceRow location={selection} onOpen={onOpen} isExpanded={isExpanded} onToggle={() => setIsExpanded(!isExpanded)} />
      <Collapsible isOpen={isExpanded}>
        <div className="max-h-[50vh] overflow-auto border-t border-(--line)">
          <CodeBlock
            text={selection.text}
            language={monacoLanguage(selection.path)}
            path={selection.path}
            className="px-3 py-2 font-mono text-[13px] leading-snug text-neutral-300"
          />
        </div>
      </Collapsible>
    </div>
  );
}

/** Header button that shows or hides the summary bullets below the title; the choice is remembered across sessions and restarts. */
export function SessionSummaryToggle() {
  const showSummary = useSettingsStore((state) => state.showSummary);
  const toggleSummary = useSettingsStore((state) => state.toggleSummary);
  return (
    <button
      type="button"
      aria-pressed={showSummary}
      title={showSummary ? "Hide the summary" : "Show the summary"}
      onClick={toggleSummary}
      className={`${SURFACE_BUTTON_MD} ${showSummary ? "border border-white/15 bg-white/12 text-white hover:bg-white/15 active:bg-white/10" : SECONDARY}`}
    >
      <InfoIcon />
      Summary
    </button>
  );
}

function InfoIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <circle cx="8" cy="8" r="6.3" />
      <path d="M8 7.2v4" />
      <circle cx="8" cy="4.9" r="0.5" fill="currentColor" />
    </svg>
  );
}
