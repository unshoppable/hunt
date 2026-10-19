import { useLayoutEffect, useRef, useState } from "react";
import { commands } from "../ipc/commands";
import type { GitRef } from "../ipc/types";
import { INPUT } from "../diff/styles";
import { GHOST_BUTTON_MD, PRIMARY_BUTTON_MD } from "../ui/buttons";
import { Modal } from "../ui/Modal";
import { useDismiss } from "../ui/useDismiss";
import type { BranchAction } from "./branchActions";

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

/** Asks for the new name of the branch `branch` and renames it. */
export function RenameBranchDialog({ sessionId, branch, onClose, onRenamed }: { sessionId: string; branch: string; onClose: () => void; onRenamed: (newName: string) => void }) {
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
    <Modal label="Rename branch" onClose={onClose} isCloseable={!isBusy} className="w-[460px] bg-(--surface-chat) p-4">
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
      <div className="flex justify-end gap-2">
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
