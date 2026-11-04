import { useEffect, useRef, useState, type KeyboardEvent } from "react";

/** The text fields and section headings shared by the editors beside a shape diagram (`TableEditor`, `ShapeElementEditor`). */
export const INPUT = "h-7 w-full min-w-0 rounded-md border border-white/10 bg-(--surface-input) px-2 text-[13px] text-neutral-100 outline-none placeholder:text-neutral-500 focus:border-blue-400/70";
export const SECTION_LABEL = "text-[12px] font-medium tracking-wide text-neutral-500 uppercase";

/** A text field that commits on blur or Enter when its text changed, and reverts on Escape. */
export function CommitInput({ value, onCommit, ariaLabel, className, autoFocus = false }: { value: string; onCommit: (value: string) => void; ariaLabel: string; className: string; autoFocus?: boolean }) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    if (autoFocus) {
      ref.current?.select();
    }
  }, [autoFocus]);
  return (
    <input
      ref={ref}
      type="text"
      value={draft}
      spellCheck={false}
      aria-label={ariaLabel}
      autoFocus={autoFocus}
      className={className}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft.trim() !== value) {
          onCommit(draft);
        }
      }}
      onKeyDown={(event) => commitKeys(event, () => setDraft(value))}
    />
  );
}

/** A two-line text field with the same commit rules as `CommitInput`; Shift+Enter inserts a line break. */
export function CommitTextarea({ value, onCommit, placeholder }: { value: string; onCommit: (value: string) => void; placeholder: string }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <textarea
      value={draft}
      rows={2}
      spellCheck={false}
      placeholder={placeholder}
      className={`${INPUT} h-auto resize-y py-1 leading-snug`}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft.trim() !== value) {
          onCommit(draft);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" && event.shiftKey) return;
        commitKeys(event, () => setDraft(value));
      }}
    />
  );
}

/** Enter commits by blurring the field, Escape reverts the draft and blurs; both stay inside the editor. */
function commitKeys(event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>, revert: () => void) {
  if (event.key === "Enter") {
    event.preventDefault();
    event.currentTarget.blur();
  } else if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    revert();
    event.currentTarget.blur();
  }
}
