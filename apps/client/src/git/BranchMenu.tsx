import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { commands } from "../ipc/commands";
import type { GitRef } from "../ipc/types";
import { INPUT } from "../diff/styles";
import { GHOST_BUTTON_MD, PRIMARY_BUTTON_MD } from "../ui/buttons";
import { PlusIcon } from "../ui/icons";
import { Modal } from "../ui/Modal";
import { useDismiss } from "../ui/useDismiss";
import { useDialogSize } from "../ui/useDialogSize";
import type { BranchAction } from "./branchActions";

/** Smallest size the push target dialog shrinks to: the list keeps a few rows. */
const PUSH_TARGET_MIN_SIZE = { width: 360, height: 300 };

/** Where a right click opened the menu of which branch. */
export type BranchMenuState = { ref: GitRef; x: number; y: number };

/**
 * The context menu of a branch in the branch tree, opened at the click position and kept inside the window; entries
 * that cannot run stay visible, greyed out, with the reason as tooltip.
 */
export function BranchMenu({ menu, actions, onPick, onClose }: { menu: BranchMenuState; actions: BranchAction[]; onPick: (action: BranchAction) => void; onClose: () => void }) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: menu.x, top: menu.y });
  useDismiss(menuRef, onClose, { closeOnWindowBlur: true });

  // The menu is wider than the tree pane: it moves left or up as far as the window needs.
  useLayoutEffect(() => {
    const rect = menuRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition({ left: Math.max(0, Math.min(menu.x, window.innerWidth - rect.width - 8)), top: Math.max(0, Math.min(menu.y, window.innerHeight - rect.height - 8)) });
  }, [menu]);

  return (
    <div ref={menuRef} role="menu" style={position} className="fixed z-50 min-w-44 rounded border border-neutral-600 bg-(--surface-inset) p-1 text-[13px] shadow-lg">
      <div className="mb-1 truncate border-b border-(--line) px-2 pb-1 font-mono text-[12px] text-neutral-500" title={menu.ref.name}>
        {menu.ref.name}
      </div>
      {actions.map((action) => (
        <button
          key={action.kind}
          type="button"
          role="menuitem"
          aria-disabled={!!action.disabledReason}
          title={action.disabledReason ?? undefined}
          onClick={() => (action.disabledReason ? undefined : onPick(action))}
          className={`block w-full truncate rounded px-2 py-1 text-left hover:bg-(--row-hover) ${action.isDanger ? "text-red-300" : "text-neutral-200"} ${action.startsGroup ? "mt-1 border-t border-(--line) pt-1.5" : ""} ${action.disabledReason ? "opacity-40" : ""}`}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Lets the user pick, among the branches of `origin` (`candidates`, without the `origin/` prefix), the one a push of
 * the session lands on; the text field filters the list. The list's first row, "New branch…", empties the field for a
 * name the list does not know, which is offered as a new branch and, applied, created on `origin` at the commit of the
 * current target (or merely fetched when `origin` has it already). Dragging an edge resizes the dialog; the size is
 * remembered across sessions.
 */
export function PushTargetDialog({
  sessionId,
  current,
  candidates,
  onClose,
  onChanged,
}: {
  sessionId: string;
  current: string;
  candidates: string[];
  onClose: () => void;
  onChanged: (target: string) => void;
}) {
  const [text, setText] = useState(current);
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const dialog = useDialogSize("pushTarget", { min: PUSH_TARGET_MIN_SIZE, fillsHeight: true });
  const inputRef = useRef<HTMLInputElement>(null);
  const target = text.trim();
  // The list shows every branch until the user edits the field, then those containing the text.
  const matches = useMemo(() => {
    const needle = target === current ? "" : target.toLowerCase();
    return candidates.filter((candidate) => candidate.toLowerCase().includes(needle));
  }, [candidates, target, current]);
  /** The typed name is none of the fetched branches: applying it creates the branch on origin unless origin has it. */
  const isNew = !!target && target !== current && !candidates.includes(target);
  const canSubmit = !!target && target !== current && !isBusy;

  /** Empties the field for the name of a new branch. */
  function startNaming() {
    setText("");
    inputRef.current?.focus();
  }

  async function submit(choice = target, create = isNew) {
    if (!choice || choice === current || isBusy) return;
    setIsBusy(true);
    setError(null);
    try {
      await commands.setPushTarget(sessionId, choice, create);
      onChanged(choice);
      onClose();
    } catch (reason) {
      setError(String(reason));
      setIsBusy(false);
    }
  }

  return (
    <Modal label="Change push target" onClose={onClose} isCloseable={!isBusy} className="bg-(--surface-chat) p-4" style={dialog.style} resize={dialog.resize}>
      <h2 className="mb-1 text-base font-semibold">Change push target</h2>
      <p className="mb-3 text-[13px] text-neutral-400">
        A push lands on this branch of origin, after a rebase onto it; the session's own branch never reaches origin. Currently{" "}
        <span className="font-mono text-neutral-300">origin/{current}</span>.
      </p>
      <label className="mb-1 block text-[13px] text-neutral-400">Branch on origin</label>
      <input
        ref={inputRef}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            void submit();
          }
        }}
        autoFocus
        spellCheck={false}
        placeholder="Name of a branch of origin, or of a new one"
        className={`${INPUT} font-mono`}
      />
      <ul role="listbox" className="mt-1 mb-3 min-h-0 flex-1 overflow-auto rounded border border-(--line) py-1 font-mono text-[13px]">
        {/* The new-branch row stays on top: it creates the typed name once it is none of origin's, else it empties the field. */}
        <li
          role="option"
          aria-selected={false}
          onClick={isNew ? () => void submit(target, true) : startNaming}
          title={isNew ? `Creates origin/${target} at the commit of origin/${current}` : `A new branch of origin, created at the commit of origin/${current}`}
          className="mb-1 flex cursor-default items-center gap-1.5 border-b border-(--line) px-2 pb-1.5 pt-0.5 text-neutral-300 hover:bg-(--row-hover)"
        >
          <PlusIcon className="size-3.5 shrink-0 text-neutral-500" />
          {isNew ? (
            <span className="truncate">
              <span className="text-neutral-500">Create </span>
              {target}
              <span className="text-neutral-500"> from {current}</span>
            </span>
          ) : (
            <span className="truncate">
              New branch…<span className="text-neutral-500"> type a name none of these has; it is created off {current}</span>
            </span>
          )}
        </li>
        {matches.map((candidate) => (
          <li
            key={candidate}
            role="option"
            aria-selected={candidate === target}
            onClick={() => void submit(candidate)}
            className={`cursor-default truncate px-2 py-0.5 ${candidate === target ? "bg-(--tree-selection) text-blue-100" : "text-neutral-200 hover:bg-(--row-hover)"}`}
          >
            {candidate}
          </li>
        ))}
        {matches.length === 0 && !isNew ? <li className="px-2 py-0.5 text-neutral-500">No fetched branch of origin matches.</li> : null}
      </ul>
      {error ? <p className="mb-3 text-[13px] text-red-400">{error}</p> : null}
      <div className="mt-auto flex justify-end gap-2">
        <button type="button" onClick={onClose} disabled={isBusy} className={GHOST_BUTTON_MD}>
          Cancel
        </button>
        <button type="button" onClick={() => void submit()} disabled={!canSubmit} className={PRIMARY_BUTTON_MD}>
          {isBusy ? (isNew ? "Creating…" : "Changing…") : isNew ? "Create & change" : "Change"}
        </button>
      </div>
    </Modal>
  );
}

/** Asks for the new name of the branch `branch` and renames it. Dragging an edge resizes the dialog. */
export function RenameBranchDialog({ sessionId, branch, onClose, onRenamed }: { sessionId: string; branch: string; onClose: () => void; onRenamed: (newName: string) => void }) {
  const dialog = useDialogSize("renameBranch");
  const [name, setName] = useState(branch);
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const newName = name.trim();
  const canSubmit = !!newName && newName !== branch && !isBusy;

  async function submit() {
    if (!canSubmit) return;
    setIsBusy(true);
    setError(null);
    try {
      await commands.gitRenameBranch(sessionId, branch, newName);
      onRenamed(newName);
      onClose();
    } catch (reason) {
      setError(String(reason));
      setIsBusy(false);
    }
  }

  return (
    <Modal label="Rename branch" onClose={onClose} isCloseable={!isBusy} className="bg-(--surface-chat) p-4" style={dialog.style} resize={dialog.resize}>
      <h2 className="mb-1 text-base font-semibold">Rename branch</h2>
      <p className="mb-3 truncate font-mono text-[13px] text-neutral-400" title={branch}>
        {branch}
      </p>
      <label className="mb-1 block text-[13px] text-neutral-400">New name</label>
      <input
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            void submit();
          }
        }}
        autoFocus
        spellCheck={false}
        className={`${INPUT} mb-3 font-mono`}
      />
      {error ? <p className="mb-3 text-[13px] text-red-400">{error}</p> : null}
      <div className="mt-auto flex justify-end gap-2">
        <button type="button" onClick={onClose} disabled={isBusy} className={GHOST_BUTTON_MD}>
          Cancel
        </button>
        <button type="button" onClick={() => void submit()} disabled={!canSubmit} className={PRIMARY_BUTTON_MD}>
          {isBusy ? "Renaming…" : "Rename"}
        </button>
      </div>
    </Modal>
  );
}
