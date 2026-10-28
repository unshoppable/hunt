import type { useTreeNavigation } from "../ui/tree-navigation.hook";
import { ChevronIcon, TrashIcon } from "../ui/Icons";
import { UnsavedDot } from "../ui/UnsavedDot";
import type { Guardrail, GuardrailListRow } from "./guardrail.types";

/** Indentation of a list row per folder level, in pixels. */
const ROW_INDENT = 14;

/**
 * The flat list of a kind's guardrails (agents, ADRs) and their folders, navigated with the arrow keys through
 * `navigation`, whose key of a folder is its path with a trailing slash and of a guardrail its path. The last row is
 * `emptyText` when the kind has no guardrails, or "Loading…" while `isLoading`.
 */
export function GuardrailList({
  rows,
  collapsedFolders,
  navigation,
  dirtyPaths,
  emptyText,
  isLoading,
  onToggleFolder,
  onDelete,
}: {
  rows: GuardrailListRow[];
  collapsedFolders: ReadonlySet<string>;
  navigation: ReturnType<typeof useTreeNavigation<HTMLUListElement>>;
  dirtyPaths: string[];
  emptyText: string | null;
  isLoading: boolean;
  onToggleFolder: (folder: string) => void;
  onDelete: (entry: Guardrail) => void;
}) {
  return (
    <ul {...navigation.listProps} className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 text-[13px] outline-none">
      {rows.map((row) =>
        row.type === "folder" ? (
          <FolderRow
            key={`folder:${row.folder}`}
            folder={row.folder}
            name={row.name}
            depth={row.depth}
            isExpanded={!collapsedFolders.has(row.folder)}
            isSelected={navigation.cursor === `${row.folder}/`}
            onToggle={() => {
              onToggleFolder(row.folder);
              navigation.select(`${row.folder}/`);
            }}
          />
        ) : (
          <GuardrailRow
            key={row.entry.path}
            entry={row.entry}
            depth={row.depth}
            isSelected={navigation.cursor === row.entry.path}
            isDirty={dirtyPaths.includes(row.entry.path)}
            onSelect={() => navigation.select(row.entry.path)}
            onDelete={() => onDelete(row.entry)}
          />
        ),
      )}
      {emptyText ? <li className="px-2 py-2 text-[13px] text-neutral-500">{emptyText}</li> : null}
      {isLoading ? <li className="px-2 py-2 text-[13px] text-neutral-500">Loading…</li> : null}
    </ul>
  );
}

/** Collapsible folder of the list; the rows below it are indented one level further. */
function FolderRow({ folder, name, depth, isExpanded, isSelected, onToggle }: { folder: string; name: string; depth: number; isExpanded: boolean; isSelected: boolean; onToggle: () => void }) {
  return (
    <li data-tree-key={`${folder}/`}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isExpanded}
        style={{ paddingLeft: 4 + depth * ROW_INDENT }}
        className={`flex w-full items-center gap-1 rounded py-1.5 pr-2 text-left ${isSelected ? "bg-(--row-selected) text-white" : "text-neutral-400 hover:bg-(--row-hover) hover:text-white"}`}
      >
        <ChevronIcon expanded={isExpanded} className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{name}</span>
      </button>
    </li>
  );
}

/** One guardrail of the list; its delete button shows up while the row is hovered or focused. */
function GuardrailRow({ entry, depth, isSelected, isDirty, onSelect, onDelete }: { entry: Guardrail; depth: number; isSelected: boolean; isDirty: boolean; onSelect: () => void; onDelete: () => void }) {
  return (
    <li className="group relative" data-tree-key={entry.path}>
      <button
        type="button"
        onClick={onSelect}
        title={entry.path}
        style={{ paddingLeft: 8 + depth * ROW_INDENT }}
        className={`flex w-full items-center gap-2 rounded py-1.5 pr-8 text-left ${isSelected ? "bg-(--row-selected) text-white" : "text-neutral-300 hover:bg-(--row-hover) hover:text-white"}`}
      >
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
        {isDirty ? <UnsavedDot /> : null}
      </button>
      <button
        type="button"
        onClick={onDelete}
        title={`Delete ${entry.name}`}
        aria-label={`Delete ${entry.name}`}
        className="absolute top-1/2 right-0.5 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-red-400 opacity-0 transition-colors group-hover:opacity-100 hover:bg-red-400/15 hover:text-red-300 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-blue-400/60 outline-none"
      >
        <TrashIcon />
      </button>
    </li>
  );
}
