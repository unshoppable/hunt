import { useRef, useState } from "react";
import { commands } from "../ipc/commands";
import { WORKTREE_LOCKED_MESSAGE } from "../chat/remoteSession";
import { BUTTON_BASE, PRIMARY, PRIMARY_BUTTON_XS, SECONDARY_BUTTON_XS } from "../ui/buttons";
import { ChevronDownIcon, PaperPlaneIcon, Spinner } from "../ui/icons";
import { ResizeGrips } from "../ui/ResizeGrips";
import { useDismiss } from "../ui/useDismiss";
import { PushPopover, type PushMode } from "./PushPopover";

const MENU_ITEM = "flex w-full items-center gap-6 rounded whitespace-nowrap px-2 py-1 text-left text-neutral-200 hover:bg-(--row-hover)";

/** Draft commit message of every session's changelist, kept across session switches for the window's lifetime. */
const draftBySession = new Map<string, string>();

/** Smallest height of the message box: two lines of text plus the input's padding and border. */
const MIN_HEIGHT = 57;
/** Rows of the file list that a dragged message box leaves visible above it. */
const LIST_ROOM = 80;
/** Height of the message box dragged last, shared by every changelist of the window; unset until the first drag. */
let draggedHeight: number | null = null;

/**
 * Footer of the changelist: a small, vertically resizable commit message box with the commit and shelve actions for
 * the checked files below it and a push button on the right, enabled while the branch has commits `origin`'s `target`
 * lacks. The commit button's chevron also offers "Commit and Push". ⌘⏎ commits in place; the push button, "Commit and
 * Push" and ⇧⌘⏎ first open a `PushPopover` that names `origin/<target>` and pushes on confirm. The message stays in the
 * box after a commit. `onCommit` and `onShelve` return false when the owner declined the action, e.g. after a warning
 * about unsaved edits.
 */
export function CommitBox({
  sessionId,
  paths,
  isLocked,
  isRemote,
  pushesFromVm,
  branch,
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
  /** The session's own branch, the one pushed. */
  branch: string;
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
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  /** Set while the push popover asks to confirm `mode`. */
  const [pushMode, setPushMode] = useState<PushMode | null>(null);
  const chevronRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const pushButtonRef = useRef<HTMLButtonElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  /** Height when the drag began and how far the box may grow before the file list above it gets too short. */
  const drag = useRef({ start: 0, max: 0 });

  const setMessage = (next: string) => {
    draftBySession.set(sessionId, next);
    setMessageState(next);
  };

  const canCommit = !step && paths.length > 0 && message.trim().length > 0;

  useDismiss(menuRef, () => setIsMenuOpen(false), { anchorRefs: [chevronRef], closeOnWindowBlur: true, isEnabled: isMenuOpen });

  /** Opens the push popover for `mode`; pressing the same trigger again closes it. */
  function askPush(mode: PushMode) {
    setIsMenuOpen(false);
    if (isLocked || step) return;
    if (mode === "commitAndPush" && !canCommit) return;
    setPushMode((current) => (current === mode ? null : mode));
  }

  function confirmPush() {
    const mode = pushMode;
    setPushMode(null);
    void (mode === "commitAndPush" ? commit(true) : pushOnly());
  }

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
    <div className="border-t border-(--line) px-3 py-4 text-[13px]">
      <div ref={boxRef} className="relative mb-2.5" style={{ height: height ?? undefined }}>
        <textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
            event.preventDefault();
            if (event.shiftKey) {
              askPush("commitAndPush");
            } else {
              void commit(false);
            }
          }}
          placeholder={paths.length ? `Commit message for ${paths.length} ${paths.length === 1 ? "file" : "files"}` : "Commit message"}
          disabled={isLocked || !!step}
          rows={3}
          className="block h-full min-h-[calc(2lh+18px)] w-full resize-none rounded border border-neutral-600 bg-(--surface-input) px-2.5 py-2 text-[13px] disabled:opacity-50"
        />
        <ResizeGrips edges={{ top: true }} {...grips} />
      </div>
      {error ? <p className="mb-2 whitespace-pre-wrap text-red-400">{error}</p> : null}
      <div className="relative flex items-center gap-2">
        <div className={`relative flex ${isLocked ? "opacity-40" : ""}`}>
          <button
            type="button"
            disabled={!canCommit}
            onClick={() => void commit(false)}
            aria-disabled={isLocked}
            className={`${PRIMARY_BUTTON_XS} rounded-r-none`}
            title={
              isLocked
                ? WORKTREE_LOCKED_MESSAGE
                : `${isRemote ? "Commit the checked files on the session's branch here; the branch on its VM follows" : "Commit the checked files on the session's branch"} (⌘⏎, ⇧⌘⏎ also pushes)`
            }
          >
            {step === "commit" ? (
              <>
                <Spinner />
                Committing…
              </>
            ) : (
              "Commit"
            )}
          </button>
          <button
            ref={chevronRef}
            type="button"
            disabled={!canCommit}
            onClick={() => (isLocked ? undefined : setIsMenuOpen((current) => !current))}
            aria-disabled={isLocked}
            aria-haspopup="menu"
            aria-expanded={isMenuOpen}
            aria-label="More commit actions"
            title={isLocked ? WORKTREE_LOCKED_MESSAGE : "More commit actions"}
            className={`${BUTTON_BASE} ${PRIMARY} h-[29px] w-6 rounded-l-none border-l border-white/25`}
          >
            <ChevronDownIcon />
          </button>
          {isMenuOpen ? (
            <div ref={menuRef} role="menu" className="absolute bottom-full left-0 z-20 mb-1 w-max min-w-full rounded border border-neutral-600 bg-(--surface-inset) p-1 shadow-lg">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setIsMenuOpen(false);
                  void commit(false);
                }}
                className={MENU_ITEM}
              >
                Commit
                <span className="ml-auto text-neutral-500">⌘⏎</span>
              </button>
              <button type="button" role="menuitem" onClick={() => askPush("commitAndPush")} className={MENU_ITEM}>
                Commit and Push…
                <span className="ml-auto text-neutral-500">⇧⌘⏎</span>
              </button>
            </div>
          ) : null}
        </div>
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
          ref={pushButtonRef}
          type="button"
          disabled={!!step || unpushedCount === 0}
          onClick={() => askPush("push")}
          aria-haspopup="dialog"
          aria-expanded={pushMode === "push"}
          aria-disabled={isLocked}
          className={`${SECONDARY_BUTTON_XS} ${isLocked ? "opacity-40" : ""}`}
          title={
            isLocked
              ? WORKTREE_LOCKED_MESSAGE
              : unpushedCount === 0
                ? `Every commit of the session is on ${target} of origin`
                : `${pushesFromVm ? `Push the session's branch ${target} from its VM with the token stored there` : isRemote ? `Push the session's commits to ${target} on origin from this Mac, once the branch points at the same commit here and on the VM, rebased onto ${target} when it moved on` : `Push the session's commits to ${target} on origin, rebased onto it when it moved on`}${unpushedCount ? ` (${unpushedCount} ${unpushedCount === 1 ? "commit" : "commits"})` : ""}`
          }
        >
          <PaperPlaneIcon className="size-3.5 shrink-0" />
          {step === "push" ? "Pushing…" : "Push"}
        </button>
        {pushMode ? (
          <PushPopover
            mode={pushMode}
            branch={branch}
            target={target}
            pushesFromVm={pushesFromVm}
            isRemote={isRemote}
            unpushedCount={unpushedCount}
            fileCount={paths.length}
            align={pushMode === "push" ? "right" : "left"}
            anchorRefs={[pushMode === "push" ? pushButtonRef : chevronRef]}
            onConfirm={confirmPush}
            onClose={() => setPushMode(null)}
          />
        ) : null}
      </div>
    </div>
  );
}
