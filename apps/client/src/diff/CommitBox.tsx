import { useRef, useState } from "react";
import { commands } from "../ipc/commands";
import { WORKTREE_LOCKED_MESSAGE } from "../chat/remoteSession";
import { PRIMARY_BUTTON_XS, SECONDARY_BUTTON_XS } from "../ui/buttons";
import { PaperPlaneIcon } from "../ui/icons";
import { ResizeGrips } from "../ui/ResizeGrips";
import { INPUT } from "./styles";

/** Draft commit message of every session's changelist, kept across session switches for the window's lifetime. */
const draftBySession = new Map<string, string>();

/** Smallest height of the message box: two lines of text plus the input's padding and border. */
const MIN_HEIGHT = 49;
/** Rows of the file list that a dragged message box leaves visible above it. */
const LIST_ROOM = 80;
/** Height of the message box dragged last, shared by every changelist of the window; unset until the first drag. */
let draggedHeight: number | null = null;

/**
 * Footer of the changelist: a small, vertically resizable commit message box with the commit and shelve actions for
 * the checked files below it and a push button on the right, enabled while the branch has commits `origin`'s `target`
 * lacks. ⌘⏎ commits, ⇧⌘⏎ commits and pushes; both happen in place, without a dialog.
 * `onCommit` and `onShelve` return false when the owner declined the action, e.g. after a warning about unsaved edits.
 */
export function CommitBox({
  sessionId,
  paths,
  isLocked,
  isRemote,
  pushesFromVm,
  target,
  unpushedCount,
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
  /** Whether the push runs on the session's VM with the token stored there (a poller session); else it runs here. */
  pushesFromVm: boolean;
  /** The branch on `origin` a push lands on: the one the session was created from, or a poller session's own. */
  target: string;
  /** Commits a push would publish; `null` while unknown, which keeps the push button enabled. */
  unpushedCount: number | null;
  notice: string | null;
  onCommit: () => Promise<boolean>;
  onCommitted: (paths: string[]) => void;
  onPushed: () => void;
  onShelve: () => void;
}) {
  const [message, setMessageState] = useState(() => draftBySession.get(sessionId) ?? "");
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<"commit" | "push" | null>(null);
  const [height, setHeight] = useState(draggedHeight);
  const boxRef = useRef<HTMLDivElement>(null);
  /** Height when the drag began and how far the box may grow before the file list above it gets too short. */
  const drag = useRef({ start: 0, max: 0 });

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
      await push("The commit was created, but the push failed");
    }
    setStep(null);
  }

  /** Pushes the session's commits to `target` on `origin`; a failure is reported with `failure` as prefix. */
  async function push(failure: string) {
    setStep("push");
    try {
      await commands.pushBranch(sessionId);
      onPushed();
    } catch (reason) {
      setError(`${failure}: ${String(reason)}`);
    }
  }

  async function pushOnly() {
    if (isLocked || step) return;
    setError(null);
    await push("The push failed");
    setStep(null);
  }

  const grips = {
    onStart: ({ height: rendered }: { height: number }) => {
      const list = boxRef.current?.parentElement?.previousElementSibling;
      const room = list instanceof HTMLElement ? Math.max(0, list.clientHeight - LIST_ROOM) : 0;
      drag.current = { start: rendered, max: rendered + room };
    },
    onDrag: ({ dy }: { dy: number }) => {
      draggedHeight = Math.min(drag.current.max, Math.max(MIN_HEIGHT, drag.current.start + dy));
      setHeight(draggedHeight);
    },
    onEnd: () => {},
  };

  return (
    <div className="border-t border-(--line) px-3 pt-2.5 pb-3.5 text-[13px]">
      <div ref={boxRef} className="relative mb-2" style={{ height: height ?? undefined }}>
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
          className={`${INPUT} block h-full min-h-[calc(2lh+10px)] resize-none text-[13px] disabled:opacity-50`}
        />
        <ResizeGrips edges={{ top: true }} {...grips} />
      </div>
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
          {step === "commit" ? "Committing…" : "Commit"}
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
        <button
          type="button"
          disabled={!!step || unpushedCount === 0}
          onClick={() => void pushOnly()}
          aria-disabled={isLocked}
          className={`${SECONDARY_BUTTON_XS} ${isLocked ? "opacity-40" : ""}`}
          title={
            isLocked
              ? WORKTREE_LOCKED_MESSAGE
              : unpushedCount === 0
                ? `Every commit of the session is on ${target} of origin`
                : `${pushesFromVm ? `Push the session's branch ${target} from its VM with the token stored there` : isRemote ? `Push the session's commits to ${target} on origin from this Mac, once the branch caught up with the VM's commit and was rebased on the VM when ${target} moved on` : `Push the session's commits to ${target} on origin, rebased onto it when it moved on`}${unpushedCount ? ` (${unpushedCount} ${unpushedCount === 1 ? "commit" : "commits"})` : ""}`
          }
        >
          <PaperPlaneIcon className="size-3.5 shrink-0" />
          {step === "push" ? "Pushing…" : "Push"}
        </button>
      </div>
    </div>
  );
}
