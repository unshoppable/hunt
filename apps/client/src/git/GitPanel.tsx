import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { commands } from "../ipc/commands";
import type { Commit, CommitDetails, CommitFile, FileDiff, GitRef, GitScope, RefList } from "../ipc/types";
import { useHuntStore } from "../state/store";
import { remoteOf } from "../chat/remoteSession";
import { useSettingsStore } from "../state/settings";
import { PaneSeparator, Panel, PersistentGroup } from "../layout/ResizablePanes";
import { CodeDiffEditor } from "../diff/CodeDiffEditor";
import { monacoLanguage } from "../diff/monaco";
import { SplitDiffView } from "../diff/SplitDiffView";
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
 * The Git tab: the branch tree, the commit log of `scope` with its graph, and the selected commit's files, details and
 * the diff of the selected file. For a session the log starts on its own branch, so its commits show on top of the
 * branch they will be pushed to, and reloads after every turn of the agent and every local write (`editVersion`),
 * since both may commit; a repository's checkout, shown while no session is active, reloads after the tab's own
 * actions and can check branches out. A new filter selects its newest commit, so a click on a branch shows its head
 * and that commit's files; a right click on a commit offers to reset the checked-out branch to it.
 */
export function GitPanel({ scope }: { scope: GitScope }) {
  const sessionId = scope.kind === "session" ? scope.id : null;
  /** Identifies the scope in load keys; the panel is remounted for another scope. */
  const scopeKey = scope.kind === "session" ? scope.id : scope.path;
  const editVersion = useHuntStore((state) => (sessionId ? (state.chats[sessionId]?.editVersion ?? 0) : 0));
  const noteWorktreeChanged = useHuntStore((state) => state.noteWorktreeChanged);
  /** Counts the changes the tab made to a repository's checkout, which has no session to count them. */
  const [repoVersion, setRepoVersion] = useState(0);
  const version = sessionId ? editVersion : repoVersion;
  const sessions = useHuntStore((state) => state.sessions);
  const session = sessions.find((candidate) => candidate.id === sessionId) ?? null;
  const repoPath = session?.repoPath ?? (scope.kind === "repo" ? scope.path : null);
  /** Why the menu cannot check a branch out: a session works on its branch, also one working in the repository's checkout. */
  const checkoutBlocked = useMemo(() => {
    if (session) return session.workspace === "checkout" ? "The session works in this checkout" : "The session's worktree is bound to its branch";
    const holder = sessions.find((candidate) => candidate.workspace === "checkout" && candidate.repoPath === repoPath && !candidate.parentId);
    return holder ? `The session "${holder.title}" works in this checkout` : null;
  }, [session, sessions, repoPath]);
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
  /** What the last branch action did, shown in the branch tree's header until the next one starts. */
  const [notice, setNotice] = useState<string | null>(null);
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
  const logKey = `${scopeKey}\n${filter.reference}\n${filter.text}\n${version}`;
  const logKeyRef = useRef(logKey);
  logKeyRef.current = logKey;
  /** The filter whose commits the log shows; the first page of another one selects its newest commit. */
  const shownFilterRef = useRef<string | null>(null);

  useLoad(
    () => commands.gitRefs(scope),
    { onValue: setRefs, onError: (reason) => setError(errorText(reason)) },
    [scopeKey, version],
  );

  // The first page loads for every filter and after every change of the history; later pages append below.
  useLoad(
    () => {
      setIsLoading(true);
      return commands.gitLog(scope, { ...filter, skip: 0, limit: PAGE_SIZE });
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
      .gitLog(scope, { ...filter, skip: commits.length, limit: PAGE_SIZE })
      .then((page) => {
        if (logKeyRef.current !== key) return;
        setCommits((current) => [...current, ...page]);
        setHasMore(page.length === PAGE_SIZE);
      })
      .catch((reason) => setError(errorText(reason)))
      .finally(() => setIsLoadingMore(false));
  }, [hasMore, isLoading, isLoadingMore, scope, filter, commits.length]);

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
    () => commands.gitCommit(scope, selectedId ?? ""),
    { onValue: setDetails, onError: (reason) => setError(errorText(reason)) },
    [scopeKey, selectedId, version],
    { isEnabled: !!selectedId },
  );

  useLoad(
    () => commands.gitCommitFileDiff(scope, selectedId ?? "", selectedFile?.path ?? "", selectedFile?.oldPath ?? null),
    { onValue: setDiff, onError: (reason) => setError(errorText(reason)) },
    [scopeKey, selectedId, selectedFile],
    { isEnabled: !!selectedId && !!selectedFile },
  );

  const selectedCommit = useMemo(() => commits.find((commit) => commit.id === selectedId) ?? null, [commits, selectedId]);
  const unpushed = useMemo(() => new Set(refs?.unpushed ?? []), [refs]);
  const localBranches = useMemo(() => new Set((refs?.refs ?? []).filter((ref) => ref.kind === "local").map((ref) => ref.name)), [refs]);
  const menuActions = useMemo(() => (menu ? branchActions(menu.ref, { head: refs?.head ?? "HEAD", pushes, isRemoteSession: !!remote, isPollerSession: remote?.origin === "swf", checkoutBlocked }) : []),
    [menu, refs, pushes, remote, checkoutBlocked],
  );
  /** Local branches origin lacks that no session of the repository has checked out, which the branch tree's button deletes. */
  const prunable = useMemo(() => {
    if (!refs || !repoPath) return [];
    const kept = new Set([refs.head, ...sessions.filter((candidate) => candidate.repoPath === repoPath).map((candidate) => candidate.branch)]);
    return localBranchesWithoutOrigin(refs.refs, kept);
  }, [refs, repoPath, sessions]);
  /** The branches of origin a push could land on, without the `origin/` prefix. */
  const originBranches = useMemo(() => (refs?.refs ?? []).map((ref) => (ref.kind === "remote" ? originBranchName(ref.name) : null)).filter((name): name is string => !!name), [refs]);

  /** Reloads every view of the scope: a session's through its `editVersion`, a repository's checkout in this tab. */
  const refresh = () => {
    if (sessionId) {
      noteWorktreeChanged(sessionId);
    } else {
      setRepoVersion((current) => current + 1);
    }
  };

  /** Runs the Git command of `action` on the branch `ref`; a success reloads every view of the scope. */
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
    setNotice(null);
    try {
      const outcome = await performAction(scope, ref, action);
      if (outcome) {
        setError(null);
        setNotice(outcome.notice);
        refresh();
      }
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusyLabel(null);
    }
  };

  /** Fetches every branch of origin; a success reloads the branch tree and the log. */
  const fetchOrigin = async () => {
    setBusyLabel(BUSY_LABELS.fetch);
    setNotice(null);
    try {
      await commands.gitFetchOrigin(scope);
      setError(null);
      setNotice("Fetched origin");
      refresh();
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
    setNotice(null);
    const failures: string[] = [];
    for (const branch of prunable) {
      try {
        await commands.gitDeleteBranch(scope, branch, true);
      } catch (reason) {
        failures.push(`${branch}: ${errorText(reason)}`);
      }
    }
    setBusyLabel(null);
    setError(failures.length ? failures.join("\n") : null);
    refresh();
  };

  const onRenamed = (branch: string, newName: string) => {
    if (filter.reference === branch) {
      setFilter((current) => ({ ...current, reference: newName }));
    }
    refresh();
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
          notice={notice}
          prunable={prunable}
          onFilter={(reference) => setFilter((current) => ({ ...current, reference }))}
          onContextMenu={(ref, x, y) => setMenu({ ref, x, y })}
          onFetch={() => void fetchOrigin()}
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
                {sessionId && selectedFile && selectedFile.status !== "D" ? (
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
                {diff && selectedFile && selectedId && !sessionId ? (
                  <SplitDiffView
                    key={`${scopeKey}:${selectedId}:${diff.path}`}
                    original={diff.oldContent ?? ""}
                    modified={diff.newContent ?? ""}
                    language={monacoLanguage(diff.path)}
                    fontSize={diffFontSize}
                    lineHeight={diffLineHeight}
                    fontFamily={diffFontFamily}
                    readOnly
                    collapseUnchanged
                    onEditorsCreated={() => undefined}
                  />
                ) : diff && selectedFile && selectedId && sessionId ? (
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
                    onOpenUsage={() => undefined}
                    onError={() => undefined}
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
      {resetTarget ? <ResetDialog scope={scope} head={refs?.head ?? "HEAD"} commit={resetTarget} onClose={() => setResetTarget(null)} onReset={refresh} /> : null}
      {renaming ? <RenameBranchDialog scope={scope} branch={renaming} onClose={() => setRenaming(null)} onRenamed={(newName) => onRenamed(renaming, newName)} /> : null}
      {isRetargeting && pushes && sessionId ? (
        <PushTargetDialog sessionId={sessionId} branch={pushes.branch} current={pushes.target} candidates={originBranches} onClose={() => setIsRetargeting(false)} onChanged={refresh} />
      ) : null}
    </PersistentGroup>
  );
}

/** What a branch action that ran did, for the branch tree's header; `notice` is `null` when the tree itself shows it. */
type ActionOutcome = { notice: string | null };

const DONE: ActionOutcome = { notice: null };

/**
 * Runs the Git command behind `action` for the branch `ref` of `scope`; `null` when it did not run (a delete or force
 * pull the user did not confirm, or an action of a session's own branch outside a session). A local branch whose
 * commits no other branch has is deleted only after a confirmation, and a force pull is confirmed since it drops the
 * commits the upstream lacks.
 */
async function performAction(scope: GitScope, ref: GitRef, action: BranchAction): Promise<ActionOutcome | null> {
  const upstream = ref.upstream ?? "its upstream";
  switch (action.kind) {
    case "checkout": {
      if (scope.kind !== "repo") return null;
      await commands.gitCheckout(scope.path, ref.name, ref.kind === "remote");
      return { notice: `Checked out ${ref.kind === "remote" ? (originBranchName(ref.name) ?? ref.name) : ref.name}` };
    }
    case "rebase":
      await commands.gitRebase(scope, ref.name);
      return DONE;
    case "merge":
      await commands.gitMerge(scope, ref.name);
      return DONE;
    case "update":
      if (scope.kind !== "session") return null;
      await commands.gitUpdateBranch(scope.id);
      return DONE;
    case "pull": {
      const didMove = await commands.gitPullBranch(scope, ref.name);
      return { notice: didMove ? `Pulled ${upstream} into ${ref.name}` : `${ref.name} is up to date with ${upstream}` };
    }
    case "forcePull": {
      const lost = ref.ahead ? `The ${ref.ahead} ${ref.ahead === 1 ? "commit" : "commits"} it has that ${upstream} lacks are lost.` : `Commits it has that ${upstream} lacks are lost.`;
      if (!(await confirmDestructive(`Force pull ${ref.name}?\n\n${ref.name} is reset to ${upstream}. ${lost}`, "Force pull"))) return null;
      await commands.gitForcePullBranch(scope, ref.name);
      return { notice: `Reset ${ref.name} to ${upstream}` };
    }
    case "fetch":
      await commands.gitFetchBranch(scope, originBranchName(ref.name) ?? "");
      return DONE;
    case "push":
      if (scope.kind !== "session") return null;
      await commands.pushBranch(scope.id);
      return DONE;
    case "pushBranch":
      await commands.gitPushLocalBranch(scope, ref.name);
      return DONE;
    case "delete":
      return (await deleteLocalBranch(scope, ref.name)) ? DONE : null;
    case "deleteRemote": {
      if (!(await confirmDestructive(`Delete ${ref.name} on origin?\n\nEveryone who fetched it keeps a copy, but the branch is gone for the team.`))) return null;
      await commands.gitDeleteRemoteBranch(scope, originBranchName(ref.name) ?? "");
      return DONE;
    }
    case "rename":
    case "retarget":
      return null;
  }
}

async function deleteLocalBranch(scope: GitScope, branch: string): Promise<boolean> {
  try {
    await commands.gitDeleteBranch(scope, branch, false);
    return true;
  } catch (reason) {
    if (!String(reason).includes("not fully merged")) throw reason;
  }
  if (!(await confirmDestructive(`Delete branch ${branch}?\n\nIt has commits no other branch has; they are lost with it.`))) return false;
  await commands.gitDeleteBranch(scope, branch, true);
  return true;
}
