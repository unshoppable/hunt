import { useState } from "react";
import { commands } from "../ipc/commands";
import { INPUT } from "./styles";
import { GHOST_BUTTON_MD, PRIMARY_BUTTON_MD, SECONDARY_BUTTON_MD } from "../ui/buttons";
import { Modal } from "../ui/Modal";

/**
 * Asks for a commit message and commits the given files on the session's current branch, optionally pushing the
 * branch afterwards. When the push fails after the commit went through, the dialog offers to retry only the push.
 */
export function CommitDialog({
  sessionId,
  paths,
  onClose,
  onCommitted,
  onPushed,
}: {
  sessionId: string;
  paths: string[];
  onClose: () => void;
  onCommitted: () => void;
  onPushed: () => void;
}) {
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<"commit" | "push" | null>(null);
  /** Set once the commit exists; from then on the dialog only pushes. */
  const [isCommitted, setIsCommitted] = useState(false);

  async function commit(shouldPush: boolean) {
    if (!message.trim() || step) return;
    setStep("commit");
    setError(null);
    try {
      await commands.commitFiles(sessionId, paths, message.trim());
    } catch (reason) {
      setError(String(reason));
      setStep(null);
      return;
    }
    setIsCommitted(true);
    onCommitted();
    if (!shouldPush) {
      onClose();
      return;
    }
    await push();
  }

  async function push() {
    setStep("push");
    setError(null);
    try {
      await commands.pushBranch(sessionId);
      onPushed();
      onClose();
    } catch (reason) {
      setError(`The commit was created, but the push failed: ${String(reason)}`);
      setStep(null);
    }
  }

  return (
    <Modal label="Commit changes" onClose={onClose} isCloseable={!step} className="w-[520px] bg-(--surface-chat) p-4">
      <h2 className="mb-1 text-base font-semibold">Commit changes</h2>
      <p className="mb-3 text-[13px] text-neutral-400">
        {paths.length} {paths.length === 1 ? "file goes" : "files go"} into the commit on the session's current branch.
      </p>
      <label className="mb-1 block text-[13px] text-neutral-400">Commit message</label>
      <textarea
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void commit(false);
          }
        }}
        placeholder="What do these changes do?"
        autoFocus
        disabled={isCommitted}
        rows={5}
        className={`${INPUT} mb-3 resize-y`}
      />
      {error ? <p className="mb-3 whitespace-pre-wrap text-[13px] text-red-400">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} disabled={!!step} className={GHOST_BUTTON_MD}>
          {isCommitted ? "Close" : "Cancel"}
        </button>
        {isCommitted ? (
          <button type="button" onClick={() => void push()} disabled={!!step} className={PRIMARY_BUTTON_MD}>
            {step === "push" ? "Pushing…" : "Retry push"}
          </button>
        ) : (
          <>
            <button type="button" onClick={() => void commit(true)} disabled={!!step || !message.trim()} className={SECONDARY_BUTTON_MD}>
              Commit and push
            </button>
            <button type="button" onClick={() => void commit(false)} disabled={!!step || !message.trim()} className={PRIMARY_BUTTON_MD} title="⌘⏎">
              {step === "commit" ? "Committing…" : "Commit"}
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
