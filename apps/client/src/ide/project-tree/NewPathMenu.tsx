import { useEffect, useRef, type KeyboardEvent } from "react";
import { vendoredIconUrl } from "../../ui/file-icons/file-icons.utils";

/** What the New menu creates: an empty file or a folder, with the generic icon of each. */
const NEW_PATH_ITEMS = [
  { isDir: false, label: "File", icon: "_file" },
  { isDir: true, label: "Directory", icon: "_folder" },
] as const;

/**
 * The items of the project tree's New menu, listed as in WebStorm: File and Directory with their icons, the folder item
 * labelled with `folderShortcut`. With `autoFocus` the first item takes the focus; the arrow keys move it between the
 * items, as does the pointer; Enter or a click picks one.
 */
export function NewPathMenuItems({
  folderShortcut,
  isDisabled,
  disabledReason,
  autoFocus = false,
  onPick,
}: {
  folderShortcut: string | null;
  isDisabled: boolean;
  disabledReason?: string;
  autoFocus?: boolean;
  onPick: (isDir: boolean) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoFocus) {
      rootRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    }
  }, [autoFocus]);

  const moveFocus = (event: KeyboardEvent) => {
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const items = [...(rootRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    items[(index + step + items.length) % items.length]?.focus();
  };

  return (
    <div ref={rootRef} onKeyDown={moveFocus}>
      {NEW_PATH_ITEMS.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          onClick={() => onPick(item.isDir)}
          // The pointer moves the focus, so the focused item is the only highlighted one, also right after ⌘N.
          onMouseEnter={(event) => event.currentTarget.focus()}
          aria-disabled={isDisabled}
          title={isDisabled ? disabledReason : undefined}
          className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-neutral-200 outline-none focus:bg-(--row-hover) ${isDisabled ? "opacity-40" : ""}`}
        >
          <img src={vendoredIconUrl(item.icon)} alt="" className="size-4 shrink-0" />
          {item.label}
          {item.isDir && folderShortcut ? <span className="ml-auto pl-4 text-neutral-500">{folderShortcut}</span> : null}
        </button>
      ))}
    </div>
  );
}
