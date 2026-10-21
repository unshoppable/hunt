import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { commands } from "../ipc/commands";
import type { ChangedFile, ChangedFileView, FileDiff, FileVersion, GraphNode } from "../ipc/types";
import { useHuntStore } from "../state/store";
import { PaneSeparator, Panel, PersistentGroup } from "../layout/ResizablePanes";
import { useSettingsStore } from "../state/settings";
import { isOwnChange, otherTouchers, type ChangeScope } from "./attribution";
import { ownContent } from "./ownChanges";
import { ChangeList } from "./ChangeList";
import { matchesGlob, splitGlobs } from "./glob";
import { parseGraph } from "../graph/schema";
import { SubChatPopover, useSubChatPopover } from "../chat/SubChatPopover";
import { CodeDiffEditor, type CodeDiffEditorHandle } from "./CodeDiffEditor";
import { isWorktreeLocked, WORKTREE_LOCKED_MESSAGE } from "../chat/remoteSession";
import { GHOST_BUTTON_XS, SECONDARY_BUTTON_XS, TAB_ACTIVE, TAB_BUTTON_SM, TAB_INACTIVE } from "../ui/buttons";
import { workspaceFor } from "../ide/documents";
import { openInEditorWindow } from "../ide/editorWindows";
import { useDirtyPaths } from "../ide/useDirtyPaths";
import { selectionChatsFor } from "../ide/selectionChats";
import { useReviewedPullRequest } from "../review/reviewComments";
import { confirmDestructive } from "../ui/confirm";
import { baseName } from "../ui/path";
import { UnsavedDot } from "../ui/UnsavedDot";
import { useDismiss } from "../ui/useDismiss";
import { errorText, useLoad } from "../ui/useLoad";

type ContextMenuState = { x: number; y: number; file: ChangedFile };

type DiffMode = "split" | "unified";

/** Task of a sub chat opened from a changelist row: the chat is about the whole file, not a selection in it. */
function wholeFileTask(file: ChangedFile): string {
  const change = file.status === "D" ? "deleted it" : file.status === "A" || file.status === "?" ? "added it" : "changed it";
  return `The user opened this chat from the changelist about the whole file \`${file.path}\`; the current work ${change}. Answer questions about the file and its changes, and edit the file when asked to.`;
}

/** Files that do not exist at the base commit are removed instead of restored. */
function revertLabel(file: ChangedFile): string {
  return file.status === "?" || file.status === "A" ? "Delete file" : "Revert changes";
}

export function DiffPanel({ sessionId }: { sessionId: string }) {
  const editVersion = useHuntStore((state) => state.chats[sessionId]?.editVersion ?? 0);
  const graphVersion = useHuntStore((state) => state.chats[sessionId]?.graphVersion ?? 0);
  const noteWorktreeChanged = useHuntStore((state) => state.noteWorktreeChanged);
  const pullRequest = useReviewedPullRequest(sessionId);
  const diffFontSize = useSettingsStore((state) => state.panes.diff.fontSize);
  const diffLineHeight = useSettingsStore((state) => state.panes.diff.lineHeight);
  const diffFontFamily = useSettingsStore((state) => state.panes.diff.fontFamily);
  const session = useHuntStore((state) => state.sessions.find((candidate) => candidate.id === sessionId));
  const isLocked = useHuntStore((state) => isWorktreeLocked(state.sessions, state.remoteLinks, sessionId));
  const worktreePath = session?.worktreePath;
  /** Files with unsaved edits; they keep them when another file is shown. */
  const unsavedPaths = useDirtyPaths(useMemo(() => (worktreePath ? workspaceFor(sessionId, worktreePath) : null), [sessionId, worktreePath]));
  /**
   * The changelist can be scoped to the session's own changes: another session (parent or sub session) works in the
   * same worktree, or the session works in the repository's own checkout, which also holds the user's other work.
   */
  const isSharedWorktree = useHuntStore(
    (state) =>
      session?.workspace === "checkout" ||
      state.sessions.some((candidate) => candidate.id !== sessionId && candidate.worktreePath === session?.worktreePath),
  );
  const [files, setFiles] = useState<ChangedFileView[]>([]);
  const scope = useSettingsStore((state) => state.changelistScopes[sessionId] ?? "own");
  const setChangelistScope = useSettingsStore((state) => state.setChangelistScope);
  const setScope = useCallback((next: ChangeScope) => setChangelistScope(sessionId, next), [setChangelistScope, sessionId]);
  const scopedFiles = useMemo(() => {
    if (!isSharedWorktree || scope === "all") return files;
    return files.filter((file) => isOwnChange(file, sessionId, session?.parentId ?? null, session?.workspace ?? "worktree"));
  }, [files, scope, isSharedWorktree, sessionId, session?.parentId, session?.workspace]);
  /** The files in scope minus those matching one of the changelist's hidden globs. */
  const hiddenGlobsText = useSettingsStore((state) => state.changelistHiddenGlobs);
  const visibleFiles = useMemo(() => {
    const hiddenGlobs = splitGlobs(hiddenGlobsText);
    if (!hiddenGlobs.length) return scopedFiles;
    return scopedFiles.filter((file) => !hiddenGlobs.some((glob) => matchesGlob(glob, file.path)));
  }, [scopedFiles, hiddenGlobsText]);
  /** The agent's review ratings from `.hunt/graph.json`, keyed by path; empty while there is no diagram. */
  const [reviewRatings, setReviewRatings] = useState<Map<string, GraphNode>>(() => new Map());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  /** A newer version from disk that arrived while the editor had unsaved changes. */
  const [externalDiff, setExternalDiff] = useState<FileDiff | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const isDirtyRef = useRef(false);
  const editorRef = useRef<CodeDiffEditorHandle>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  /** Offset from the header's left edge of the right side's line numbers in split mode; null in unified mode. */
  const [lineNumbersLeft, setLineNumbersLeft] = useState<number | null>(null);
  const alignWithLineNumbers = useCallback((clientX: number | null) => {
    const header = headerRef.current;
    setLineNumbersLeft(clientX === null || !header ? null : clientX - header.getBoundingClientRect().left);
  }, []);
  const [mode, setMode] = useState<DiffMode>("split");
  const [isCollapsed, setIsCollapsed] = useState(false);
  /** Whether the diff of a file other sessions changed too shows every change or only the lines of this session and its parent. */
  const lineScope = useSettingsStore((state) => state.diffLineScope);
  const setLineScope = useSettingsStore((state) => state.setDiffLineScope);
  const [history, setHistory] = useState<{ path: string; versions: FileVersion[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const subChat = useSubChatPopover();
  const closeSubChat = subChat.close;
  /** Bumped after local changes to the worktree (save, revert, shelve) so both effects below reload. */
  const [localVersion, setLocalVersion] = useState(0);

  const markDirty = useCallback((value: boolean) => {
    isDirtyRef.current = value;
    setIsDirty(value);
  }, []);

  useDismiss(contextMenuRef, () => setContextMenu(null), { closeOnWindowBlur: true, isEnabled: !!contextMenu });

  useEffect(() => {
    closeSubChat();
  }, [sessionId, closeSubChat]);

  // The first changelist loads at once; reloads after edits wait, so a burst of them loads once.
  const hasLoadedRef = useRef(false);
  useLoad(
    () => {
      hasLoadedRef.current = true;
      return commands.listChangedFiles(sessionId);
    },
    {
      onValue: (result) => {
        setFiles(result);
        setError(null);
      },
      onError: (reason) => setError(errorText(reason)),
    },
    [sessionId, editVersion, localVersion],
    { delayMs: hasLoadedRef.current ? 300 : 0 },
  );

  useLoad(
    () => commands.readGraph(sessionId, "dependencies"),
    {
      onValue: (raw) => {
        const nodes = raw === null || raw === undefined ? [] : parseGraph(raw).graph.nodes;
        setReviewRatings(new Map(nodes.filter((node) => node.review).map((node) => [node.path, node])));
      },
      onError: (reason) => setError(errorText(reason)),
    },
    [sessionId, graphVersion],
  );

  // The selection follows the visible list: a file that left it (reverted, shelved, or hidden by the scope or a glob) gives way to the first one.
  useEffect(() => {
    setSelectedPath((current) => (current && visibleFiles.some((file) => file.path === current) ? current : (visibleFiles[0]?.path ?? null)));
  }, [visibleFiles]);

  useEffect(() => {
    if (selectedPath) return;
    setDiff(null);
    setExternalDiff(null);
  }, [selectedPath]);

  // `diff` is intentionally not a dependency: it is only compared, never a trigger.
  useLoad(
    () => commands.readFileDiff(sessionId, selectedPath ?? ""),
    {
      onValue: (result) => {
        if (isDirtyRef.current && result.path === diff?.path && result.newContent !== diff.newContent) {
          setExternalDiff(result);
          return;
        }
        setDiff(result);
        setExternalDiff(null);
      },
      onError: (reason) => setError(errorText(reason)),
    },
    [sessionId, selectedPath, editVersion, localVersion],
    { isEnabled: !!selectedPath },
  );

  const parentId = session?.parentId ?? null;
  const selectedFile = files.find((file) => file.path === selectedPath);
  const isOwnView = lineScope === "own" && !!selectedFile && otherTouchers(selectedFile, sessionId, parentId).length > 0;

  useLoad(
    () => commands.readFileHistory(sessionId, selectedPath ?? ""),
    {
      onValue: (versions) => setHistory({ path: selectedPath ?? "", versions }),
      onError: (reason) => setError(errorText(reason)),
    },
    [sessionId, selectedPath, editVersion, localVersion],
    { isEnabled: isOwnView && !!selectedPath },
  );

  const isOwn = useCallback((id: string | null) => !!id && (id === sessionId || id === parentId), [sessionId, parentId]);
  /** This session or its parent touched the file, but its loaded history holds none of their versions, e.g. from before it was recorded. */
  const isOwnHistoryMissing =
    isOwnView &&
    history?.path === selectedFile.path &&
    selectedFile.touchedBy.some(isOwn) &&
    !history.versions.some((version) => isOwn(version.sessionId));
  /**
   * The diff with only the lines this session and its parent changed, once the file's history is loaded. Without their
   * versions in the history the lines cannot be told apart, so it is the full diff.
   */
  const ownDiff = useMemo(() => {
    if (!isOwnView || !diff || history?.path !== diff.path) return null;
    if (isOwnHistoryMissing) return diff;
    return { ...diff, newContent: ownContent(diff.oldContent, history.versions, diff.newContent, isOwn) };
  }, [isOwnView, isOwnHistoryMissing, diff, history, isOwn]);
  const shownDiff = isOwnView ? ownDiff : diff;
  const canCommentOnFile = !!pullRequest && !!shownDiff && !isOwnView;
  const commentButtonLeft = canCommentOnFile ? lineNumbersLeft : null;

  const selectFile = (path: string) => {
    if (path === selectedPath) return;
    markDirty(false);
    setExternalDiff(null);
    setSelectedPath(path);
  };

  const saveFile = useCallback(
    (content: string) => {
      if (!selectedPath) return;
      commands
        .writeFile(sessionId, selectedPath, content)
        .then(() => {
          setError(null);
          setDiff((current) => (current ? { ...current, newContent: content } : current));
          setExternalDiff(null);
          markDirty(false);
          setLocalVersion((version) => version + 1);
          noteWorktreeChanged(sessionId);
        })
        .catch((reason) => setError(String(reason)));
    },
    [sessionId, selectedPath, markDirty, noteWorktreeChanged],
  );

  /**
   * Opens the sub chat about the whole of `file` beside its agent button in the changelist: the existing whole-file
   * chat with its conversation, or a new one whose agent gets the file's current content with every prompt.
   */
  const askAgentAboutFile = (file: ChangedFile, button: HTMLElement) => {
    const rect = button.getBoundingClientRect();
    const anchor = { x: rect.right + 6, y: rect.top };
    const fileChat = selectionChatsFor(useHuntStore.getState().sessions, sessionId, file.path).find((chat) => !!chat.selection.task);
    if (fileChat) {
      subChat.open({ selection: fileChat.selection, anchor }, fileChat.sessionId);
      return;
    }
    commands
      .readFileDiff(sessionId, file.path)
      .then((result) => {
        const text = result.newContent ?? result.oldContent ?? "";
        subChat.open({ selection: { path: file.path, startLine: 1, endLine: Math.max(1, text.split("\n").length), text, task: wholeFileTask(file) }, anchor });
      })
      .catch((reason) => setError(errorText(reason)));
  };

  const openContextMenu = (event: MouseEvent, file: ChangedFile) => {
    event.preventDefault();
    setContextMenu({ x: event.clientX, y: event.clientY, file });
  };

  const revertFile = async (file: ChangedFile) => {
    setContextMenu(null);
    if (!(await confirmDestructive(`${revertLabel(file)}: "${file.path}"? This discards all changes to the file.`, revertLabel(file)))) return;
    commands
      .revertFile(sessionId, file.path)
      .then(() => {
        setError(null);
        if (file.path === selectedPath) {
          markDirty(false);
          setExternalDiff(null);
        }
        setLocalVersion((version) => version + 1);
        noteWorktreeChanged(sessionId);
      })
      .catch((reason) => setError(String(reason)));
  };

  return (
    <PersistentGroup id="hunt-diff" className="h-full min-h-0">
      <Panel id="files" defaultSize="16%" minSize={140} maxSize={520} className="flex">
      <ChangeList
        sessionId={sessionId}
        files={visibleFiles}
        hiddenByGlobsCount={scopedFiles.length - visibleFiles.length}
        reviewRatings={reviewRatings}
        scope={isSharedWorktree ? { value: scope, hiddenCount: files.length - scopedFiles.length, includesParent: !!session?.parentId, onChange: setScope } : null}
        selectedPath={selectedPath}
        unsavedPaths={unsavedPaths}
        onSelect={selectFile}
        onContextMenu={openContextMenu}
        onAskAgent={askAgentAboutFile}
        onWorktreeChanged={() => {
          setLocalVersion((version) => version + 1);
          noteWorktreeChanged(sessionId);
        }}
      />
      </Panel>
      <PaneSeparator />
      <Panel id="viewer" minSize={240} className="flex">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* In split mode the file comment button starts where the right side's line numbers do. */}
        <div ref={headerRef} className="flex items-center border-b border-(--line) py-2.5 pr-3 text-[13px]">
          <span
            className="flex min-w-0 items-center pr-2 pl-3 font-mono text-neutral-300"
            style={commentButtonLeft === null ? { flex: "1 1 0%" } : { width: commentButtonLeft, flexShrink: 0 }}
          >
            <span className="truncate">{selectedPath ?? "No file selected"}</span>
            {isDirty ? <UnsavedDot className="ml-1.5" /> : null}
          </span>
          <div className={`flex items-center gap-2 ${commentButtonLeft === null ? "" : "flex-1"}`}>
            {canCommentOnFile ? (
              <button type="button" onClick={() => editorRef.current?.commentOnFile()} className={SECONDARY_BUTTON_XS} title="Comment on the whole file; it goes out with your review">
                Comment on file
              </button>
            ) : null}
            {commentButtonLeft === null ? null : <span className="flex-1" />}
            <button type="button" onClick={() => setMode(mode === "split" ? "unified" : "split")} className={SECONDARY_BUTTON_XS}>
              {mode === "split" ? "Split" : "Unified"}
            </button>
            <button type="button" onClick={() => setIsCollapsed(!isCollapsed)} className={SECONDARY_BUTTON_XS} title={isCollapsed ? "Show every unchanged line" : "Collapse every unchanged stretch"}>
              {isCollapsed ? "Expand all" : "Collapse unchanged"}
            </button>
            <button
              type="button"
              disabled={!files.length}
              onClick={() => void commands.openChangedFilesDiffInWebstorm(sessionId)}
              className={SECONDARY_BUTTON_XS}
              title="Open all changed files in WebStorm's directory diff"
            >
              Diff in WebStorm
            </button>
          </div>
        </div>
        {externalDiff ? (
          <div className="flex items-center gap-3 border-b border-(--line) bg-amber-950/40 px-3 py-2.5 text-[13px] text-amber-200">
            <span className="flex-1">This file changed on disk while you were editing it.</span>
            <button
              type="button"
              onClick={() => {
                setDiff(externalDiff);
                setExternalDiff(null);
                markDirty(false);
              }}
              className={SECONDARY_BUTTON_XS}
            >
              Reload from disk
            </button>
            <button type="button" onClick={() => setExternalDiff(null)} className={GHOST_BUTTON_XS}>
              Keep my version
            </button>
          </div>
        ) : null}
        {error ? <p className="border-b border-(--line) px-3 py-2 text-[13px] text-red-400">{error}</p> : null}
        {isOwnHistoryMissing ? (
          <p className="border-b border-(--line) px-3 py-2 text-[13px] text-neutral-400">
            {parentId ? "This session or its parent" : "This session"} changed this file before Hunt recorded edits line by line, so this shows the
            changes of all sessions.
          </p>
        ) : null}
        <div className="relative min-h-0 flex-1 bg-(--diff-bg)">
          {selectedFile && otherTouchers(selectedFile, sessionId, parentId).length ? (
            <div className="absolute top-2 right-6 z-10 flex gap-0.5 rounded-md border border-neutral-600 bg-(--surface-inset) p-0.5 text-[13px] shadow-lg shadow-black/40">
              <button
                type="button"
                disabled={isDirty}
                onClick={() => setLineScope("own")}
                className={`${TAB_BUTTON_SM} ${lineScope === "own" ? TAB_ACTIVE : TAB_INACTIVE} disabled:opacity-50`}
                title={isDirty ? "Save or discard your edits first" : `Show only the lines ${parentId ? "this session and its parent" : "this session"} changed (read-only)`}
              >
                Own
              </button>
              <button
                type="button"
                onClick={() => setLineScope("all")}
                className={`${TAB_BUTTON_SM} ${lineScope === "all" ? TAB_ACTIVE : TAB_INACTIVE}`}
                title="Show the changes of all sessions"
              >
                All
              </button>
            </div>
          ) : null}
          {isOwnView && !ownDiff ? (
            <p className="p-3 text-[13px] text-neutral-500">Loading the history of this file…</p>
          ) : ownDiff && ownDiff.newContent === (ownDiff.oldContent ?? "") ? (
            <p className="p-3 text-[13px] text-neutral-500">{parentId ? "This session and its parent did not change this file." : "This session did not change this file."}</p>
          ) : shownDiff ? (
            <CodeDiffEditor
              key={`${sessionId}:${shownDiff.path}:${isOwnView ? "own" : "all"}`}
              ref={editorRef}
              sessionId={sessionId}
              diff={shownDiff}
              mode={mode}
              collapseUnchanged={isCollapsed}
              fontSize={diffFontSize}
              lineHeight={diffLineHeight}
              fontFamily={diffFontFamily}
              readOnly={isOwnView}
              isLocked={isLocked}
              onSave={saveFile}
              onDirtyChange={markDirty}
              onNavigate={(line, column, name) => void openInEditorWindow(sessionId, { path: shownDiff.path, line, column, definitionOf: name })}
              onOpenInIde={(line, column) =>
                commands.openFileInWebstorm(sessionId, shownDiff.path, line, column).catch((reason) => setError(String(reason)))
              }
              onOpenSubChat={subChat.open}
              onToggleSubChat={subChat.toggle}
              onLineNumbersLeftChange={alignWithLineNumbers}
            />
          ) : (
            <p className="p-3 text-[13px] text-neutral-500">
              {visibleFiles.length
                ? "Select a file."
                : scopedFiles.length
                  ? "Every change is hidden by the changelist's file filter."
                  : files.length
                    ? session?.parentId
                      ? "No changes by this session or its parent."
                      : "No changes by this session."
                    : "No changes."}
            </p>
          )}
        </div>
      </div>
      </Panel>
      {subChat.shown ? (
        <SubChatPopover key={subChat.shown.key} parentSessionId={sessionId} request={subChat.shown.request} subSessionId={subChat.shown.subSessionId} onClose={subChat.close} />
      ) : null}
      {contextMenu ? (
        <div
          ref={contextMenuRef}
          role="menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          className="fixed z-50 min-w-36 rounded border border-neutral-600 bg-(--surface-inset) p-1 text-[13px] shadow-lg"
        >
          <div className="mb-1 truncate border-b border-(--line) px-2 pb-1 font-mono text-[12px] text-neutral-500" title={contextMenu.file.path}>
            {baseName(contextMenu.file.path)}
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => (isLocked ? undefined : void revertFile(contextMenu.file))}
            aria-disabled={isLocked}
            title={isLocked ? WORKTREE_LOCKED_MESSAGE : undefined}
            className={`block w-full rounded px-2 py-1 text-left text-red-300 hover:bg-(--row-hover) ${isLocked ? "opacity-40" : ""}`}
          >
            {revertLabel(contextMenu.file)}
          </button>
        </div>
      ) : null}
    </PersistentGroup>
  );
}
