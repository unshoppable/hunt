import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { commands } from "../ipc/commands";
import type { Commit, CommitDetails, CommitFile, FileDiff, GitRef, RefList } from "../ipc/types";
import { useHuntStore } from "../state/store";
import { remoteOf } from "../chat/remoteSession";
import { useSettingsStore } from "../state/settings";
import { PaneSeparator, Panel, PersistentGroup } from "../layout/ResizablePanes";
import { CodeDiffEditor } from "../diff/CodeDiffEditor";
import { openInEditorWindow } from "../ide/editorWindows";
import { SECONDARY_BUTTON_XS } from "../ui/buttons";
import { confirmDestructive } from "../ui/confirm";
import { errorText, useLoad } from "../ui/useLoad";
import { BUSY_LABELS, branchActions, localBranchesWithoutOrigin, originBranchName, type BranchAction } from "./branchActions";
import { PushTargetDialog, RenameBranchDialog } from "./BranchDialogs";
import { CommitFiles } from "./CommitFiles";
import { CommitLog } from "./CommitLog";
import { GitMenu, type GitMenuEntry } from "./GitMenu";
import { RefTree } from "./RefTree";
import { ResetDialog } from "./ResetDialog";

/** Commits one page of the log loads; scrolling near the end loads the next. */
const PAGE_SIZE = 500;

/** Filter of the log: the branch or tag whose history shows (every ref when empty) and the text or hash to look for. */
export type LogFilter = { reference: string; text: string };

/** The context menu of a commit in the log. */
const COMMIT_MENU: GitMenuEntry<"reset">[] = [{ kind: "reset", label: "Reset Current Branch to Here…", disabledReason: null, isDanger: false, startsGroup: false }];

/**
 * The Git tab: the branch tree, the commit log of the session's worktree with its graph, and the selected commit's
 * files, details and the diff of the selected file. The log starts on the session's own branch, so its commits show
 * on top of the branch they will be pushed to, and reloads after every turn of the agent and every local write
 * (`editVersion`), since both may commit. A new filter selects its newest commit, so a click on a branch shows its head
 * and that commit's files; a right click on a commit offers to reset the checked-out branch to it.
 */
export function GitPanel({ sessionId }: { sessionId: string }) {
  const editVersion = useHuntStore((state) => state.chats[sessionId]?.editVersion ?? 0);
  const noteWorktreeChanged = useHuntStore((state) => state.noteWorktreeChanged);
  const sessions = useHuntStore((state) => state.sessions);
  const session = sessions.find((candidate) => candidate.id === sessionId) ?? null;
  const remote = session ? remoteOf(session, sessions) : null;
  /** The session's own branch and the branch on `origin` a push of it lands on; `null` without a session or local worktree. */
  const pushes = useMemo(() => (session?.pushTarget ? { branch: session.branch, target: session.pushTarget } : null), [session]);
  const [menu, setMenu] = useState<{ ref: GitRef; x: number; y: number } | null>(null);
  const [commitMenu, setCommitMenu] = useState<{ commit: Commit; x: number; y: number } | null>(null);
  /** The commit the reset dialog resets the checked-out branch to; `null` while the dialog is closed. */
  const [resetTarget, setResetTarget] = useState<Commit | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [isRetargeting, setIsRetargeting] = useState(false);
  /** What the running branch action is, shown in the branch tree's header; `null` while none runs. */
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const diffFontSize = useSettingsStore((state) => state.panes.diff.fontSize);
  const diffLineHeight = useSettingsStore((state) => state.panes.diff.lineHeight);
  const diffFontFamily = useSettingsStore((state) => state.panes.diff.fontFamily);
  const [refs, setRefs] = useState<RefList | null>(null);
  const [filter, setFilter] = useState<LogFilter>(() => ({ reference: session?.branch ?? "", text: "" }));
  const [commits, setCommits] = useState<Commit[]>([]);
  /** Whether the last page was full, so there may be more commits to load. */
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [details, setDetails] = useState<CommitDetails | null>(null);
  const [selectedFile, setSelectedFile] = useState<CommitFile | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** What the loaded commits belong to; a page that arrives for another key is dropped. */
  const logKey = `${sessionId}\n${filter.reference}\n${filter.text}\n${editVersion}`;
  const logKeyRef = useRef(logKey);
  logKeyRef.current = logKey;
  /** The filter whose commits the log shows; the first page of another one selects its newest commit. */
  const shownFilterRef = useRef<string | null>(null);

  useLoad(
    () => commands.gitRefs(sessionId),
    { onValue: setRefs, onError: (reason) => setError(errorText(reason)) },
    [sessionId, editVersion],
  );

  // The first page loads for every filter and after every change of the history; later pages append below.
  useLoad(
    () => {
      setIsLoading(true);
      return commands.gitLog(sessionId, { ...filter, skip: 0, limit: PAGE_SIZE });
    },
    {
      onValue: (page) => {
        setIsLoading(false);
        setCommits(page);
        setHasMore(page.length === PAGE_SIZE);
        setError(null);
        const filterKey = `${filter.reference}\n${filter.text}`;
        if (shownFilterRef.current !== filterKey) {
          shownFilterRef.current = filterKey;
          setSelectedId(page[0]?.id ?? null);
        }
      },
      onError: (reason) => {
        setIsLoading(false);
        setError(errorText(reason));
      },
    },
    [logKey],
  );

  const loadMore = useCallback(() => {
    if (!hasMore || isLoading || isLoadingMore) return;
    const key = logKeyRef.current;
    setIsLoadingMore(true);
    commands
      .gitLog(sessionId, { ...filter, skip: commits.length, limit: PAGE_SIZE })
      .then((page) => {
        if (logKeyRef.current !== key) return;
        setCommits((current) => [...current, ...page]);
        setHasMore(page.length === PAGE_SIZE);
      })
      .catch((reason) => setError(errorText(reason)))
      .finally(() => setIsLoadingMore(false));
  }, [hasMore, isLoading, isLoadingMore, sessionId, filter, commits.length]);

  // The selection follows the list: a commit that left it gives way to the first one.
  useEffect(() => {
    setSelectedId((current) => (current && commits.some((commit) => commit.id === current) ? current : (commits[0]?.id ?? null)));
  }, [commits]);

  useEffect(() => {
    setSelectedFile(null);
    setDiff(null);
    if (!selectedId) {
      setDetails(null);
    }
  }, [selectedId]);

  useLoad(
    () => commands.gitCommit(sessionId, selectedId ?? ""),
    { onValue: setDetails, onError: (reason) => setError(errorText(reason)) },
    [sessionId, selectedId, editVersion],
    { isEnabled: !!selectedId },
  );

  useLoad(
    () => commands.gitCommitFileDiff(sessionId, selectedId ?? "", selectedFile?.path ?? "", selectedFile?.oldPath ?? null),
    { onValue: setDiff, onError: (reason) => setError(errorText(reason)) },
    [sessionId, selectedId, selectedFile],
    { isEnabled: !!selectedId && !!selectedFile },
  );

  const selectedCommit = useMemo(() => commits.find((commit) => commit.id === selectedId) ?? null, [commits, selectedId]);
  const unpushed = useMemo(() => new Set(refs?.unpushed ?? []), [refs]);
  const localBranches = useMemo(() => new Set((refs?.refs ?? []).filter((ref) => ref.kind === "local").map((ref) => ref.name)), [refs]);
  const menuActions = useMemo(() => (menu ? branchActions(menu.ref, { head: refs?.head ?? "HEAD", pushes, isRemoteSession: !!remote, isPollerSession: remote?.origin === "swf" }) : []), [menu, refs, pushes, remote]);
  /** Local branches origin lacks that no session of the repository has checked out, which the branch tree's button deletes. */
  const prunable = useMemo(() => {
    if (!refs || !session) return [];
    const kept = new Set([refs.head, ...sessions.filter((candidate) => candidate.repoPath === session.repoPath).map((candidate) => candidate.branch)]);
    return localBranchesWithoutOrigin(refs.refs, kept);
  }, [refs, session, sessions]);
  /** The branches of origin a push could land on, without the `origin/` prefix. */
  const originBranches = useMemo(() => (refs?.refs ?? []).map((ref) => (ref.kind === "remote" ? originBranchName(ref.name) : null)).filter((name): name is string => !!name), [refs]);

  /** Runs the Git command of `action` on the branch `ref`; a success reloads every view of the worktree through `editVersion`. */
  const runAction = async (ref: GitRef, action: BranchAction) => {
    if (action.kind === "rename") {
      setRenaming(ref.name);
      return;
    }
    if (action.kind === "retarget") {
      setIsRetargeting(true);
      return;
    }
    setBusyLabel(BUSY_LABELS[action.kind]);
    try {
      const didRun = await performAction(sessionId, ref, action);
      if (didRun) {
        setError(null);
        noteWorktreeChanged(sessionId);
      }
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusyLabel(null);
    }
  };

  /** Deletes every prunable branch after one confirmation that lists them; branches git refuses to delete are reported. */
  const pruneBranches = async () => {
    const count = prunable.length;
    const message = `Delete ${count} local ${count === 1 ? "branch" : "branches"} without a branch on origin?\n\n${prunable.join("\n")}\n\nCommits only these branches have are lost.`;
    if (!(await confirmDestructive(message))) return;
    setBusyLabel(BUSY_LABELS.delete);
    const failures: string[] = [];
    for (const branch of prunable) {
      try {
        await commands.gitDeleteBranch(sessionId, branch, true);
      } catch (reason) {
        failures.push(`${branch}: ${errorText(reason)}`);
      }
    }
    setBusyLabel(null);
    setError(failures.length ? failures.join("\n") : null);
    noteWorktreeChanged(sessionId);
  };

  const onRenamed = (branch: string, newName: string) => {
    if (filter.reference === branch) {
      setFilter((current) => ({ ...current, reference: newName }));
    }
    noteWorktreeChanged(sessionId);
  };

  return (
    <PersistentGroup id="hunt-git" className="h-full min-h-0">
      <Panel id="refs" defaultSize="18%" minSize={160} maxSize={520} className="flex">
        <RefTree
          refs={refs}
          pushes={pushes}
          filter={filter.reference}
          menuFor={menu?.ref.name ?? null}
          busyLabel={busyLabel}
          prunable={prunable}
          onFilter={(reference) => setFilter((current) => ({ ...current, reference }))}
          onContextMenu={(ref, x, y) => setMenu({ ref, x, y })}
          onPrune={() => void pruneBranches()}
        />
      </Panel>
      <PaneSeparator />
      <Panel id="log" minSize={320} className="flex">
        <CommitLog
          commits={commits}
          head={refs?.head ?? null}
          localBranches={localBranches}
          unpushed={unpushed}
          filter={filter}
          onFilterChange={setFilter}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onContextMenu={(commit, x, y) => setCommitMenu({ commit, x, y })}
          hasMore={hasMore}
          isLoading={isLoading || isLoadingMore}
          onLoadMore={loadMore}
          error={error}
        />
      </Panel>
      <PaneSeparator />
      <Panel id="commit" defaultSize="34%" minSize={240} className="flex">
        <PersistentGroup id="hunt-git-commit" orientation="vertical" className="h-full min-h-0 flex-1">
          <Panel id="files" defaultSize="45%" minSize={120} className="flex">
            <CommitFiles commit={selectedCommit} details={details} localBranches={localBranches} selectedPath={selectedFile?.path ?? null} onSelect={setSelectedFile} />
          </Panel>
          <PaneSeparator orientation="vertical" />
          <Panel id="diff" minSize={120} className="flex">
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex items-center gap-2 border-b border-(--line) py-2.5 pr-3 pl-3 text-[13px]">
                <span className="min-w-0 flex-1 truncate font-mono text-neutral-300">
                  {selectedFile ? (selectedFile.oldPath ? `${selectedFile.oldPath} → ${selectedFile.path}` : selectedFile.path) : "No file selected"}
                </span>
                {selectedFile && selectedFile.status !== "D" ? (
                  <button
                    type="button"
                    onClick={() => void openInEditorWindow(sessionId, { path: selectedFile.path })}
                    className={SECONDARY_BUTTON_XS}
                    title="Open the file's current version in the editor window"
                  >
                    Open
                  </button>
                ) : null}
              </div>
              <div className="relative min-h-0 flex-1 bg-(--diff-bg)">
                {diff && selectedFile && selectedId ? (
                  <CodeDiffEditor
                    key={`${sessionId}:${selectedId}:${diff.path}`}
                    sessionId={sessionId}
                    diff={diff}
                    mode="split"
                    collapseUnchanged
                    fontSize={diffFontSize}
                    lineHeight={diffLineHeight}
                    fontFamily={diffFontFamily}
                    readOnly
                    isDetached
                    onSave={() => undefined}
                    onDirtyChange={() => undefined}
                    onNavigate={() => undefined}
                    onOpenInIde={() => undefined}
                  />
                ) : (
                  <p className="p-3 text-[13px] text-neutral-500">{selectedFile ? "Loading the change…" : selectedCommit ? "Select a file of the commit." : "Select a commit."}</p>
                )}
              </div>
            </div>
          </Panel>
        </PersistentGroup>
      </Panel>
      {menu ? (
        <GitMenu
          title={menu.ref.name}
          x={menu.x}
          y={menu.y}
          entries={menuActions}
          onClose={() => setMenu(null)}
          onPick={(action) => {
            setMenu(null);
            void runAction(menu.ref, action);
          }}
        />
      ) : null}
      {commitMenu ? (
        <GitMenu
          title={`${commitMenu.commit.id.slice(0, 8)} ${commitMenu.commit.subject}`}
          x={commitMenu.x}
          y={commitMenu.y}
          entries={COMMIT_MENU}
          onClose={() => setCommitMenu(null)}
          onPick={() => {
            setCommitMenu(null);
            setResetTarget(commitMenu.commit);
          }}
        />
      ) : null}
      {resetTarget ? <ResetDialog sessionId={sessionId} head={refs?.head ?? "HEAD"} commit={resetTarget} onClose={() => setResetTarget(null)} onReset={() => noteWorktreeChanged(sessionId)} /> : null}
      {renaming ? <RenameBranchDialog sessionId={sessionId} branch={renaming} onClose={() => setRenaming(null)} onRenamed={(newName) => onRenamed(renaming, newName)} /> : null}
      {isRetargeting && pushes ? (
        <PushTargetDialog sessionId={sessionId} branch={pushes.branch} current={pushes.target} candidates={originBranches} onClose={() => setIsRetargeting(false)} onChanged={() => noteWorktreeChanged(sessionId)} />
      ) : null}
    </PersistentGroup>
  );
}

/**
 * Runs the Git command behind `action` for the branch `ref` of the session; returns whether it ran (a delete the
 * user did not confirm did not). A local branch whose commits no other branch has is deleted only after a confirmation.
 */
async function performAction(sessionId: string, ref: GitRef, action: BranchAction): Promise<boolean> {
  switch (action.kind) {
    case "rebase":
      await commands.gitRebase(sessionId, ref.name);
      return true;
    case "merge":
      await commands.gitMerge(sessionId, ref.name);
      return true;
    case "update":
      await commands.gitUpdateBranch(sessionId, ref.name);
      return true;
    case "fetch":
      await commands.gitFetchBranch(sessionId, originBranchName(ref.name) ?? "");
      return true;
    case "push":
      await commands.pushBranch(sessionId);
      return true;
    case "pushBranch":
      await commands.gitPushLocalBranch(sessionId, ref.name);
      return true;
    case "delete":
      return deleteLocalBranch(sessionId, ref.name);
    case "deleteRemote": {
      if (!(await confirmDestructive(`Delete ${ref.name} on origin?\n\nEveryone who fetched it keeps a copy, but the branch is gone for the team.`))) return false;
      await commands.gitDeleteRemoteBranch(sessionId, originBranchName(ref.name) ?? "");
      return true;
    }
    case "rename":
    case "retarget":
      return false;
  }
}

async function deleteLocalBranch(sessionId: string, branch: string): Promise<boolean> {
  try {
    await commands.gitDeleteBranch(sessionId, branch, false);
    return true;
  } catch (reason) {
    if (!String(reason).includes("not fully merged")) throw reason;
  }
  if (!(await confirmDestructive(`Delete branch ${branch}?\n\nIt has commits no other branch has; they are lost with it.`))) return false;
  await commands.gitDeleteBranch(sessionId, branch, true);
  return true;
}
