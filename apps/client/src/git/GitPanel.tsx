import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { commands } from "../ipc/commands";
import type { Commit, CommitDetails, CommitFile, FileDiff, RefList } from "../ipc/types";
import { useHuntStore } from "../state/store";
import { useSettingsStore } from "../state/settings";
import { PaneSeparator, Panel, PersistentGroup } from "../layout/ResizablePanes";
import { CodeDiffEditor } from "../diff/CodeDiffEditor";
import { openInEditorWindow } from "../ide/editorWindows";
import { SECONDARY_BUTTON_XS } from "../ui/buttons";
import { errorText, useLoad } from "../ui/useLoad";
import { CommitFiles } from "./CommitFiles";
import { CommitLog } from "./CommitLog";
import { RefTree } from "./RefTree";

/** Commits one page of the log loads; scrolling near the end loads the next. */
const PAGE_SIZE = 500;

/** Filter of the log: the branch or tag whose history shows (every ref when empty) and the text or hash to look for. */
export type LogFilter = { reference: string; text: string };

/**
 * The Git tab: the branch tree, the commit log of the session's worktree with its graph, and the selected commit's
 * files, details and the diff of the selected file. The log reloads after every turn of the agent and every local
 * write (`editVersion`), since both may commit.
 */
export function GitPanel({ sessionId }: { sessionId: string }) {
  const editVersion = useHuntStore((state) => state.chats[sessionId]?.editVersion ?? 0);
  const diffFontSize = useSettingsStore((state) => state.panes.diff.fontSize);
  const diffLineHeight = useSettingsStore((state) => state.panes.diff.lineHeight);
  const diffFontFamily = useSettingsStore((state) => state.panes.diff.fontFamily);
  const [refs, setRefs] = useState<RefList | null>(null);
  const [filter, setFilter] = useState<LogFilter>({ reference: "", text: "" });
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

  return (
    <PersistentGroup id="hunt-git" className="h-full min-h-0">
      <Panel id="refs" defaultSize="18%" minSize={160} maxSize={520} className="flex">
        <RefTree refs={refs} filter={filter.reference} onFilter={(reference) => setFilter((current) => ({ ...current, reference }))} />
      </Panel>
      <PaneSeparator />
      <Panel id="log" minSize={320} className="flex">
        <CommitLog
          commits={commits}
          head={refs?.head ?? null}
          unpushed={unpushed}
          filter={filter}
          onFilterChange={setFilter}
          selectedId={selectedId}
          onSelect={setSelectedId}
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
            <CommitFiles commit={selectedCommit} details={details} selectedPath={selectedFile?.path ?? null} onSelect={setSelectedFile} />
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
    </PersistentGroup>
  );
}
