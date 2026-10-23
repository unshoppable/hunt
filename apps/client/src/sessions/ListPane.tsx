import type { ReactNode } from "react";
import { ICON_BUTTON_SM } from "../ui/buttons";
import { CloseIcon } from "../ui/icons";
import { SearchField } from "../ui/SearchField";

type ListPaneProps = {
  query: string;
  onQueryChange: (query: string) => void;
  searchPlaceholder: string;
  /** Names the list for assistive technology, e.g. "Open pull requests". */
  ariaLabel: string;
  /** Controls shown between the search field and the close button. */
  tools?: ReactNode;
  /** A row of controls below the search field that narrow the list further. */
  filters?: ReactNode;
  error: string | null;
  isLoading: boolean;
  /** Shown when the load found nothing at all. */
  emptyText: string;
  /** Shown when `query` matches none of the loaded items; `rowCount` is the number of matching rows. */
  noMatchText: string;
  rowCount: number;
  /** Whether anything was loaded; the empty and no-match rows need it to tell the two apart. */
  hasItems: boolean;
  onClose: () => void;
  children: ReactNode;
};

/**
 * A list that fills the chat pane in place of the start view: a search field with a close button on top, optional
 * filters below it, the rows below them. Escape in the empty search field closes the list, like the close button; the
 * rows are `children`, `<li>`s.
 */
export function ListPane({
  query,
  onQueryChange,
  searchPlaceholder,
  ariaLabel,
  tools,
  filters,
  error,
  isLoading,
  emptyText,
  noMatchText,
  rowCount,
  hasItems,
  onClose,
  children,
}: ListPaneProps) {
  return (
    <section aria-label={ariaLabel} className="flex min-h-0 flex-1 flex-col text-sm">
      <div className="flex shrink-0 items-center gap-2 px-4 pt-3 pb-2">
        <SearchField value={query} onChange={onQueryChange} placeholder={searchPlaceholder} ariaLabel={searchPlaceholder} autoFocus onEscape={onClose} className="min-w-0 flex-1" />
        {tools}
        <button type="button" onClick={onClose} className={ICON_BUTTON_SM} title="Back to the start view (Escape)" aria-label="Close the list">
          <CloseIcon />
        </button>
      </div>
      {filters ? <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 pb-2">{filters}</div> : null}
      <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-x-hidden overflow-y-auto px-2 pb-3">
        {error ? <li className="mx-2 rounded-lg border border-red-400/40 bg-red-400/10 px-3 py-2 text-red-300 break-words">{error}</li> : null}
        {!error && isLoading ? <li className="px-4.5 py-1.5 text-[13px] text-neutral-500">Loading…</li> : null}
        {!error && !isLoading && !hasItems ? <li className="px-4.5 py-1.5 text-[13px] text-neutral-500">{emptyText}</li> : null}
        {!error && !isLoading && hasItems && rowCount === 0 ? <li className="px-4.5 py-1.5 text-[13px] text-neutral-500">{noMatchText}</li> : null}
        {children}
      </ul>
    </section>
  );
}
