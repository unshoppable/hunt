import { useRef, useState, type RefObject } from "react";
import { commands } from "../../ipc/commands";
import { GHOST_BUTTON_XS } from "../../ui/buttons.constants";
import { ChevronDownIcon } from "../../ui/Icons";
import { ResizeGrips } from "../../ui/ResizeGrips";
import { useDismiss } from "../../ui/dismiss.hook";
import { useLoad } from "../../ui/load.hook";
import { usePopupSize } from "../../ui/popup-size.hook";
import { useViewportSize } from "../../ui/viewport-size.hook";
import { ContextTextDialog } from "./ContextTextDialog";
import type { LoadedContextFile } from "./loaded-context.types";
import { contextFileLabel, contextSections, TRIGGER_LABELS } from "./loaded-context.utils";

const MIN_SIZE = { width: 280, height: 160 };
/** The largest share of the window's width and height the popover may take. */
const MAX_SHARE = 0.8;

/**
 * "Context" pill of the prompt toolbar: opens a popover listing the guardrails the session's agent holds in its context
 * window — instruction files, rules, skills, ADRs and other `.claude/` files — read from its transcript each time it
 * opens. A file in the worktree opens in the "Editor" tab; "Show as text" opens the whole context in `ContextTextDialog`.
 */
export function LoadedContextButton({ sessionId, onOpenFile }: { sessionId: string; onOpenFile: (path: string) => void }) {
  const [isOpen, setIsOpen] = useState(false);
  const [isTextOpen, setIsTextOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={isOpen}
        title="Instruction files, rules, skills and ADRs in the agent's context"
        onClick={() => setIsOpen((open) => !open)}
        className="inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md pr-1.5 pl-2.5 text-sm text-neutral-300 outline-none transition-colors hover:bg-(--row-hover)"
      >
        Context
        <ChevronDownIcon className="size-3 text-neutral-500" />
      </button>
      {isOpen ? (
        <LoadedContextPopover
          sessionId={sessionId}
          anchorRef={buttonRef}
          onClose={() => setIsOpen(false)}
          onOpenFile={(path) => {
            onOpenFile(path);
            setIsOpen(false);
          }}
          onShowText={() => {
            setIsOpen(false);
            setIsTextOpen(true);
          }}
        />
      ) : null}
      {isTextOpen ? <ContextTextDialog sessionId={sessionId} onClose={() => setIsTextOpen(false)} /> : null}
    </div>
  );
}

/** The list above the "Context" pill, one section per kind of guardrail; closes on Escape or a click outside. */
function LoadedContextPopover({
  sessionId,
  anchorRef,
  onClose,
  onOpenFile,
  onShowText,
}: {
  sessionId: string;
  anchorRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onOpenFile: (path: string) => void;
  /** Opens the whole context as text (`ContextTextDialog`). */
  onShowText: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [files, setFiles] = useState<LoadedContextFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const viewport = useViewportSize();
  const { size, isHeightSet, grips } = usePopupSize("loadedContext", { min: MIN_SIZE, max: { width: viewport.width * MAX_SHARE, height: viewport.height * MAX_SHARE } });

  useDismiss(rootRef, onClose, { anchorRefs: [anchorRef] });
  useLoad(() => commands.loadedContext(sessionId), { onValue: setFiles, onError: (reason) => setError(String(reason)) }, [sessionId]);

  const sections = files ? contextSections(files) : [];
  return (
    <div
      ref={rootRef}
      className="absolute bottom-full left-0 z-20 mb-2 flex flex-col rounded-md border border-neutral-600 bg-(--surface-inset) text-[13px] shadow-lg"
      style={{ width: size.width, maxHeight: size.height, height: isHeightSet ? size.height : undefined }}
    >
      <div className="flex shrink-0 items-center border-b border-(--line) py-1 pr-1 pl-3">
        <span className="flex-1 text-neutral-400">Guardrails in the agent's context</span>
        <button type="button" onClick={onShowText} className={GHOST_BUTTON_XS}>
          Show as text
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {error ? <div className="px-2 py-2 text-red-300">{error}</div> : null}
        {!error && !files ? <div className="px-2 py-2 text-neutral-500">Loading…</div> : null}
        {files && !sections.length ? <div className="px-2 py-2 text-neutral-500">Nothing loaded yet: the agent has not started a turn.</div> : null}
        {sections.map((section) => (
          <section key={section.kind} className="pb-1">
            <h3 className="px-2 pt-2 pb-1 text-[12px] font-semibold uppercase tracking-wide text-neutral-500">{section.title}</h3>
            <ul>
              {section.files.map((file) => {
                const { name, folder } = contextFileLabel(file);
                return (
                  <li key={file.path}>
                    <button
                      type="button"
                      disabled={!file.isInWorktree}
                      onClick={() => onOpenFile(file.path)}
                      title={file.isInWorktree ? `Open ${file.path}` : file.path}
                      className="flex h-7 w-full items-center gap-2 rounded px-2 text-left enabled:hover:bg-(--row-hover)"
                    >
                      <span className="shrink-0 text-neutral-200">{name}</span>
                      <span className="min-w-0 flex-1 truncate text-neutral-500">{folder}</span>
                      <span className="shrink-0 text-[12px] text-neutral-500">{TRIGGER_LABELS[file.trigger]}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
      <ResizeGrips edges={{ top: true, right: true }} {...grips} />
    </div>
  );
}
