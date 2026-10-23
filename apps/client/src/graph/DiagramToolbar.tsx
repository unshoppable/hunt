import { useEffect, useRef, useState } from "react";
import { formatRelativeTime } from "../chat/ScreenshotPicker";
import type { DiagramType, GraphStatus } from "../ipc/types";
import { useSettingsStore } from "../state/settings";
import { BUTTON_BASE, PRIMARY, PRIMARY_BUTTON_LG, PRIMARY_BUTTON_XS, SECONDARY_BUTTON_XS } from "../ui/buttons";
import { Dropdown } from "../ui/Dropdown";
import { ChevronDownIcon } from "../ui/icons";
import { useDismiss } from "../ui/useDismiss";
import { DIAGRAM_TYPES } from "./diagramTypes";

const BADGE_BASE = "absolute top-3 left-3 z-10 rounded-md border px-2 py-0.5 text-[12px] font-medium";

const DIAGRAM_OPTIONS = DIAGRAM_TYPES.map((type) => ({ id: type.id, name: type.name, description: type.description }));

/** Picks which diagram the Architecture tab shows for `sessionId`; the choice is remembered per session. */
export function DiagramTypeDropdown({ sessionId }: { sessionId: string }) {
  const value = useSettingsStore((state) => state.diagramTypes[sessionId] ?? "dependencies");
  const setDiagramType = useSettingsStore((state) => state.setDiagramType);
  return <Dropdown title="Diagram type" value={value} options={DIAGRAM_OPTIONS} onChange={(id) => setDiagramType(sessionId, id as DiagramType)} className={SECONDARY_BUTTON_XS} />;
}

/**
 * "Outdated" while worktree files changed after the diagram was generated, "Up to date" otherwise, followed by how long
 * ago it was generated; nothing without a diagram. Floats in the top-left corner of the diagram canvas, so its parent
 * must be positioned.
 */
export function DiagramStatusBadge({ status, hasDiagram }: { status: GraphStatus | null; hasDiagram: boolean }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  if (!hasDiagram) return null;
  const generatedAt = status?.generatedAt ? new Date(status.generatedAt) : null;
  const generatedAtText = generatedAt?.toLocaleString();
  const age = generatedAt ? <span className="font-normal opacity-75"> · generated {formatRelativeTime(generatedAt.getTime(), now)}</span> : null;
  return status?.isOutdated ? (
    <span
      className={`${BADGE_BASE} border-amber-400/30 bg-amber-400/10 text-amber-300`}
      title={generatedAtText ? `Generated ${generatedAtText}; files changed since.` : "Files changed since the diagram was generated."}
    >
      Outdated{age}
    </span>
  ) : (
    <span
      className={`${BADGE_BASE} border-emerald-400/30 bg-emerald-400/10 text-emerald-300`}
      title={generatedAtText ? `Generated ${generatedAtText}; no files changed since.` : "No files changed since the diagram was generated."}
    >
      Up to date{age}
    </span>
  );
}

/**
 * The generate button of a diagram: its main part generates with the standard prompt, the chevron beside it opens a
 * popover with a text box whose instructions go along with that one run. ⌘/Ctrl+Enter in the box submits.
 */
export function GenerateSplitButton({ label, isDisabled, onGenerate }: { label: string; isDisabled: boolean; onGenerate: (instructions: string) => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const chevronRef = useRef<HTMLButtonElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [text, setText] = useState("");

  const close = () => setIsOpen(false);
  useDismiss(rootRef, close, { anchorRefs: [chevronRef], isEnabled: isOpen });

  const submit = () => {
    onGenerate(text.trim());
    setText("");
    close();
  };

  return (
    <div className="relative inline-flex shrink-0">
      <button type="button" disabled={isDisabled} onClick={() => onGenerate("")} className={`${PRIMARY_BUTTON_LG} rounded-r-none`}>
        {label}
      </button>
      <button
        ref={chevronRef}
        type="button"
        disabled={isDisabled}
        onClick={() => setIsOpen((value) => !value)}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-label="Generate with additional instructions"
        title="Generate with additional instructions"
        className={`${BUTTON_BASE} ${PRIMARY} h-[37px] rounded-l-none border-l border-white/20 px-2 text-sm`}
      >
        <ChevronDownIcon className="size-3.5" />
      </button>
      {isOpen ? (
        <div ref={rootRef} role="dialog" aria-label="Additional instructions" className="absolute top-full left-0 z-20 mt-1 w-[32rem] max-w-[calc(100vw-2rem)] rounded-md border border-neutral-600 bg-(--surface-inset) p-2 shadow-lg">
          <label className="mb-1 block text-[13px] text-neutral-400">Additional instructions</label>
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                submit();
              }
            }}
            placeholder="Focus on the payment flow"
            autoFocus
            rows={4}
            className="mb-2 w-full resize-y rounded border border-neutral-600 bg-(--surface-input) px-2 py-1 text-[13px]"
          />
          <div className="flex justify-end">
            <button type="button" disabled={isDisabled} onClick={submit} className={PRIMARY_BUTTON_XS}>
              Generate
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
