import { useState } from "react";
import { commands } from "../ipc/commands";
import type { Shelf } from "./diff.types";
import { useFileIconUrl } from "../ui/file-icons/file-icons.hook";
import { STATUS_NAME_CLASS } from "../ui/styles.constants";
import { DANGER, ICON_BUTTON_BASE_SM, SECONDARY_BUTTON_XS } from "../ui/buttons.constants";
import { ChevronIcon, CloseIcon } from "../ui/Icons";
import { Collapsible } from "../ui/Collapsible";
import { confirmDestructive } from "../ui/confirm.utils";
import { baseName, dirName } from "../common/path/path.utils";
import { useLoad } from "../ui/load.hook";
import { errorText } from "../ui/error-text.utils";
import { useTreeNavigation } from "../ui/tree-navigation.hook";

/**
 * Shelves of the session with unshelve and delete actions; a shelf opens to list its files. The arrow keys move through
 * the shelves and files and open or close a shelf. Reloads whenever `version` changes.
 */
export function ShelfList({ sessionId, version, onChanged }: { sessionId: string; version: number; onChanged: () => void }) {
  const fileIconUrl = useFileIconUrl();
  const [shelves, setShelves] = useState<Shelf[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyReference, setBusyReference] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  useLoad(
    () => commands.listShelves(sessionId),
    {
      onValue: (result) => {
        setShelves(result);
        setError(null);
      },
      onError: (reason) => setError(errorText(reason)),
    },
    [sessionId, version],
  );

  const run = (reference: string, action: () => Promise<void>) => {
    setBusyReference(reference);
    setError(null);
    action()
      .then(onChanged)
      .catch((reason) => setError(String(reason)))
      .finally(() => setBusyReference(null));
  };

  const toggleExpanded = (reference: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(reference)) {
        next.delete(reference);
      } else {
        next.add(reference);
      }
      return next;
    });
  };

  /** A shelf's key is its reference, a file's the reference and its path. */
  const fileKey = (shelf: Shelf, path: string) => `${shelf.reference}:${path}`;
  const nav = useTreeNavigation({
    rows: (shelves ?? []).flatMap((shelf) => {
      const isExpanded = expanded.has(shelf.reference);
      return [{ key: shelf.reference, depth: 0, isExpanded }, ...(isExpanded ? shelf.files.map((file) => ({ key: fileKey(shelf, file.path), depth: 1 })) : [])];
    }),
    onToggle: toggleExpanded,
  });

  const deleteShelf = async (shelf: Shelf) => {
    if (!(await confirmDestructive(`Delete shelf "${shelf.name}"? Its ${shelf.files.length} changed files are lost.`))) return;
    run(shelf.reference, () => commands.dropShelf(sessionId, shelf.reference));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {error ? <p className="border-b border-(--line) px-2 py-1.5 text-[13px] text-red-400">{error}</p> : null}
      <ul {...nav.listProps} className="min-h-0 flex-1 overflow-y-auto outline-none font-(family-name:--changelist-font-family) text-(length:--changelist-font-size) leading-(--changelist-line-height)">
        {shelves?.length === 0 ? <li className="p-3 text-[13px] text-neutral-500">Nothing on the shelf.</li> : null}
        {shelves?.map((shelf) => {
          const isExpanded = expanded.has(shelf.reference);
          const isBusy = busyReference === shelf.reference;
          return (
            <li key={shelf.reference} className="border-b border-(--line)">
              <div data-tree-key={shelf.reference} data-selected={nav.cursor === shelf.reference} onClick={() => nav.select(shelf.reference)} className="tree-row flex items-center gap-2 px-3 py-2.5">
                <button type="button" onClick={() => toggleExpanded(shelf.reference)} className={`${ICON_BUTTON_BASE_SM} -my-0.5 text-neutral-500 hover:bg-(--row-hover) hover:text-neutral-200`} aria-label={isExpanded ? "Collapse" : "Expand"}>
                  <ChevronIcon expanded={isExpanded} />
                </button>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-neutral-200" title={shelf.name}>
                    {shelf.name}
                  </div>
                  <div className="text-[0.85em] text-neutral-500">
                    {shelf.files.length} {shelf.files.length === 1 ? "file" : "files"} · {new Date(shelf.createdAt).toLocaleString()}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => run(shelf.reference, () => commands.unshelve(sessionId, shelf.reference, false))}
                  className={SECONDARY_BUTTON_XS}
                  title="Restore the files and remove the shelf"
                >
                  Unshelve
                </button>
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => run(shelf.reference, () => commands.unshelve(sessionId, shelf.reference, true))}
                  className={SECONDARY_BUTTON_XS}
                  title="Restore the files but keep the shelf"
                >
                  Apply
                </button>
                <button type="button" disabled={isBusy} onClick={() => deleteShelf(shelf)} className={`${ICON_BUTTON_BASE_SM} -my-0.5 ${DANGER}`} title="Delete the shelf" aria-label="Delete the shelf">
                  <CloseIcon />
                </button>
              </div>
              <Collapsible isOpen={isExpanded}>
                <ul className="pb-1">
                  {shelf.files.map((file) => (
                    <li
                      key={file.path}
                      data-tree-key={fileKey(shelf, file.path)}
                      data-selected={nav.cursor === fileKey(shelf, file.path)}
                      onClick={() => nav.select(fileKey(shelf, file.path))}
                      className="tree-row flex items-center gap-2 py-1 pr-3 pl-8"
                      title={file.path}
                    >
                      <img src={fileIconUrl(file.path)} alt="" className="size-4 shrink-0" />
                      <span className={`truncate ${STATUS_NAME_CLASS[file.status] ?? "text-neutral-200"}`}>{baseName(file.path)}</span>
                      <span className="ml-auto truncate pl-1 text-[0.85em] text-neutral-600">{dirName(file.path)}</span>
                    </li>
                  ))}
                </ul>
              </Collapsible>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
