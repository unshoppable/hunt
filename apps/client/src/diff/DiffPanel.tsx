import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { commands } from "../ipc/commands";
import type { ChangedFile, ChangedFileView, FileDiff, FileVersion, GraphNode } from "../ipc/types";
import { useHuntStore } from "../state/store";
import { PaneSeparator, Panel, PersistentGroup } from "../layout/ResizablePanes";
import { useSessionViewStore } from "../state/sessionViews";
import { useSettingsStore } from "../state/settings";
import { isOwnChange, otherTouchers, ownerLabel, type ChangeScope } from "./attribution";
import { ownView } from "./ownChanges";
import type { OverwriteMark } from "./overwriteMarkers";
import { sessionMarks } from "../sessions/sessionLabels";
import { ChangeList, type ChangeListTarget } from "./ChangeList";
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
import { isShortcut, useShortcutLabel } from "../ui/shortcuts";
import { WebstormIcon } from "../ui/icons";
import { baseName } from "../ui/path";
import { UnsavedDot } from "../ui/UnsavedDot";
import { useDismiss } from "../ui/useDismiss";
import { errorText, useLoad } from "../ui/useLoad";

/** Narrowest changelist whose header row and commit row (Commit with its chevron, Shelve, the selection count and Push) still fit. */
export const CHANGE_LIST_MIN_WIDTH = 240;
/** Narrowest diff viewer worth reading beside the changelist. */
const VIEWER_MIN_WIDTH = 240;

type ContextMenuState = { x: number; y: number; target: ChangeListTarget };

type DiffMode = "split" | "unified";

/** Task of a sub chat opened from a changelist row: the chat is about the whole file, not a selection in it. */
function wholeFileTask(file: ChangedFile): string {
  const change = file.status === "D" ? "deleted it" : file.status === "A" || file.status === "?" ? "added it" : "changed it";
  return `The user opened this chat from the changelist about the whole file \`${file.path}\`; the current work ${change}. Answer questions about the file and its changes, and edit the file when asked to.`;
}

/** Task of a sub chat opened from a changelist folder row: the chat is about the folder and the changed files in it. */
function folderTask(path: string): string {
  return `The user opened this chat from the changelist about the folder \`${path}/\` and the changes the current work made in it. Answer questions about the folder and its changes, and edit its files when asked to.`;
}

/** Files that do not exist at the base commit are removed instead of restored; a folder reverts every listed file in it. */
function revertLabel(target: ChangeListTarget): string {
  if (target.isFolder) return target.files.length === 1 ? "Revert 1 file" : `Revert ${target.files.length} files`;
  return target.files[0].status === "?" || target.files[0].status === "A" ? "Delete file" : "Revert changes";
}

function revertQuestion(target: ChangeListTarget): string {
  if (!target.isFolder) return `${revertLabel(target)}: "${target.path}"? This discards all changes to the file.`;
  return `${revertLabel(target)} in "${target.path}"? This discards all changes to the listed files and deletes the new ones.`;
}

export function DiffPanel({ sessionId }: { sessionId: string }) {
  const editVersion = useHuntStore((state) => state.chats[sessionId]?.editVersion ?? 0);
  const graphVersion = useHuntStore((state) => state.chats[sessionId]?.graphVersion ?? 0);
  const noteWorktreeChanged = useHuntStore((state) => state.noteWorktreeChanged);
  const pullRequest = useReviewedPullRequest(sessionId);
  const diffFontSize = useSettingsStore((state) => state.panes.diff.fontSize);
  const diffLineHeight = useSettingsStore((state) => state.panes.diff.lineHeight);
  const diffFontFamily = useSettingsStore((state) => state.panes.diff.fontFamily);
  const sessions = useHuntStore((state) => state.sessions);
  const session = sessions.find((candidate) => candidate.id === sessionId);
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
  /** The selected file; the one selected when the session was left until the changelist arrives. */
  const [selectedPath, setSelectedPath] = useState<string | null>(() => useSessionViewStore.getState().views[sessionId]?.diffPath ?? null);
  const setDiffPath = useSessionViewStore((state) => state.setDiffPath);
  const [isListLoaded, setIsListLoaded] = useState(false);
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
  const openInEditorShortcut = useShortcutLabel("editor.selectInTree");
  const copyPathShortcut = useShortcutLabel("changes.copyPath");
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

  // ⌘S outside the editable side (change list, header, left side) saves like ⌘S in it; without one every file with unsaved edits.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || !isShortcut(event, "editor.save")) return;
      event.preventDefault();
      if (editorRef.current?.save() || !worktreePath) return;
      workspaceFor(sessionId, worktreePath)
        .saveAll()
        .then(() => setError(null))
        .catch((reason) => setError(String(reason)))
        .finally(() => noteWorktreeChanged(sessionId));
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [sessionId, worktreePath, noteWorktreeChanged]);

  // ⇧⌘2 (keymap default, the editor's "select in tree") opens the selected file in the editor window and selects it in its project tree.
  useEffect(() => {
    if (!selectedPath) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || !selectedPath || !isShortcut(event, "editor.selectInTree")) return;
      event.preventDefault();
      void openInEditorWindow(sessionId, { path: selectedPath, revealInTree: true, revealFirstChange: true });
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [sessionId, selectedPath]);

  /** Puts the absolute path of the worktree-relative `path` on the clipboard. */
  const copyPath = useCallback(
    (path: string) => {
      if (!worktreePath) return;
      void navigator.clipboard.writeText(`${worktreePath}/${path}`).catch((reason) => setError(`failed to copy the path: ${errorText(reason)}`));
    },
    [worktreePath],
  );

  // ⌃⇧C (keymap default) copies the selected file's absolute path.
  useEffect(() => {
    if (!selectedPath) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || !selectedPath || !isShortcut(event, "changes.copyPath")) return;
      event.preventDefault();
      copyPath(selectedPath);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedPath, copyPath]);

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
        setIsListLoaded(true);
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
    if (!isListLoaded) return;
    setSelectedPath((current) => (current && visibleFiles.some((file) => file.path === current) ? current : (visibleFiles[0]?.path ?? null)));
  }, [visibleFiles, isListLoaded]);

  useEffect(() => {
    if (isListLoaded) {
      setDiffPath(sessionId, selectedPath);
    }
  }, [sessionId, selectedPath, isListLoaded, setDiffPath]);

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
    { isEnabled: !!selectedPath && isListLoaded },
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
  const own = useMemo(() => {
    if (!isOwnView || !diff || history?.path !== diff.path) return null;
    if (isOwnHistoryMissing) return { diff, overwrites: [] };
    const view = ownView(diff.oldContent, history.versions, diff.newContent, isOwn);
    return { diff: { ...diff, newContent: view.content }, overwrites: view.overwrites };
  }, [isOwnView, isOwnHistoryMissing, diff, history, isOwn]);
  const ownDiff = own?.diff ?? null;
  const marks = useMemo(() => sessionMarks(sessions), [sessions]);
  /** Own lines that are no longer on disk, with the marks of the sessions that changed them afterwards. */
  const overwriteMarks = useMemo<OverwriteMark[]>(
    () =>
      (own?.overwrites ?? []).map(({ startLine, endLine, sessionIds, diskLines }) => ({
        startLine,
        endLine,
        diskLines,
        owners: sessionIds.map((id) => (id ? ownerLabel(id, sessions, marks, sessionId, parentId) : { mark: "?", title: "an edit outside the agents" })),
      })),
    [own, sessions, marks, sessionId, parentId],
  );
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
          setDiff((current) => (current ? { ...current, newContent: content } : current));
          setExternalDiff(null);
          markDirty(false);
          setLocalVersion((version) => version + 1);
          // ⌘S saves the other files with unsaved edits too, as in the editor tab.
          return worktreePath ? workspaceFor(sessionId, worktreePath).saveAll(selectedPath) : undefined;
        })
        .then(() => setError(null))
        .catch((reason) => setError(String(reason)))
        .finally(() => noteWorktreeChanged(sessionId));
    },
    [sessionId, worktreePath, selectedPath, markDirty, noteWorktreeChanged],
  );

  /**
   * Opens the sub chat about the whole of `file` beside its agent button in the changelist: the existing whole-file
   * chat with its conversation, or a new one whose agent gets the file's current content with every prompt.
   */
  const askAgent = (target: ChangeListTarget, button: HTMLElement) => {
    const rect = button.getBoundingClientRect();
    const anchor = { x: rect.right + 6, y: rect.top };
    const existingChat = selectionChatsFor(useHuntStore.getState().sessions, sessionId, target.path).find((chat) => !!chat.selection.task);
    if (existingChat) {
      subChat.open({ selection: existingChat.selection, anchor }, existingChat.sessionId);
      return;
    }
    if (target.isFolder) {
      subChat.open({ selection: { path: target.path, startLine: 1, endLine: 1, text: "", task: folderTask(target.path), isFolder: true }, anchor });
      return;
    }
    const [file] = target.files;
    commands
      .readFileDiff(sessionId, file.path)
      .then((result) => {
        const text = result.newContent ?? result.oldContent ?? "";
        subChat.open({ selection: { path: file.path, startLine: 1, endLine: Math.max(1, text.split("\n").length), text, task: wholeFileTask(file) }, anchor });
      })
      .catch((reason) => setError(errorText(reason)));
  };

  const openContextMenu = (event: MouseEvent, target: ChangeListTarget) => {
    event.preventDefault();
    setContextMenu({ x: event.clientX, y: event.clientY, target });
  };

  /** Reverts the target's files after asking once; the first failure stops the rest. */
  const revertFiles = async (target: ChangeListTarget) => {
    setContextMenu(null);
    if (!(await confirmDestructive(revertQuestion(target), revertLabel(target)))) return;
    const reverted: string[] = [];
    let failure: string | null = null;
    for (const file of target.files) {
      // Unsaved edits go too; queued ahead of the reloads that follow, the document then takes the reverted file over.
      if (worktreePath) {
        workspaceFor(sessionId, worktreePath).revert(file.path);
      }
      try {
        await commands.revertFile(sessionId, file.path);
      } catch (reason) {
        failure = String(reason);
        break;
      }
      reverted.push(file.path);
    }
    setError(failure);
    if (!reverted.length) return;
    if (selectedPath && reverted.includes(selectedPath)) {
      markDirty(false);
      setExternalDiff(null);
    }
    setLocalVersion((version) => version + 1);
    noteWorktreeChanged(sessionId);
  };

  return (
    <PersistentGroup id="hunt-diff" className="h-full min-h-0">
      <Panel id="files" defaultSize="16%" minSize={CHANGE_LIST_MIN_WIDTH} maxSize={520} className="flex">
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
        onCopyPath={copyPath}
        onAskAgent={askAgent}
        onWorktreeChanged={() => {
          setLocalVersion((version) => version + 1);
          noteWorktreeChanged(sessionId);
        }}
      />
      </Panel>
      <PaneSeparator />
      <Panel id="viewer" minSize={VIEWER_MIN_WIDTH} className="flex">
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
              <WebstormIcon className="size-3.5" />
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
        <div data-ide-root="" className="relative min-h-0 flex-1 bg-(--diff-bg)">
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
              overwrites={isOwnView ? overwriteMarks : undefined}
              onSave={saveFile}
              onDirtyChange={markDirty}
              onNavigate={(line, column, name) => void openInEditorWindow(sessionId, { path: shownDiff.path, line, column, definitionOf: name })}
              onOpenInIde={(line, column) =>
                commands.openFileInWebstorm(sessionId, shownDiff.path, line, column).catch((reason) => setError(String(reason)))
              }
              onOpenUsage={(usage) => void openInEditorWindow(sessionId, { path: usage.path, line: usage.line, column: usage.column })}
              onError={setError}
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
          <div className="mb-1 truncate border-b border-(--line) px-2 pb-1 font-mono text-[12px] text-neutral-500" title={contextMenu.target.path}>
            {baseName(contextMenu.target.path)}
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setContextMenu(null);
              const { path, isFolder } = contextMenu.target;
              void openInEditorWindow(sessionId, isFolder ? { path, isFolder } : { path, revealInTree: true, revealFirstChange: true });
            }}
            className="flex w-full items-center justify-between gap-4 rounded px-2 py-1 text-left hover:bg-(--row-hover)"
          >
            Open in editor
            {openInEditorShortcut && !contextMenu.target.isFolder ? <span className="text-neutral-500">{openInEditorShortcut}</span> : null}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setContextMenu(null);
              copyPath(contextMenu.target.path);
            }}
            className="flex w-full items-center justify-between gap-4 rounded px-2 py-1 text-left hover:bg-(--row-hover)"
          >
            Copy path
            {copyPathShortcut ? <span className="text-neutral-500">{copyPathShortcut}</span> : null}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => (isLocked ? undefined : void revertFiles(contextMenu.target))}
            aria-disabled={isLocked}
            title={isLocked ? WORKTREE_LOCKED_MESSAGE : undefined}
            className={`block w-full rounded px-2 py-1 text-left text-red-300 hover:bg-(--row-hover) ${isLocked ? "opacity-40" : ""}`}
          >
            {revertLabel(contextMenu.target)}
          </button>
        </div>
      ) : null}
    </PersistentGroup>
  );
}
