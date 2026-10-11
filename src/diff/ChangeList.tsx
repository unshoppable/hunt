import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { commands } from "../ipc/commands";
import type { ChangedFile, ChangedFileView } from "../ipc/types";
import { useSettingsStore } from "../state/settings";
import { useHuntStore } from "../state/store";
import { otherTouchers, type ChangeScope } from "./attribution";
import { buildChangeTree, type FolderNode, type TreeNode } from "./changeTree";
import { Checkbox, type CheckState } from "./Checkbox";
import { folderIconUrl, useFileIconUrl } from "./fileIcons";
import { useReviewDraftCount } from "../review/reviewComments";
import { ReviewDialog } from "./ReviewDialog";
import { ShelfList } from "./ShelfList";
import { ShelveDialog } from "./ShelveDialog";
import { baseName, dirName } from "../ui/path";
import { STATUS_NAME_CLASS } from "./styles";
import { ICON_BUTTON_SM, PRIMARY_BUTTON_SM, SECONDARY_BUTTON_SM, TAB_ACTIVE, TAB_BUTTON_SM, TAB_INACTIVE } from "../ui/buttons";
import { confirmDestructive } from "../ui/confirm";

type Tab = "changes" | "shelf";

type Dialog = { kind: "shelve"; paths: string[] } | { kind: "review" } | null;

/** One visible row of the tree view; `depth` is the indentation level. */
type Row = { node: TreeNode; depth: number };

/**
 * Scope toggle of a shared worktree; `hiddenCount` is how many files the current scope leaves out and
 * `includesParent` is set for a sub session, whose own scope also holds the changes of its parent.
 */
export type ScopeControl = { value: ChangeScope; hiddenCount: number; includesParent: boolean; onChange: (scope: ChangeScope) => void };

/**
 * The changelist: changed files as a flat list or folder tree with checkboxes, plus the shelf tab and either the shelve
 * action for the checked files or, in a pull request review, the submission of the review.
 */
export function ChangeList({
  sessionId,
  files,
  scope,
  selectedPath,
  hasUnsavedChanges,
  onSelect,
  onContextMenu,
  onWorktreeChanged,
}: {
  sessionId: string;
  files: ChangedFileView[];
  /** Set when other sessions share the worktree; `null` hides the toggle. */
  scope: ScopeControl | null;
  selectedPath: string | null;
  /** The diff editor holds unsaved edits; shelving would use the content on disk. */
  hasUnsavedChanges: boolean;
  onSelect: (path: string) => void;
  onContextMenu: (event: MouseEvent, file: ChangedFile) => void;
  /** Called after a shelve or unshelve so the owner reloads the worktree state. */
  onWorktreeChanged: () => void;
}) {
  const fileIconUrl = useFileIconUrl();
  const view = useSettingsStore((state) => state.changelistView);
  const setView = useSettingsStore((state) => state.setChangelistView);
  const sessions = useHuntStore((state) => state.sessions);
  const session = sessions.find((candidate) => candidate.id === sessionId);
  const parentId = session?.parentId ?? null;
  const pullRequest = session?.pullRequest ?? null;
  const draftCount = useReviewDraftCount(sessionId);
  const [tab, setTab] = useState<Tab>("changes");
  /** Files are checked by default; only unchecked paths are stored so new files start checked. */
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [dialog, setDialog] = useState<Dialog>(null);
  /** Shown in the footer once a review went out, until the next dialog opens. */
  const [notice, setNotice] = useState<string | null>(null);
  /** Bumped after shelf operations so the shelf list reloads even when the file list is unchanged. */
  const [shelfVersion, setShelfVersion] = useState(0);

  useEffect(() => {
    setExcluded(new Set());
    setCollapsed(new Set());
  }, [sessionId]);

  const tree = useMemo(() => buildChangeTree(files), [files]);
  const filesByPath = useMemo(() => new Map(files.map((file) => [file.path, file])), [files]);

  /** Badge for a file other sessions of the worktree changed: `null` when only this session or its parent did. */
  const renderOwnerBadge = (path: string) => {
    const file = filesByPath.get(path);
    if (!file) return null;
    const titles = otherTouchers(file, sessionId, parentId).map((id) => sessions.find((session) => session.id === id)?.title ?? "a deleted session");
    if (!titles.length) return null;
    const isShared = file.touchedBy.includes(sessionId) || (!!parentId && file.touchedBy.includes(parentId));
    return (
      <span
        className="max-w-24 shrink-0 truncate rounded bg-amber-400/15 px-1 text-[0.75em] leading-tight text-amber-300"
        title={isShared ? `Also changed by: ${titles.join(", ")}. The diff shows those changes as well.` : `Changed by: ${titles.join(", ")}`}
      >
        {isShared ? "shared" : titles.join(", ")}
      </span>
    );
  };
  const checkedPaths = useMemo(() => files.filter((file) => !excluded.has(file.path)).map((file) => file.path), [files, excluded]);

  const rows = useMemo(() => {
    const result: Row[] = [];
    const visit = (folder: FolderNode, depth: number) => {
      for (const child of folder.children) {
        result.push({ node: child, depth });
        if (child.kind === "folder" && !collapsed.has(child.path)) {
          visit(child, depth + 1);
        }
      }
    };
    visit(tree, 0);
    return result;
  }, [tree, collapsed]);

  const stateOf = (paths: ChangedFile[]): CheckState => {
    const checkedCount = paths.filter((file) => !excluded.has(file.path)).length;
    if (checkedCount === 0) return "unchecked";
    return checkedCount === paths.length ? "checked" : "mixed";
  };

  const setChecked = (targets: ChangedFile[], isChecked: boolean) => {
    setExcluded((current) => {
      const next = new Set(current);
      for (const file of targets) {
        if (isChecked) {
          next.delete(file.path);
        } else {
          next.add(file.path);
        }
      }
      return next;
    });
  };

  const toggleGroup = (targets: ChangedFile[]) => setChecked(targets, stateOf(targets) !== "checked");

  const toggleCollapsed = (path: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const openShelveDialog = async () => {
    if (!checkedPaths.length) return;
    if (hasUnsavedChanges && !(await confirmDestructive("The diff editor has unsaved changes. Only the content saved on disk is used. Continue?", "Continue"))) return;
    setNotice(null);
    setDialog({ kind: "shelve", paths: checkedPaths });
  };

  const openReviewDialog = () => {
    setNotice(null);
    setDialog({ kind: "review" });
  };

  const worktreeChanged = () => {
    setShelfVersion((version) => version + 1);
    onWorktreeChanged();
  };

  const renderFile = (file: ChangedFile, name: string, depth: number, showDirectory: boolean) => (
    <li key={file.path} className={`flex items-center gap-1.5 pr-2 hover:bg-(--row-hover) ${selectedPath === file.path ? "bg-(--row-active)" : ""}`} style={{ paddingLeft: `calc(8px + ${depth} * var(--changelist-indent))` }}>
      <Checkbox state={excluded.has(file.path) ? "unchecked" : "checked"} onChange={() => setChecked([file], excluded.has(file.path))} />
      <button
        type="button"
        onClick={() => onSelect(file.path)}
        onContextMenu={(event) => onContextMenu(event, file)}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        title={`${file.path} (${file.status})`}
      >
        <img src={fileIconUrl(file.path)} alt="" className="size-4 shrink-0" />
        <span className={`truncate ${STATUS_NAME_CLASS[file.status] ?? "text-neutral-200"}`}>{name}</span>
        {renderOwnerBadge(file.path)}
        {showDirectory ? <span className="ml-auto truncate pl-1 text-[0.85em] text-neutral-600">{dirName(file.path)}</span> : null}
      </button>
    </li>
  );

  const renderFolder = (folder: FolderNode, depth: number) => {
    const isCollapsed = collapsed.has(folder.path);
    return (
      <li key={`dir:${folder.path}`} className="flex items-center gap-1.5 pr-2 hover:bg-(--row-hover)" style={{ paddingLeft: `calc(8px + ${depth} * var(--changelist-indent))` }}>
        <Checkbox state={stateOf(folder.files)} onChange={() => toggleGroup(folder.files)} />
        <button type="button" onClick={() => toggleCollapsed(folder.path)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left" title={folder.path}>
          <ChevronIcon expanded={!isCollapsed} />
          <img src={folderIconUrl(baseName(folder.name), !isCollapsed)} alt="" className="size-4 shrink-0" />
          <span className="truncate text-neutral-300">{folder.name}</span>
          <span className="pl-1 text-[0.85em] text-neutral-600">{folder.files.length}</span>
        </button>
      </li>
    );
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-(--changelist-bg)">
      <div className="flex items-center gap-1 border-b border-(--line) px-2 py-2.5 text-[13px] text-neutral-400">
        <button type="button" onClick={() => setTab("changes")} className={`${TAB_BUTTON_SM} ${tab === "changes" ? TAB_ACTIVE : TAB_INACTIVE}`}>
          Changes
        </button>
        <button type="button" onClick={() => setTab("shelf")} className={`${TAB_BUTTON_SM} ${tab === "shelf" ? TAB_ACTIVE : TAB_INACTIVE}`}>
          Shelf
        </button>
        <span className="flex-1" />
        {tab === "changes" ? (
          <button
            type="button"
            onClick={() => setView(view === "flat" ? "tree" : "flat")}
            className={`${ICON_BUTTON_SM} -my-0.5`}
            title={view === "flat" ? "Group by folder" : "Show as flat list"}
          >
            {view === "flat" ? <TreeIcon /> : <ListIcon />}
          </button>
        ) : null}
        <button type="button" onClick={() => void commands.openWorktreeInWebstorm(sessionId)} className={SECONDARY_BUTTON_SM} title="Open worktree in WebStorm">
          WebStorm
        </button>
      </div>

      {tab === "shelf" ? (
        <ShelfList sessionId={sessionId} version={shelfVersion} onChanged={worktreeChanged} />
      ) : (
        <>
          <div className="flex items-center gap-2 px-2 py-2 text-[13px] text-neutral-400">
            <Checkbox state={files.length ? stateOf(files) : "unchecked"} onChange={() => toggleGroup(files)} title="Select all" />
            <span>
              {files.length} changed{checkedPaths.length !== files.length ? ` · ${checkedPaths.length} selected` : ""}
            </span>
            {scope ? (
              <button
                type="button"
                onClick={() => scope.onChange(scope.value === "own" ? "all" : "own")}
                className={`${SECONDARY_BUTTON_SM} ml-auto`}
                title={
                  scope.value === "own"
                    ? "Show every uncommitted change in the shared worktree"
                    : scope.includesParent
                      ? "Show only the changes made by this session and its parent"
                      : "Show only the changes made by this session"
                }
              >
                {scope.value === "own" ? `Show all${scope.hiddenCount ? ` (+${scope.hiddenCount})` : ""}` : scope.includesParent ? "This and parent" : "Only this session"}
              </button>
            ) : null}
          </div>
          <ul className="min-h-0 flex-1 overflow-y-auto font-(family-name:--changelist-font-family) text-(length:--changelist-font-size) leading-(--changelist-line-height)">
            {view === "flat"
              ? files.map((file) => renderFile(file, baseName(file.path), 0, true))
              : rows.map(({ node, depth }) => (node.kind === "folder" ? renderFolder(node, depth) : renderFile(node.file, node.name, depth, false)))}
          </ul>
          <div className="flex items-center gap-2 border-t border-(--line) px-3 py-2.5 text-[13px]">
            <button
              type="button"
              disabled={!pullRequest}
              onClick={openReviewDialog}
              className={PRIMARY_BUTTON_SM}
              title={pullRequest ? `Submit a review of pull request #${pullRequest.number}` : "Only a session started from a pull request can submit a review"}
            >
              {draftCount ? `Submit review (${draftCount})…` : "Submit review…"}
            </button>
            {pullRequest ? null : (
              <button type="button" disabled={!checkedPaths.length} onClick={() => void openShelveDialog()} className={SECONDARY_BUTTON_SM} title="Move the checked files to the shelf">
                Shelve…
              </button>
            )}
            <span className="ml-auto text-neutral-500">{notice ?? (checkedPaths.length ? `${checkedPaths.length} selected` : "")}</span>
          </div>
        </>
      )}

      {dialog?.kind === "review" && pullRequest ? (
        <ReviewDialog sessionId={sessionId} pullRequestNumber={pullRequest.number} draftCount={draftCount} onClose={() => setDialog(null)} onSubmitted={() => setNotice("Review submitted")} />
      ) : null}
      {dialog?.kind === "shelve" ? <ShelveDialog sessionId={sessionId} paths={dialog.paths} onClose={() => setDialog(null)} onShelved={worktreeChanged} /> : null}
    </div>
  );
}

/** Disclosure arrow of a folder row: points right when collapsed and down when expanded. */
function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={`size-4 shrink-0 text-neutral-500 transition-transform ${expanded ? "rotate-90" : ""}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  );
}

function ListIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <path d="M3 4h10M3 8h10M3 12h10" />
    </svg>
  );
}

function TreeIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <path d="M3 3h5M5 8h8M5 13h8M5 3v10" />
    </svg>
  );
}
