import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { commands } from "../ipc/commands";
import type { ChangedFile, ChangedFileView, FileDiff } from "../ipc/types";
import { useHuntStore } from "../state/store";
import { PaneSeparator, Panel, PersistentGroup } from "../layout/ResizablePanes";
import { useSettingsStore } from "../state/settings";
import { isOwnChange, type ChangeScope } from "./attribution";
import { ChangeList } from "./ChangeList";
import { SubChatPopover, useSubChatPopover } from "../chat/SubChatPopover";
import { CodeDiffEditor, type CodeDiffEditorHandle } from "./CodeDiffEditor";
import { BUTTON_SM, GHOST_BUTTON_SM, SECONDARY, SECONDARY_BUTTON_SM } from "../ui/buttons";
import { openInEditorWindow } from "../ide/editorWindows";
import { confirmDestructive } from "../ui/confirm";
import { baseName } from "../ui/path";
import { useDismiss } from "../ui/useDismiss";
import { errorText, useLoad } from "../ui/useLoad";

type ContextMenuState = { x: number; y: number; file: ChangedFile };

type DiffMode = "split" | "unified";

/** Files that do not exist at the base commit are removed instead of restored. */
function revertLabel(file: ChangedFile): string {
  return file.status === "?" || file.status === "A" ? "Delete file" : "Revert changes";
}

export function DiffPanel({ sessionId }: { sessionId: string }) {
  const editVersion = useHuntStore((state) => state.chats[sessionId]?.editVersion ?? 0);
  const noteWorktreeChanged = useHuntStore((state) => state.noteWorktreeChanged);
  const diffFontSize = useSettingsStore((state) => state.panes.diff.fontSize);
  const diffLineHeight = useSettingsStore((state) => state.panes.diff.lineHeight);
  const diffFontFamily = useSettingsStore((state) => state.panes.diff.fontFamily);
  const session = useHuntStore((state) => state.sessions.find((candidate) => candidate.id === sessionId));
  /** Another session (parent or sub session) works in the same worktree, so the changelist can be scoped. */
  const isSharedWorktree = useHuntStore((state) =>
    state.sessions.some((candidate) => candidate.id !== sessionId && candidate.worktreePath === session?.worktreePath),
  );
  const [files, setFiles] = useState<ChangedFileView[]>([]);
  const [scope, setScope] = useState<ChangeScope>("own");
  const visibleFiles = useMemo(() => {
    if (!isSharedWorktree || scope === "all") return files;
    return files.filter((file) => isOwnChange(file, sessionId, session?.parentId ?? null));
  }, [files, scope, isSharedWorktree, sessionId, session?.parentId]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  /** A newer version from disk that arrived while the editor had unsaved changes. */
  const [externalDiff, setExternalDiff] = useState<FileDiff | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const isDirtyRef = useRef(false);
  const editorRef = useRef<CodeDiffEditorHandle>(null);
  const [mode, setMode] = useState<DiffMode>("split");
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
    setScope("own");
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

  // The selection follows the visible list: a file that left it (reverted, shelved, or hidden by the scope) gives way to the first one.
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
        if (isDirtyRef.current && result.newContent !== diff?.newContent) {
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

  const selectFile = async (path: string) => {
    if (path === selectedPath) return;
    if (isDirtyRef.current && !(await confirmDestructive("Discard unsaved changes in the current file?", "Discard"))) return;
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
        scope={isSharedWorktree ? { value: scope, hiddenCount: files.length - visibleFiles.length, includesParent: !!session?.parentId, onChange: setScope } : null}
        selectedPath={selectedPath}
        hasUnsavedChanges={isDirty}
        onSelect={selectFile}
        onContextMenu={openContextMenu}
        onWorktreeChanged={() => {
          setLocalVersion((version) => version + 1);
          noteWorktreeChanged(sessionId);
        }}
      />
      </Panel>
      <PaneSeparator />
      <Panel id="viewer" minSize={240} className="flex">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-(--line) px-3 py-2.5 text-[13px]">
          <span className="min-w-0 flex-1 truncate font-mono text-neutral-300">
            {selectedPath ?? "No file selected"}
            {isDirty ? <span className="ml-1 text-amber-300" title="Unsaved changes">●</span> : null}
          </span>
          <button
            type="button"
            disabled={!isDirty}
            onClick={() => editorRef.current?.save()}
            className={`${BUTTON_SM} ${isDirty ? "border border-amber-400/60 bg-amber-400/10 text-amber-200 hover:bg-amber-400/20" : SECONDARY}`}
            title="Save (⌘S inside the editor)"
          >
            Save
          </button>
          <button type="button" onClick={() => setMode(mode === "split" ? "unified" : "split")} className={SECONDARY_BUTTON_SM}>
            {mode === "split" ? "Split" : "Unified"}
          </button>
          <button
            type="button"
            disabled={!files.length}
            onClick={() => void commands.openChangedFilesDiffInWebstorm(sessionId)}
            className={SECONDARY_BUTTON_SM}
            title="Open all changed files in WebStorm's directory diff"
          >
            Diff in WebStorm
          </button>
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
              className={SECONDARY_BUTTON_SM}
            >
              Reload from disk
            </button>
            <button type="button" onClick={() => setExternalDiff(null)} className={GHOST_BUTTON_SM}>
              Keep my version
            </button>
          </div>
        ) : null}
        {error ? <p className="border-b border-(--line) px-3 py-2 text-[13px] text-red-400">{error}</p> : null}
        <div className="relative min-h-0 flex-1 bg-(--diff-bg)">
          {diff ? (
            <CodeDiffEditor
              key={`${sessionId}:${diff.path}`}
              ref={editorRef}
              sessionId={sessionId}
              diff={diff}
              mode={mode}
              fontSize={diffFontSize}
              lineHeight={diffLineHeight}
              fontFamily={diffFontFamily}
              onSave={saveFile}
              onDirtyChange={markDirty}
              onNavigate={(line, column) => void openInEditorWindow(sessionId, { path: diff.path, line, column })}
              onOpenInIde={(line, column) =>
                commands.openFileInWebstorm(sessionId, diff.path, line, column).catch((reason) => setError(String(reason)))
              }
              onOpenSubChat={subChat.open}
              onToggleSubChat={subChat.toggle}
            />
          ) : (
            <p className="p-3 text-[13px] text-neutral-500">
              {visibleFiles.length
                ? "Select a file."
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
          <button type="button" role="menuitem" onClick={() => revertFile(contextMenu.file)} className="block w-full rounded px-2 py-1 text-left text-red-300 hover:bg-(--row-hover)">
            {revertLabel(contextMenu.file)}
          </button>
        </div>
      ) : null}
    </PersistentGroup>
  );
}
