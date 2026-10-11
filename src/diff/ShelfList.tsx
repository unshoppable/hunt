import { useState } from "react";
import { commands } from "../ipc/commands";
import type { Shelf } from "../ipc/types";
import { useFileIconUrl } from "./fileIcons";
import { STATUS_NAME_CLASS } from "./styles";
import { DANGER, ICON_BUTTON_BASE_SM, SECONDARY_BUTTON_SM } from "../ui/buttons";
import { ChevronIcon, CloseIcon } from "../ui/icons";
import { confirmDestructive } from "../ui/confirm";
import { baseName, dirName } from "../ui/path";
import { errorText, useLoad } from "../ui/useLoad";

/** Shelves of the session with unshelve and delete actions; reloads whenever `version` changes. */
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

  const deleteShelf = async (shelf: Shelf) => {
    if (!(await confirmDestructive(`Delete shelf "${shelf.name}"? Its ${shelf.files.length} changed files are lost.`))) return;
    run(shelf.reference, () => commands.dropShelf(sessionId, shelf.reference));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {error ? <p className="border-b border-(--line) px-2 py-1.5 text-[13px] text-red-400">{error}</p> : null}
      <ul className="min-h-0 flex-1 overflow-y-auto font-(family-name:--changelist-font-family) text-(length:--changelist-font-size) leading-(--changelist-line-height)">
        {shelves?.length === 0 ? <li className="p-3 text-[13px] text-neutral-500">Nothing on the shelf.</li> : null}
        {shelves?.map((shelf) => {
          const isExpanded = expanded.has(shelf.reference);
          const isBusy = busyReference === shelf.reference;
          return (
            <li key={shelf.reference} className="border-b border-(--line)">
              <div className="flex items-center gap-2 px-2 py-2.5">
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
                  className={SECONDARY_BUTTON_SM}
                  title="Restore the files and remove the shelf"
                >
                  Unshelve
                </button>
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => run(shelf.reference, () => commands.unshelve(sessionId, shelf.reference, true))}
                  className={SECONDARY_BUTTON_SM}
                  title="Restore the files but keep the shelf"
                >
                  Apply
                </button>
                <button type="button" disabled={isBusy} onClick={() => deleteShelf(shelf)} className={`${ICON_BUTTON_BASE_SM} -my-0.5 ${DANGER}`} title="Delete the shelf" aria-label="Delete the shelf">
                  <CloseIcon />
                </button>
              </div>
              {isExpanded ? (
                <ul className="pb-1">
                  {shelf.files.map((file) => (
                    <li key={file.path} className="flex items-center gap-2 py-1 pl-7 pr-2" title={file.path}>
                      <img src={fileIconUrl(file.path)} alt="" className="size-4 shrink-0" />
                      <span className={`truncate ${STATUS_NAME_CLASS[file.status] ?? "text-neutral-200"}`}>{baseName(file.path)}</span>
                      <span className="ml-auto truncate pl-1 text-[0.85em] text-neutral-600">{dirName(file.path)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
