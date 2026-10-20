import { useLayoutEffect, useRef, useState } from "react";
import { useDismiss } from "../ui/useDismiss";

/** One entry of a context menu of the Git tab. */
export type GitMenuEntry<Kind extends string> = {
  kind: Kind;
  label: string;
  /** Why the entry cannot run, shown as its tooltip; `null` when it can. */
  disabledReason: string | null;
  /** Shown in red: the entry removes something. */
  isDanger: boolean;
  /** Opens a new group of the menu, separated from the entries before. */
  startsGroup: boolean;
};

/**
 * A context menu of the Git tab, headed by `title` (the branch or commit it acts on), opened at the click position
 * `x`/`y` and kept inside the window; entries that cannot run stay visible, greyed out, with the reason as tooltip.
 */
export function GitMenu<Kind extends string>({
  title,
  x,
  y,
  entries,
  onPick,
  onClose,
}: {
  title: string;
  x: number;
  y: number;
  entries: GitMenuEntry<Kind>[];
  onPick: (entry: GitMenuEntry<Kind>) => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  useDismiss(menuRef, onClose, { closeOnWindowBlur: true });

  // The menu is wider than the tree pane: it moves left or up as far as the window needs.
  useLayoutEffect(() => {
    const rect = menuRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition({ left: Math.max(0, Math.min(x, window.innerWidth - rect.width - 8)), top: Math.max(0, Math.min(y, window.innerHeight - rect.height - 8)) });
  }, [x, y]);

  return (
    <div ref={menuRef} role="menu" style={position} className="fixed z-50 max-w-[32rem] min-w-44 rounded border border-neutral-600 bg-(--surface-inset) p-1 text-[13px] shadow-lg">
      <div className="mb-1 truncate border-b border-(--line) px-2 pb-1 font-mono text-[12px] text-neutral-500" title={title}>
        {title}
      </div>
      {entries.map((entry) => (
        <button
          key={entry.kind}
          type="button"
          role="menuitem"
          aria-disabled={!!entry.disabledReason}
          title={entry.disabledReason ?? undefined}
          onClick={() => (entry.disabledReason ? undefined : onPick(entry))}
          className={`block w-full truncate rounded px-2 py-1 text-left hover:bg-(--row-hover) ${entry.isDanger ? "text-red-300" : "text-neutral-200"} ${entry.startsGroup ? "mt-1 border-t border-(--line) pt-1.5" : ""} ${entry.disabledReason ? "opacity-40" : ""}`}
        >
          {entry.label}
        </button>
      ))}
    </div>
  );
}
