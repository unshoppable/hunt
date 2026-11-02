import { useState } from "react";
import { commands } from "../ipc/commands";
import type { Commit, GitScope, ResetMode } from "./git.types";
import { reportSuccess } from "../ui/status-toasts.store";
import { GHOST_BUTTON_MD, PRIMARY_BUTTON_MD } from "../ui/buttons.constants";
import { Modal } from "../ui/Modal";
import { useDialogSize } from "../ui/dialog-size.hook";

const RESET_MODES: { mode: ResetMode; label: string; description: string }[] = [
  { mode: "soft", label: "Soft", description: "Files won't change, differences will be staged for commit." },
  { mode: "mixed", label: "Mixed", description: "Files won't change, differences won't be staged." },
  { mode: "hard", label: "Hard", description: "Files will be reverted to the state of the selected commit. Local changes will be lost." },
  { mode: "keep", label: "Keep", description: "Files will be reverted to the state of the selected commit, but local changes will be kept intact." },
];

/** The mode picked last, the default of the next reset for the window's lifetime; WebStorm starts on Mixed. */
let lastMode: ResetMode = "mixed";

/**
 * WebStorm's "Git Reset" dialog: resets the local branch `branch` of `scope` (`HEAD` when detached) to `commit` in the
 * picked mode where it is checked out, on a session's VM too; a branch no worktree has checked out (`isCheckedOut`)
 * moves alone, so the dialog offers no mode for it. Dragging an edge resizes the dialog.
 */
export function ResetDialog({
  scope,
  branch,
  isCheckedOut,
  commit,
  onClose,
  onReset,
}: {
  scope: GitScope;
  branch: string;
  isCheckedOut: boolean;
  commit: Commit;
  onClose: () => void;
  onReset: () => void;
}) {
  const name = branch === "HEAD" ? "the detached HEAD" : branch;
  const dialog = useDialogSize("reset");
  const [mode, setMode] = useState<ResetMode>(lastMode);
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  async function submit() {
    if (isBusy) return;
    setIsBusy(true);
    setError(null);
    lastMode = mode;
    try {
      await commands.gitReset(scope, branch, commit.id, mode);
      reportSuccess(`Reset ${name} to ${commit.id.slice(0, 8)}${isCheckedOut ? ` (${mode})` : ""}`);
      onReset();
      onClose();
    } catch (reason) {
      setError(String(reason));
      setIsBusy(false);
    }
  }

  return (
    <Modal label="Git reset" onClose={onClose} isCloseable={!isBusy} className="bg-(--surface-chat) p-4" style={dialog.style} resize={dialog.resize}>
      <h2 className="mb-1 text-base font-semibold">Git Reset</h2>
      <p className="mb-3 text-[13px] text-neutral-400">
        Resets <span className="font-mono text-neutral-300">{name}</span> to <span className="font-mono text-neutral-300">{commit.id.slice(0, 8)}</span>{" "}
        {commit.subject}
        {isCheckedOut ? " and updates the index and the files by the mode:" : ". No worktree has it checked out, so no file changes."}
      </p>
      {isCheckedOut ? (
        <fieldset className="mb-3 flex shrink-0 flex-col gap-1.5">
          {RESET_MODES.map((option) => (
            <label key={option.mode} className="flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-(--row-hover)">
              <input type="radio" name="reset-mode" value={option.mode} checked={mode === option.mode} onChange={() => setMode(option.mode)} className="mt-1 accent-blue-500" />
              <span className="flex flex-col">
                <span className="text-[13px] text-neutral-100">{option.label}</span>
                <span className={`text-[12px] ${option.mode === "hard" ? "text-red-300" : "text-neutral-500"}`}>{option.description}</span>
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}
      {error ? <p className="mb-3 text-[13px] whitespace-pre-wrap text-red-400">{error}</p> : null}
      <div className="mt-auto flex justify-end gap-2">
        <button type="button" onClick={onClose} disabled={isBusy} className={GHOST_BUTTON_MD}>
          Cancel
        </button>
        <button type="button" onClick={() => void submit()} disabled={isBusy} className={PRIMARY_BUTTON_MD} autoFocus>
          {isBusy ? "Resetting…" : "Reset"}
        </button>
      </div>
    </Modal>
  );
}
