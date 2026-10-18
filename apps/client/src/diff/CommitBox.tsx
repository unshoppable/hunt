import { useState } from "react";
import { commands } from "../ipc/commands";
import { WORKTREE_LOCKED_MESSAGE } from "../chat/remoteSession";
import { PRIMARY_BUTTON_XS, SECONDARY_BUTTON_XS } from "../ui/buttons";
import { INPUT } from "./styles";

/** Draft commit message of every session's changelist, kept across session switches for the window's lifetime. */
const draftBySession = new Map<string, string>();

/**
 * Footer of the changelist: a small, vertically resizable commit message box with the commit and shelve actions for
 * the checked files below it. ⌘⏎ commits, ⇧⌘⏎ commits and pushes the branch; both happen in place, without a dialog.
 * `onCommit` and `onShelve` return false when the owner declined the action, e.g. after a warning about unsaved edits.
 */
export function CommitBox({
  sessionId,
  paths,
  isLocked,
  isRemote,
  notice,
  onCommit,
  onCommitted,
  onPushed,
  onShelve,
}: {
  sessionId: string;
  paths: string[];
  isLocked: boolean;
  isRemote: boolean;
  notice: string | null;
  onCommit: () => Promise<boolean>;
  onCommitted: (paths: string[]) => void;
  onPushed: () => void;
  onShelve: () => void;
}) {
  const [message, setMessageState] = useState(() => draftBySession.get(sessionId) ?? "");
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<"commit" | "push" | null>(null);

  const setMessage = (next: string) => {
    draftBySession.set(sessionId, next);
    setMessageState(next);
  };

  const canCommit = !step && paths.length > 0 && message.trim().length > 0;

  async function commit(shouldPush: boolean) {
    if (isLocked || !canCommit || !(await onCommit())) return;
    const committedPaths = paths;
    setStep("commit");
    setError(null);
    try {
      await commands.commitFiles(sessionId, committedPaths, message.trim());
    } catch (reason) {
      setError(String(reason));
      setStep(null);
      return;
    }
    setMessage("");
    onCommitted(committedPaths);
    if (shouldPush) {
      setStep("push");
      try {
        await commands.pushBranch(sessionId);
        onPushed();
      } catch (reason) {
        setError(`The commit was created, but the push failed: ${String(reason)}`);
      }
    }
    setStep(null);
  }

  return (
    <div className="border-t border-(--line) px-3 py-2.5 text-[13px]">
      <textarea
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
          event.preventDefault();
          void commit(event.shiftKey);
        }}
        placeholder={paths.length ? `Commit message for ${paths.length} ${paths.length === 1 ? "file" : "files"}` : "Commit message"}
        disabled={isLocked || !!step}
        rows={2}
        className={`${INPUT} mb-2 min-h-[calc(2lh+10px)] resize-y text-[13px] disabled:opacity-50`}
      />
      {error ? <p className="mb-2 whitespace-pre-wrap text-red-400">{error}</p> : null}
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={!canCommit}
          onClick={() => void commit(false)}
          aria-disabled={isLocked}
          className={`${PRIMARY_BUTTON_XS} ${isLocked ? "opacity-40" : ""}`}
          title={
            isLocked
              ? WORKTREE_LOCKED_MESSAGE
              : `${isRemote ? "Commit the checked files on the session's branch on its VM" : "Commit the checked files on the session's branch"} (⌘⏎, ⇧⌘⏎ also pushes)`
          }
        >
          {step === "commit" ? "Committing…" : step === "push" ? "Pushing…" : "Commit"}
        </button>
        <button
          type="button"
          disabled={!paths.length || !!step}
          onClick={() => (isLocked ? undefined : onShelve())}
          aria-disabled={isLocked}
          className={`${SECONDARY_BUTTON_XS} ${isLocked ? "opacity-40" : ""}`}
          title={isLocked ? WORKTREE_LOCKED_MESSAGE : "Move the checked files to the shelf"}
        >
          Shelve…
        </button>
        <span className="ml-auto truncate text-neutral-500">{notice ?? (paths.length ? `${paths.length} selected` : "")}</span>
      </div>
    </div>
  );
}
