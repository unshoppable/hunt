import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { commands } from "../ipc/commands";
import type { ChangedFile, ChangedFileView, GraphNode } from "../ipc/types";
import { useSettingsStore } from "../state/settings";
import { useHuntStore } from "../state/store";
import { selectionChatsFor, useBusyChatIds } from "../ide/selectionChats";
import { otherTouchers, ownerLabel, type ChangeScope } from "./attribution";
import { buildChangeTree, type FolderNode, type TreeNode } from "./changeTree";
import { Checkbox, type CheckState } from "./Checkbox";
import { CommitBox } from "./CommitBox";
import { useFileIconUrl, useFolderIconUrl } from "./fileIcons";
import { useReviewDraftCount } from "../review/reviewComments";
import { useLoad } from "../ui/useLoad";
import { ReviewDialog } from "./ReviewDialog";
import { ReviewBars } from "../graph/ReviewBars";
import { ShelfList } from "./ShelfList";
import { sessionMarks } from "../sessions/sessionLabels";
import { SessionMark } from "../sessions/SessionMark";
import { ShelveDialog } from "./ShelveDialog";
import { baseName, dirName } from "../ui/path";
import { STATUS_NAME_CLASS } from "./styles";
import { AgentButton } from "../ui/AgentButton";
import { isWorktreeLocked, remoteOf } from "../chat/remoteSession";
import { ICON_BUTTON_SM, PRIMARY_BUTTON_XS, SECONDARY_BUTTON_XS, TAB_ACTIVE, TAB_BUTTON_SM, TAB_INACTIVE } from "../ui/buttons";
import { confirmDestructive } from "../ui/confirm";
import { GlobFilterInput } from "../ui/GlobFilterInput";
import { SwapIcon } from "../ui/icons";
import { UnsavedDot } from "../ui/UnsavedDot";
import { isShortcut } from "../ui/shortcuts";
import type { TreeNavRow } from "../ui/treeNavigation";
import { useTreeNavigation } from "../ui/useTreeNavigation";

type Tab = "changes" | "shelf";

type Dialog = { kind: "shelve"; paths: string[] } | { kind: "review" } | null;

/** The file or folder row a context menu or a copy-path shortcut acts on; `files` are the changes it holds. */
export type ChangeListTarget = { path: string; files: ChangedFile[]; isFolder: boolean };

/** One visible row of the tree view; `depth` is the indentation level. */
type Row = { node: TreeNode; depth: number };

/**
 * Checked and collapsed paths of every changelist, kept across session switches for the window's lifetime. A session and
 * its sub sessions share one checked set, keyed by the parent's ID, so a selection made in one of them shows in all.
 */
const checkedByFamily = new Map<string, Set<string>>();
const collapsedBySession = new Map<string, Set<string>>();

/**
 * Scope toggle of a shared worktree; `hiddenCount` is how many files the current scope leaves out and
 * `includesParent` is set for a sub session, whose own scope also holds the changes of its parent.
 */
export type ScopeControl = { value: ChangeScope; hiddenCount: number; includesParent: boolean; onChange: (scope: ChangeScope) => void };

/**
 * The changelist: changed files as a flat list or folder tree with checkboxes, plus the shelf tab and either the commit
 * and shelve actions for the checked files or, in a pull request review, the submission of the review. The glob field in
 * the header hides files from the list (the owner applies it to `files`, `hiddenByGlobsCount` says how many it left out);
 * a file the agent rated in the dependency graph (`reviewRatings`) shows its review relevance behind its name. Every
 * file row has an agent button that opens a sub chat about the whole file; it shows on hover, or always once such a chat exists.
 * A right click on a file or folder row opens the owner's context menu; ⌃⇧C in the focused list copies the path of the row
 * under the cursor.
 */
export function ChangeList({
  sessionId,
  files,
  hiddenByGlobsCount,
  reviewRatings,
  scope,
  selectedPath,
  unsavedPaths,
  onSelect,
  onContextMenu,
  onCopyPath,
  onAskAgent,
  onWorktreeChanged,
}: {
  sessionId: string;
  files: ChangedFileView[];
  /** Files in scope that the hidden globs leave out of `files`. */
  hiddenByGlobsCount: number;
  /** The agent's review rating per path, from the dependency graph. */
  reviewRatings: Map<string, GraphNode>;
  /** Set when other sessions share the worktree; `null` hides the toggle. */
  scope: ScopeControl | null;
  selectedPath: string | null;
  /** Files with unsaved edits; they get a blue dot, and committing or shelving them uses the content on disk. */
  unsavedPaths: readonly string[];
  onSelect: (path: string) => void;
  onContextMenu: (event: MouseEvent, target: ChangeListTarget) => void;
  /** Copies the absolute path of the worktree-relative `path`. */
  onCopyPath: (path: string) => void;
  /** Opens the sub chat about the whole file next to its agent button; without it there is none. */
  onAskAgent?: (file: ChangedFile, button: HTMLElement) => void;
  /** Called after a shelve or unshelve so the owner reloads the worktree state. */
  onWorktreeChanged: () => void;
}) {
  const fileIconUrl = useFileIconUrl();
  const folderIconUrl = useFolderIconUrl();
  const view = useSettingsStore((state) => state.changelistView);
  const setView = useSettingsStore((state) => state.setChangelistView);
  const hiddenGlobs = useSettingsStore((state) => state.changelistHiddenGlobs);
  const setHiddenGlobs = useSettingsStore((state) => state.setChangelistHiddenGlobs);
  const sessions = useHuntStore((state) => state.sessions);
  const session = sessions.find((candidate) => candidate.id === sessionId);
  const parentId = session?.parentId ?? null;
  const pullRequest = session?.pullRequest ?? null;
  /** The worktree and Git history of a remote session and its sub chats live on its VM, which commits for them. */
  const remote = session ? remoteOf(session, sessions) : null;
  const isRemote = Boolean(remote);
  /** A poller session's branch is pushed from its VM with the poller's token; every other session's from this Mac. */
  const pushesFromVm = remote?.origin === "swf";
  /** The branch on `origin` a push lands on: the one the session's branch tracks. */
  const target = session?.pushTarget ?? "";
  const isLocked = useHuntStore((state) => isWorktreeLocked(state.sessions, state.remoteLinks, sessionId));
  const draftCount = useReviewDraftCount(sessionId);
  const [tab, setTab] = useState<Tab>("changes");
  /** Files start unchecked; the checked paths survive a switch to another session and back and are shared with the parent and its sub sessions. */
  const checkedKey = parentId ?? sessionId;
  const [checked, setCheckedState] = useState<Set<string>>(() => checkedByFamily.get(checkedKey) ?? new Set());
  const [collapsed, setCollapsedState] = useState<Set<string>>(() => collapsedBySession.get(sessionId) ?? new Set());
  const [dialog, setDialog] = useState<Dialog>(null);
  /** Shown in the footer once a review went out, until the next dialog opens. */
  const [notice, setNotice] = useState<string | null>(null);
  /** Bumped after shelf and push operations so the shelf list and the push state reload even when the file list is unchanged. */
  const [shelfVersion, setShelfVersion] = useState(0);
  /** Commits a push would publish, reloaded with the file list; `null` until known or when the count failed. */
  const [unpushedCount, setUnpushedCount] = useState<number | null>(null);

  useLoad(
    () => commands.unpushedCommitCount(sessionId),
    { onValue: setUnpushedCount, onError: () => setUnpushedCount(null) },
    [sessionId, files, shelfVersion],
  );

  useEffect(() => {
    setCheckedState(checkedByFamily.get(checkedKey) ?? new Set());
    setCollapsedState(collapsedBySession.get(sessionId) ?? new Set());
  }, [sessionId, checkedKey]);

  const tree = useMemo(() => buildChangeTree(files), [files]);
  const filesByPath = useMemo(() => new Map(files.map((file) => [file.path, file])), [files]);
  const busyChatIds = useBusyChatIds();
  const marks = useMemo(() => sessionMarks(sessions), [sessions]);
  /**
   * Paths with a whole-file sub chat (a selection with a task), whose agent button stays visible, mapped to whether
   * that chat's agent is running a turn, which makes the button pulse.
   */
  const fileChats = useMemo(() => {
    const result = new Map<string, boolean>();
    for (const file of files) {
      const chats = selectionChatsFor(sessions, sessionId, file.path).filter((chat) => !!chat.selection.task);
      if (!chats.length) continue;
      result.set(file.path, chats.some((chat) => busyChatIds.has(chat.sessionId)));
    }
    return result;
  }, [files, sessions, sessionId, busyChatIds]);

  /**
   * Marks of the other sessions of the worktree that changed a file: `null` when only this session or its parent did.
   * A sub session of another family carries its parent's letter, e.g. `B2`; a deleted session shows `?`.
   */
  const renderOwnerBadge = (path: string) => {
    const file = filesByPath.get(path);
    if (!file) return null;
    const owners = otherTouchers(file, sessionId, parentId).map((id) => ({ id, ...ownerLabel(id, sessions, marks, sessionId, parentId) }));
    if (!owners.length) return null;
    const isShared = file.touchedBy.includes(sessionId) || (!!parentId && file.touchedBy.includes(parentId));
    const titles = owners.map((owner) => `${owner.mark} ${owner.title}`).join(", ");
    return (
      <span
        className="flex shrink-0 items-center gap-0.5"
        title={isShared ? `Also changed by: ${titles}. The diff shows those changes as well.` : `Changed by: ${titles}`}
      >
        {owners.map((owner) => (
          <SessionMark key={owner.id} sessionId={owner.id} mark={owner.mark} />
        ))}
      </span>
    );
  };
  const checkedPaths = useMemo(() => files.filter((file) => checked.has(file.path)).map((file) => file.path), [files, checked]);

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
    const checkedCount = paths.filter((file) => checked.has(file.path)).length;
    if (checkedCount === 0) return "unchecked";
    return checkedCount === paths.length ? "checked" : "mixed";
  };

  const setChecked = (targets: ChangedFile[], isChecked: boolean) => {
    const next = new Set(checked);
    for (const file of targets) {
      if (isChecked) {
        next.add(file.path);
      } else {
        next.delete(file.path);
      }
    }
    checkedByFamily.set(checkedKey, next);
    setCheckedState(next);
  };

  const toggleGroup = (targets: ChangedFile[]) => setChecked(targets, stateOf(targets) !== "checked");

  // ⌘Space (keymap default) toggles the checkbox of the selected file; bubble phase, so a focused editor or dialog keeps its own binding.
  useEffect(() => {
    if (tab !== "changes" || dialog) return;
    const selected = selectedPath ? filesByPath.get(selectedPath) : undefined;
    if (!selected) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isShortcut(event, "changes.toggleChecked")) return;
      event.preventDefault();
      setChecked([selected], !checked.has(selected.path));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  /** Unchecks the files a commit or shelve took out of the list, so a later change of the same file starts unchecked. */
  const uncheckPaths = (paths: string[]) => {
    const next = new Set(checked);
    for (const path of paths) {
      next.delete(path);
    }
    checkedByFamily.set(checkedKey, next);
    setCheckedState(next);
  };

  const toggleCollapsed = (path: string) => {
    const next = new Set(collapsed);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
    }
    collapsedBySession.set(sessionId, next);
    setCollapsedState(next);
  };

  /** The rows as keyboard navigation sees them; a folder's key is its path with a trailing slash, a file's its path. */
  const navRows = useMemo<TreeNavRow[]>(
    () =>
      view === "flat"
        ? files.map((file) => ({ key: file.path, depth: 0 }))
        : rows.map(({ node, depth }) => (node.kind === "folder" ? { key: `${node.path}/`, depth, isExpanded: !collapsed.has(node.path) } : { key: node.file.path, depth })),
    [view, files, rows, collapsed],
  );

  // Arrow keys move through the rows and open a file's diff; Space toggles the checkbox of the row (a focused checkbox toggles itself).
  const nav = useTreeNavigation({
    rows: navRows,
    selectedKey: selectedPath,
    onSelect,
    isSelectable: (key) => !key.endsWith("/"),
    onToggle: (key) => toggleCollapsed(key.slice(0, -1)),
    onCheck: (key) => {
      const file = filesByPath.get(key);
      if (file) {
        setChecked([file], !checked.has(file.path));
        return;
      }
      const folder = rows.find(({ node }) => node.kind === "folder" && `${node.path}/` === key)?.node;
      if (folder?.kind === "folder") {
        toggleGroup(folder.files);
      }
    },
  });

  /** Warns when checked files hold unsaved edits; resolves to whether a commit or shelve of the checked files may go on. */
  const confirmSavedContent = async () => {
    if (!checkedPaths.length) return false;
    const unsavedNames = checkedPaths.filter((path) => unsavedPaths.includes(path)).map((path) => `"${baseName(path)}"`);
    if (
      unsavedNames.length &&
      !(await confirmDestructive(`${unsavedNames.join(", ")} ${unsavedNames.length === 1 ? "has" : "have"} unsaved changes. Only the content saved on disk is used. Continue?`, "Continue"))
    ) {
      return false;
    }
    setNotice(null);
    return true;
  };

  /** Opens the shelve dialog for the checked files. */
  const openShelveDialog = async () => {
    if (!(await confirmSavedContent())) return;
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

  const renderFile = (file: ChangedFile, name: string, depth: number, showDirectory: boolean) => {
    const rating = reviewRatings.get(file.path);
    return (
      <li
        key={file.path}
        data-tree-key={file.path}
        data-selected={nav.cursor === file.path}
        className="tree-row group flex items-center gap-1.5 pr-2.5"
        style={{ paddingLeft: `calc(12px + ${depth} * var(--changelist-indent))` }}
      >
        <Checkbox state={checked.has(file.path) ? "checked" : "unchecked"} onChange={() => setChecked([file], !checked.has(file.path))} />
        <button
          type="button"
          onClick={() => nav.select(file.path)}
          onContextMenu={(event) => onContextMenu(event, { path: file.path, files: [file], isFolder: false })}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          title={`${file.path} (${file.status})`}
        >
          <img src={fileIconUrl(file.path)} alt="" className="size-[17px] shrink-0" />
          <span className={`truncate ${STATUS_NAME_CLASS[file.status] ?? "text-neutral-200"}`}>{name}</span>
          {unsavedPaths.includes(file.path) ? <UnsavedDot /> : null}
          {renderOwnerBadge(file.path)}
          {showDirectory ? <span className="ml-auto truncate pl-1 text-[0.85em] text-neutral-600">{dirName(file.path)}</span> : null}
          {rating?.review ? <ReviewBars level={rating.review} reason={rating.reviewReason} className={`size-3.5 ${showDirectory ? "" : "ml-auto"}`} /> : null}
        </button>
        {onAskAgent ? (
          <AgentButton
            onClick={(event) => onAskAgent(file, event.currentTarget)}
            isBusy={fileChats.get(file.path) ?? false}
            size={24}
            sparkleSize={20}
            className={`-my-1 transition-opacity focus-visible:opacity-100 ${fileChats.has(file.path) ? "" : "opacity-0 group-hover:opacity-100"}`}
            title={fileChats.has(file.path) ? "Show the agent's chat about this file" : "Ask the agent about this file"}
            aria-label={fileChats.has(file.path) ? "Show the agent's chat about this file" : "Ask the agent about this file"}
          />
        ) : null}
      </li>
    );
  };

  const renderFolder = (folder: FolderNode, depth: number) => {
    const isCollapsed = collapsed.has(folder.path);
    const key = `${folder.path}/`;
    return (
      <li
        key={`dir:${folder.path}`}
        data-tree-key={key}
        data-selected={nav.cursor === key}
        className="tree-row flex items-center gap-1.5 pr-2.5"
        style={{ paddingLeft: `calc(12px + ${depth} * var(--changelist-indent))` }}
      >
        <Checkbox state={stateOf(folder.files)} onChange={() => toggleGroup(folder.files)} />
        <button
          type="button"
          onClick={() => {
            toggleCollapsed(folder.path);
            nav.select(key);
          }}
          onContextMenu={(event) => onContextMenu(event, { path: folder.path, files: folder.files, isFolder: true })}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          title={folder.path}
        >
          <ChevronIcon expanded={!isCollapsed} />
          <img src={folderIconUrl(folder.path, !isCollapsed)} alt="" className="size-[17px] shrink-0" />
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
        {tab === "changes" ? (
          <GlobFilterInput value={hiddenGlobs} onApply={setHiddenGlobs} placeholder="Hide files, e.g. *.spec.ts" className="mx-1 min-w-0 flex-1" />
        ) : (
          <span className="flex-1" />
        )}
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
        {isRemote ? null : (
          <button
            type="button"
            onClick={() => void commands.openWorktreeInWebstorm(sessionId)}
            className={SECONDARY_BUTTON_XS}
            title="Open worktree in WebStorm"
          >
            WebStorm
          </button>
        )}
      </div>

      {tab === "shelf" ? (
        <ShelfList sessionId={sessionId} version={shelfVersion} onChanged={worktreeChanged} />
      ) : (
        <>
          <div className="flex items-center gap-2 px-3 py-2 text-[13px] text-neutral-400">
            <Checkbox state={files.length ? stateOf(files) : "unchecked"} onChange={() => toggleGroup(files)} title="Select all" />
            <span>
              {files.length} changed{checkedPaths.length ? ` · ${checkedPaths.length} selected` : ""}
              {hiddenByGlobsCount ? ` · ${hiddenByGlobsCount} hidden` : ""}
            </span>
            {scope ? (
              <button
                type="button"
                onClick={() => scope.onChange(scope.value === "own" ? "all" : "own")}
                className={`${SECONDARY_BUTTON_XS} ml-auto`}
                title={
                  scope.value === "own"
                    ? "Show every uncommitted change in the shared worktree"
                    : scope.includesParent
                      ? "Show only the changes made by this session and its parent"
                      : "Show only the changes made by this session"
                }
              >
                <SwapIcon />
                {scope.value === "own" ? `Show all${scope.hiddenCount ? ` (+${scope.hiddenCount})` : ""}` : "Show own"}
              </button>
            ) : null}
          </div>
          <ul
            {...nav.listProps}
            onKeyDown={(event) => {
              if (!nav.cursor || !isShortcut(event, "changes.copyPath")) {
                nav.listProps.onKeyDown(event);
                return;
              }
              event.preventDefault();
              onCopyPath(nav.cursor.endsWith("/") ? nav.cursor.slice(0, -1) : nav.cursor);
            }}
            className="min-h-0 flex-1 overflow-y-auto outline-none font-(family-name:--changelist-font-family) text-(length:--changelist-font-size) leading-(--changelist-line-height)"
          >
            {view === "flat"
              ? files.map((file) => renderFile(file, baseName(file.path), 0, true))
              : rows.map(({ node, depth }) => (node.kind === "folder" ? renderFolder(node, depth) : renderFile(node.file, node.name, depth, false)))}
          </ul>
          {pullRequest ? (
            <div className="flex items-center gap-2 border-t border-(--line) px-3 py-2.5 text-[13px]">
              <button type="button" onClick={openReviewDialog} className={PRIMARY_BUTTON_XS} title={`Submit a review of pull request #${pullRequest.number}`}>
                {draftCount ? `Submit review (${draftCount})…` : "Submit review…"}
              </button>
              <span className="ml-auto text-neutral-500">{notice ?? (checkedPaths.length ? `${checkedPaths.length} selected` : "")}</span>
            </div>
          ) : (
            <CommitBox
              sessionId={sessionId}
              paths={checkedPaths}
              isLocked={isLocked}
              isRemote={isRemote}
              pushesFromVm={pushesFromVm}
              branch={session?.branch ?? ""}
              target={target}
              unpushedCount={unpushedCount}
              notice={notice}
              onCommit={confirmSavedContent}
              onCommitted={(paths) => {
                setNotice("Committed");
                uncheckPaths(paths);
                worktreeChanged();
              }}
              onPushed={() => {
                setNotice(`Pushed to ${target}`);
                setShelfVersion((version) => version + 1);
              }}
              onShelve={() => void openShelveDialog()}
            />
          )}
        </>
      )}

      {dialog?.kind === "review" && pullRequest ? (
        <ReviewDialog sessionId={sessionId} pullRequestNumber={pullRequest.number} draftCount={draftCount} onClose={() => setDialog(null)} onSubmitted={() => setNotice("Review submitted")} />
      ) : null}
      {dialog?.kind === "shelve" ? (
        <ShelveDialog
          sessionId={sessionId}
          paths={dialog.paths}
          onClose={() => setDialog(null)}
          onShelved={() => {
            uncheckPaths(dialog.paths);
            worktreeChanged();
          }}
        />
      ) : null}
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
