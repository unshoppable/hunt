import { useRef, useState } from "react";
import { PRIMARY_BUTTON_XS } from "../ui/buttons.constants";
import { useDismiss } from "../ui/dismiss.hook";
import { INPUT } from "../ui/styles.constants";
import { newBranchProblem } from "./new-branch.utils";

/**
 * Popover below the branch menu asking for the name of the branch the session creates, prefilled with `initialName`
 * when renaming it; `origin` says where the branch starts. Enter or OK submit the name once it is valid and new to the
 * repository, Escape or a click outside closes without a change.
 */
export function NewBranchPopover({
  initialName,
  branches,
  origin,
  onSubmit,
  onClose,
}: {
  initialName: string;
  branches: string[];
  origin: string;
  onSubmit: (name: string) => void;
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  useDismiss(rootRef, onClose);
  const [name, setName] = useState(initialName);
  const trimmed = name.trim();
  const problem = newBranchProblem(trimmed, branches);

  function submit() {
    if (problem !== null) return;
    onSubmit(trimmed);
  }

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label="New branch"
      className="absolute top-full right-0 z-50 mt-1.5 w-80 max-w-[calc(100cqw-2rem)] rounded-xl border border-neutral-600 bg-(--surface-chat) p-3 text-sm text-neutral-400 shadow-2xl shadow-black/50"
    >
      <label htmlFor="new-branch-name" className="mb-1.5 block text-[13px] text-neutral-300">
        New branch
      </label>
      <div className="flex items-center gap-2">
        <input
          id="new-branch-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            }
          }}
          autoFocus
          spellCheck={false}
          placeholder="feat/general/name"
          className={`${INPUT} font-mono`}
        />
        <button type="button" onClick={submit} disabled={problem !== null} className={`${PRIMARY_BUTTON_XS} shrink-0`}>
          OK
        </button>
      </div>
      <p className={`mt-2 text-[12px] ${problem ? "text-red-400" : "text-neutral-500"}`}>{problem || `Created ${origin} when the session starts`}</p>
    </div>
  );
}
