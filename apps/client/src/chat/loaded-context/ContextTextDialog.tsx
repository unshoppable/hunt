import { useMemo, useState } from "react";
import { commands } from "../../ipc/commands";
import { GHOST_BUTTON_XS, ICON_BUTTON_SM } from "../../ui/buttons.constants";
import { ChevronIcon, CloseIcon } from "../../ui/Icons";
import { Modal } from "../../ui/Modal";
import { useDialogSize } from "../../ui/dialog-size.hook";
import { useLoad } from "../../ui/load.hook";
import { formatTokens } from "../ContextMeter";
import { estimateTokens, PART_KINDS, partKindTotals, startsExpanded } from "./context-parts.utils";
import type { ContextPart, ContextPartKind } from "./loaded-context.types";

/**
 * The text of the agent's context window, rebuilt from its transcript: one section per part (system prompt, tool
 * definitions, instruction files, reminders, skills, prompts, replies, tool calls and results), each with its kind in
 * color, a title and its estimated tokens, expanded or collapsed on a click. The chips of the header show the total per
 * kind and hide or show that kind.
 */
export function ContextTextDialog({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const dialog = useDialogSize("contextText", { fillsHeight: true, min: { width: 560, height: 320 } });
  const [parts, setParts] = useState<ContextPart[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Indexes of the parts whose text shows; set from `startsExpanded` once the parts arrive. */
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const [hiddenKinds, setHiddenKinds] = useState<Set<ContextPartKind>>(() => new Set());

  useLoad(
    () => commands.contextParts(sessionId),
    {
      onValue: (loaded) => {
        setParts(loaded);
        setExpanded(new Set(loaded.flatMap((part, index) => (startsExpanded(part) ? [index] : []))));
      },
      onError: (reason) => setError(String(reason)),
    },
    [sessionId],
  );

  const totals = useMemo(() => partKindTotals(parts ?? []), [parts]);
  const totalTokens = totals.reduce((sum, total) => sum + total.tokens, 0);
  const shown = (parts ?? []).map((part, index) => ({ part, index })).filter(({ part }) => !hiddenKinds.has(part.kind));

  const toggle = <T,>(set: Set<T>, value: T): Set<T> => {
    const next = new Set(set);
    if (next.has(value)) {
      next.delete(value);
    } else {
      next.add(value);
    }
    return next;
  };

  return (
    <Modal label="Context as text" onClose={onClose} className="bg-(--surface-inspector)" style={dialog.style} resize={dialog.resize}>
      <div className="flex shrink-0 items-center gap-3 border-b border-(--line) px-4 py-2">
        <h2 className="text-[13px] font-semibold text-neutral-200">Context as text</h2>
        {parts ? (
          <span className="text-[13px] text-neutral-500 tabular-nums" title="Estimated at four characters per token">
            ≈ {formatTokens(totalTokens)} tokens · {parts.length} parts
          </span>
        ) : null}
        <span className="flex-1" />
        <button type="button" className={GHOST_BUTTON_XS} onClick={() => setExpanded(new Set(shown.map(({ index }) => index)))}>
          Expand all
        </button>
        <button type="button" className={GHOST_BUTTON_XS} onClick={() => setExpanded(new Set())}>
          Collapse all
        </button>
        <button type="button" onClick={onClose} className={ICON_BUTTON_SM} title="Close (esc)" aria-label="Close">
          <CloseIcon />
        </button>
      </div>
      {totals.length ? (
        <div className="flex shrink-0 flex-wrap gap-1.5 border-b border-(--line) px-4 py-2">
          {totals.map(({ kind, count, tokens }) => {
            const isHidden = hiddenKinds.has(kind);
            return (
              <button
                key={kind}
                type="button"
                aria-pressed={!isHidden}
                onClick={() => setHiddenKinds((current) => toggle(current, kind))}
                title={isHidden ? `Show ${PART_KINDS[kind].label}` : `Hide ${PART_KINDS[kind].label}`}
                className={`flex h-7 items-center gap-1.5 rounded-md border px-2 text-[12px] transition-colors hover:bg-(--row-hover) ${isHidden ? "border-white/10 opacity-40" : "border-white/15"}`}
              >
                <span className={PART_KINDS[kind].colorClass}>{PART_KINDS[kind].label}</span>
                <span className="text-neutral-500 tabular-nums">
                  {count} · {formatTokens(tokens)}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {error ? <div className="text-[13px] text-red-300">{error}</div> : null}
        {!error && !parts ? <div className="text-[13px] text-neutral-500">Loading…</div> : null}
        {parts && !parts.length ? <div className="text-[13px] text-neutral-500">Nothing in the context yet: the agent has not started a turn.</div> : null}
        <ol className="flex flex-col gap-2">
          {shown.map(({ part, index }) => {
            const isOpen = expanded.has(index);
            const kind = PART_KINDS[part.kind];
            return (
              <li key={index} className={`rounded-md border-l-2 bg-white/3 ${kind.borderClass}`}>
                <button
                  type="button"
                  aria-expanded={isOpen}
                  onClick={() => setExpanded((current) => toggle(current, index))}
                  className="flex h-8 w-full items-center gap-2 rounded-r-md px-2 text-left text-[13px] hover:bg-(--row-hover)"
                >
                  <ChevronIcon expanded={isOpen} className="size-3.5 shrink-0 text-neutral-500" />
                  <span className={`shrink-0 text-[12px] font-semibold uppercase tracking-wide ${kind.colorClass}`}>{kind.label}</span>
                  <span className="min-w-0 flex-1 truncate text-neutral-300">{part.title}</span>
                  <span className="shrink-0 text-[12px] text-neutral-500 tabular-nums">≈ {formatTokens(estimateTokens(part.text))}</span>
                </button>
                {isOpen ? (
                  <pre className="overflow-x-auto border-t border-white/5 px-3 py-2 font-mono text-[12px] leading-5 whitespace-pre-wrap break-words text-neutral-300">
                    {part.text || "(empty)"}
                  </pre>
                ) : null}
              </li>
            );
          })}
        </ol>
      </div>
    </Modal>
  );
}
