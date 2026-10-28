import { useRef, type RefObject } from "react";
import { dirName, repoName } from "../common/path/path.utils";
import { CheckIcon, FolderIcon } from "../ui/Icons";
import { useDismiss } from "../ui/dismiss.hook";

/**
 * Menu anchored below `anchorRef` listing the recently used repositories, with the folder dialog as last entry; choosing
 * a repository starts a session in it. `className` places the menu relative to its positioned parent.
 */
export function RepositoryMenu({
  anchorRef,
  repoPath,
  recentRepoPaths,
  onSelect,
  onPick,
  onClose,
  className,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  repoPath: string;
  recentRepoPaths: string[];
  onSelect: (path: string) => void;
  onPick: () => void;
  onClose: () => void;
  className: string;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  useDismiss(menuRef, onClose, { anchorRefs: [anchorRef] });

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="Repositories"
      className={`absolute z-50 mt-1.5 w-72 max-w-[calc(100cqw-2rem)] rounded-xl border border-neutral-600 bg-(--surface-chat) p-1 text-sm text-neutral-400 shadow-2xl shadow-black/50 ${className}`}
    >
      {recentRepoPaths.map((path) => (
        <button
          key={path}
          type="button"
          role="menuitem"
          onClick={() => onSelect(path)}
          title={`Start a session in ${path}`}
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-(--row-hover) hover:text-neutral-200"
        >
          <FolderIcon />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-neutral-200">{repoName(path)}</span>
            <span className="truncate text-[12px] text-neutral-500">{dirName(path)}</span>
          </span>
          {path === repoPath ? <CheckIcon className="size-3.5 shrink-0 text-neutral-400" /> : null}
        </button>
      ))}
      {recentRepoPaths.length ? <div className="mx-1 my-1 border-t border-(--line)" /> : null}
      <button
        type="button"
        role="menuitem"
        onClick={onPick}
        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-(--row-hover) hover:text-neutral-200"
      >
        <FolderIcon />
        Choose another repository…
      </button>
    </div>
  );
}
