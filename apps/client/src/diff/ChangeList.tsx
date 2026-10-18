import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { commands } from "../ipc/commands";
import type { ChangedFile, ChangedFileView, GraphNode } from "../ipc/types";
import { useSettingsStore } from "../state/settings";
import { useHuntStore } from "../state/store";
import { selectionChatsFor, useBusyChatIds } from "../ide/selectionChats";
import { otherTouchers, type ChangeScope } from "./attribution";
import { buildChangeTree, type FolderNode, type TreeNode } from "./changeTree";
import { Checkbox, type CheckState } from "./Checkbox";
import { CommitBox } from "./CommitBox";
import { useFileIconUrl, useFolderIconUrl } from "./fileIcons";
import { useReviewDraftCount } from "../review/reviewComments";
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

type Tab = "changes" | "shelf";

type Dialog = { kind: "shelve"; paths: string[] } | { kind: "review" } | null;

/** One visible row of the tree view; `depth` is the indentation level. */
type Row = { node: TreeNode; depth: number };

/** Checked and collapsed paths of every session's changelist, kept across session switches for the window's lifetime. */
const checkedBySession = new Map<string, Set<string>>();
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
 */
export function ChangeList({
  sessionId,
  files,
  hiddenByGlobsCount,
  reviewRatings,
  scope,
  selectedPath,
  hasUnsavedChanges,
  onSelect,
  onContextMenu,
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
  /** The diff editor holds unsaved edits; shelving would use the content on disk. */
  hasUnsavedChanges: boolean;
  onSelect: (path: string) => void;
  onContextMenu: (event: MouseEvent, file: ChangedFile) => void;
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
  /** The worktree and Git history of a remote session and its sub chats live on its VM, which commits and pushes for them. */
  const isRemote = Boolean(session && remoteOf(session, sessions));
  const isLocked = useHuntStore((state) => isWorktreeLocked(state.sessions, state.remoteLinks, sessionId));
  const draftCount = useReviewDraftCount(sessionId);
  const [tab, setTab] = useState<Tab>("changes");
  /** Files start unchecked; the checked paths of a session survive a switch to another session and back. */
  const [checked, setCheckedState] = useState<Set<string>>(() => checkedBySession.get(sessionId) ?? new Set());
  const [collapsed, setCollapsedState] = useState<Set<string>>(() => collapsedBySession.get(sessionId) ?? new Set());
  const [dialog, setDialog] = useState<Dialog>(null);
  /** Shown in the footer once a review went out, until the next dialog opens. */
  const [notice, setNotice] = useState<string | null>(null);
  /** Bumped after shelf operations so the shelf list reloads even when the file list is unchanged. */
  const [shelfVersion, setShelfVersion] = useState(0);

  useEffect(() => {
    setCheckedState(checkedBySession.get(sessionId) ?? new Set());
    setCollapsedState(collapsedBySession.get(sessionId) ?? new Set());
  }, [sessionId]);

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
    const owners = otherTouchers(file, sessionId, parentId).map((id) => {
      const owner = sessions.find((candidate) => candidate.id === id);
      if (!owner) return { id, mark: "?", title: "a deleted session" };
      const isOtherFamily = !!owner.parentId && owner.parentId !== sessionId && owner.parentId !== parentId;
      const parentMark = isOtherFamily && owner.parentId ? (marks.get(owner.parentId) ?? "") : "";
      return { id, mark: `${parentMark}${marks.get(id) ?? "?"}`, title: owner.title };
    });
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
    checkedBySession.set(sessionId, next);
    setCheckedState(next);
  };

  const toggleGroup = (targets: ChangedFile[]) => setChecked(targets, stateOf(targets) !== "checked");

  /** Unchecks the files a commit or shelve took out of the list, so a later change of the same file starts unchecked. */
  const uncheckPaths = (paths: string[]) => {
    const next = new Set(checked);
    for (const path of paths) {
      next.delete(path);
    }
    checkedBySession.set(sessionId, next);
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

  /** Warns when the diff editor holds unsaved edits; resolves to whether a commit or shelve of the checked files may go on. */
  const confirmSavedContent = async () => {
    if (!checkedPaths.length) return false;
    if (hasUnsavedChanges && !(await confirmDestructive("The diff editor has unsaved changes. Only the content saved on disk is used. Continue?", "Continue"))) return false;
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
        className={`group flex items-center gap-1.5 pr-1 hover:bg-(--row-hover) ${selectedPath === file.path ? "bg-(--row-active)" : ""}`}
        style={{ paddingLeft: `calc(12px + ${depth} * var(--changelist-indent))` }}
      >
        <Checkbox state={checked.has(file.path) ? "checked" : "unchecked"} onChange={() => setChecked([file], !checked.has(file.path))} />
        <button
          type="button"
          onClick={() => onSelect(file.path)}
          onContextMenu={(event) => onContextMenu(event, file)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          title={`${file.path} (${file.status})`}
        >
          <img src={fileIconUrl(file.path)} alt="" className="size-[17px] shrink-0" />
          <span className={`truncate ${STATUS_NAME_CLASS[file.status] ?? "text-neutral-200"}`}>{name}</span>
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
    return (
      <li key={`dir:${folder.path}`} className="flex items-center gap-1.5 pr-2 hover:bg-(--row-hover)" style={{ paddingLeft: `calc(12px + ${depth} * var(--changelist-indent))` }}>
        <Checkbox state={stateOf(folder.files)} onChange={() => toggleGroup(folder.files)} />
        <button type="button" onClick={() => toggleCollapsed(folder.path)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left" title={folder.path}>
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
          <ul className="min-h-0 flex-1 overflow-y-auto font-(family-name:--changelist-font-family) text-(length:--changelist-font-size) leading-(--changelist-line-height)">
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
              notice={notice}
              onCommit={confirmSavedContent}
              onCommitted={(paths) => {
                setNotice("Committed");
                uncheckPaths(paths);
                worktreeChanged();
              }}
              onPushed={() => setNotice("Pushed")}
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
