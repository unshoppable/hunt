import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { PRIMARY_BUTTON_XS, SECONDARY_BUTTON_XS } from "../ui/buttons.constants";
import { BranchIcon } from "../ui/Icons";
import { ResizeGrips } from "../ui/ResizeGrips";
import { useDismiss } from "../ui/dismiss.hook";
import { usePopupSize } from "../ui/popup-size.hook";
import { useViewportSize } from "../ui/viewport-size.hook";

const MIN_SIZE = { width: 300, height: 140 };
/** The largest share of the window's width and height the popover may take. */
const MAX_SHARE = 0.8;

/** What confirming the popover does: push the session's commits, or commit the checked files first and then push. */
export type PushMode = "push" | "commitAndPush";

/**
 * Popover above the changelist's footer that names, before anything is pushed, the branch on `origin` the push lands
 * on and where it runs. Its confirm button holds the focus, so Enter pushes; Escape or a click outside closes it, a
 * press on one of `anchorRefs` closes without reopening. It hangs from the footer's left or right end (`align`), never
 * wider than the footer so that the panel does not clip it, and is as tall as its content up to the remembered height;
 * dragging its top or outer edge resizes it.
 */
export function PushPopover({
  mode,
  branch,
  target,
  pushesFromVm,
  isRemote,
  unpushedCount,
  fileCount,
  align,
  anchorRefs,
  onConfirm,
  onClose,
}: {
  mode: PushMode;
  /** The session's own branch, the one pushed. */
  branch: string;
  /** The branch on `origin` the push lands on. */
  target: string;
  pushesFromVm: boolean;
  isRemote: boolean;
  /** Commits already waiting for a push; `null` while unknown. */
  unpushedCount: number | null;
  /** Files the commit before the push takes; only read for `commitAndPush`. */
  fileCount: number;
  align: "left" | "right";
  anchorRefs: RefObject<Element | null>[];
  onConfirm: () => void;
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const viewport = useViewportSize();
  // The footer the popover is positioned in; the popover never grows wider than it.
  const [footerWidth, setFooterWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const footer = rootRef.current?.offsetParent;
    if (!(footer instanceof HTMLElement)) return;
    setFooterWidth(footer.clientWidth);
    const observer = new ResizeObserver(() => setFooterWidth(footer.clientWidth));
    observer.observe(footer);
    return () => observer.disconnect();
  }, []);
  const maxWidth = footerWidth === null ? viewport.width * MAX_SHARE : Math.min(footerWidth, viewport.width * MAX_SHARE);
  const { size, isHeightSet, grips } = usePopupSize("push", { min: MIN_SIZE, max: { width: maxWidth, height: viewport.height * MAX_SHARE } });
  useDismiss(rootRef, onClose, { anchorRefs });

  const remoteTarget = `origin/${target}`;
  const title =
    mode === "commitAndPush"
      ? `Commit ${fileCount} ${fileCount === 1 ? "file" : "files"} and push`
      : unpushedCount
        ? `Push ${unpushedCount} ${unpushedCount === 1 ? "commit" : "commits"}`
        : "Push";
  const how = pushesFromVm
    ? "The session's VM pushes the branch with the token stored there."
    : isRemote
      ? `Pushed from this Mac once the branch points at the same commit here and on the VM; rebased onto ${remoteTarget} first when it moved on.`
      : `Rebased onto ${remoteTarget} first when it moved on.`;

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label={title}
      className={`absolute bottom-full z-20 mb-2 flex flex-col rounded-md border border-neutral-600 bg-(--surface-inset) p-3 text-[13px] shadow-lg ${align === "left" ? "left-0" : "right-0"}`}
      style={{ width: size.width, maxHeight: size.height, height: isHeightSet ? size.height : undefined }}
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        <p className="mb-2 font-medium text-neutral-200">{title} to</p>
        <div className="mb-2 flex min-w-0 items-center gap-2 rounded border border-(--line) bg-white/4 px-2 py-1.5 font-mono text-[13px]" title={`${branch} → ${remoteTarget}`}>
          <BranchIcon className="size-3.5 shrink-0 text-neutral-400" />
          <span className="truncate text-white">{remoteTarget}</span>
        </div>
        <p className="text-neutral-400">
          From <span className="font-mono text-neutral-300">{branch}</span>. {how}
        </p>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={onClose} className={SECONDARY_BUTTON_XS}>
          Cancel
        </button>
        <button type="button" autoFocus onClick={onConfirm} className={PRIMARY_BUTTON_XS}>
          {mode === "commitAndPush" ? "Commit and Push" : "Push"}
        </button>
      </div>
      <ResizeGrips edges={{ top: true, left: align === "right", right: align === "left" }} {...grips} />
    </div>
  );
}
