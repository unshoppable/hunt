import { useCallback, useEffect, useRef, useState } from "react";
import * as monaco from "monaco-editor";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { SubChatPopover } from "../chat/sub-chat/SubChatPopover";
import { useSubChatPopover } from "../chat/sub-chat/sub-chat-popover.hook";
import { CodeDiffEditor, type CodeDiffEditorHandle } from "./CodeDiffEditor";
import { useFileIconUrl } from "../ui/file-icons/file-icons.hook";
import { workspaceFor } from "../ide/documents/documents.service";
import { openInEditorWindow } from "../ide/editor-window.utils";
import { commands } from "../ipc/commands";
import { listenTo } from "../ipc/events";
import type { ChangeStat, DiffOpenRequest, FileDiff } from "./diff.types";
import { useReviewedPullRequest } from "../review/review-comments.hook";
import { useSettingsStore } from "../settings/settings.store";
import { useHuntStore } from "../sessions/hunt.store";
import { HEADER_BAR } from "../ui/bars.constants";
import { SECONDARY_BUTTON_XS } from "../ui/buttons.constants";
import { useSecondaryWindow } from "../ui/secondary-window.hook";
import { baseName } from "../common/path/path.utils";
import { useLoad } from "../ui/load.hook";
import { errorText } from "../ui/error-text.utils";
import { restoreWindowBounds } from "../ui/window-bounds.utils";
import { ChangeBadge } from "../graph/DiagramNodes";

type DiffMode = "split" | "unified";

/**
 * The root of a diff window. A window booted ahead of time (see diff-window.utils.ts) has no file yet and takes it as the
 * `diff:open` event; a window opened for a file has it in its URL. It reports `diff:ready` once it listens and knows
 * the sessions, so the opener delivers a request that arrived while the page was loading. While it waits it starts
 * the TypeScript worker, so the semantic colors of the first file are not held up by its load.
 */
export function DiffWindowHost({ initialRequest }: { initialRequest: DiffOpenRequest | null }) {
  const refreshSessions = useHuntStore((state) => state.refreshSessions);
  const [request, setRequest] = useState(initialRequest);
  const [isLoaded, setIsLoaded] = useState(false);
  const [isListening, setIsListening] = useState(false);

  // A failed session list is reported by the diff view once a request arrives; the ready handshake must not stall on it.
  useEffect(() => {
    void refreshSessions()
      .catch(() => undefined)
      .finally(() => setIsLoaded(true));
  }, [refreshSessions]);

  useEffect(() => {
    void monaco.typescript.getTypeScriptWorker().catch(() => {});
  }, []);

  // The window was created with the bounds remembered back then; it takes the current ones before its content lays
  // out, so nothing moves once it is visible (a hidden window does not re-layout its editors, see native-window.utils.ts).
  useEffect(() => {
    const subscription = listenTo("diff:open", (next) => void restoreWindowBounds("diff").finally(() => setRequest(next)), { target: getCurrentWindow().label });
    void subscription.then(() => setIsListening(true));
    return () => void subscription.then((unlisten) => unlisten());
  }, []);

  useEffect(() => {
    if (!isLoaded || !isListening) return;
    void emit("diff:ready", { label: getCurrentWindow().label });
  }, [isLoaded, isListening]);

  if (!request) return null;
  return <DiffWindow key={`${request.sessionId}:${request.path}`} sessionId={request.sessionId} path={request.path} />;
}

/**
 * The diff of one changed file as a window of its own (see diff-window.utils.ts), opened from a diagram node. The window
 * stays hidden until the diff is in, so it appears rendered. The right side is editable; ⌘S saves it and every other
 * file with unsaved edits. A blue dot after the path marks unsaved edits. The traffic light, Escape and ⌘W close the window (after a confirmation
 * while there are unsaved edits). It closes itself once the file left the changelist (committed, reverted) or its session was removed.
 */
export function DiffWindow({ sessionId, path }: { sessionId: string; path: string }) {
  const session = useHuntStore((state) => state.sessions.find((candidate) => candidate.id === sessionId) ?? null);
  const worktreePath = session?.worktreePath;
  const refreshSessions = useHuntStore((state) => state.refreshSessions);
  const ensureChat = useHuntStore((state) => state.ensureChat);
  const editVersion = useHuntStore((state) => state.chats[sessionId]?.editVersion ?? 0);
  const noteWorktreeChanged = useHuntStore((state) => state.noteWorktreeChanged);
  const pullRequest = useReviewedPullRequest(sessionId);
  const fontSize = useSettingsStore((state) => state.panes.diff.fontSize);
  const lineHeight = useSettingsStore((state) => state.panes.diff.lineHeight);
  const fontFamily = useSettingsStore((state) => state.panes.diff.fontFamily);
  const fileIconUrl = useFileIconUrl();

  const [isLoaded, setIsLoaded] = useState(false);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [stat, setStat] = useState<ChangeStat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<DiffMode>("split");
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const isDirtyRef = useRef(false);
  const editorRef = useRef<CodeDiffEditorHandle>(null);
  const subChat = useSubChatPopover();
  const headerRef = useRef<HTMLDivElement>(null);
  /** Offset from the header's left edge of the right side's line numbers in split mode; null in unified mode. */
  const [lineNumbersLeft, setLineNumbersLeft] = useState<number | null>(null);
  const alignWithLineNumbers = useCallback((clientX: number | null) => {
    const header = headerRef.current;
    setLineNumbersLeft(clientX === null || !header ? null : clientX - header.getBoundingClientRect().left);
  }, []);

  const markDirty = useCallback((value: boolean) => {
    isDirtyRef.current = value;
    setIsDirty(value);
  }, []);

  // Unsaved edits live in the shared worktree document and survive the window.
  const close = useCallback(() => getCurrentWindow().destroy(), []);

  useSecondaryWindow("diff", close, { isReady: !!diff || !!error });

  useEffect(() => {
    void refreshSessions()
      .catch((reason) => setError(errorText(reason)))
      .finally(() => setIsLoaded(true));
  }, [refreshSessions]);

  // Worktree-change events only bump the edit version of sessions with a chat record.
  useEffect(() => ensureChat(sessionId), [ensureChat, sessionId]);

  // The title names the file and its session (Mission Control, the Window menu); a window booted ahead of time has a placeholder.
  const sessionTitle = session?.title;
  useEffect(() => {
    void getCurrentWindow().setTitle(`${baseName(path)} – ${sessionTitle ?? "Diff"}`);
  }, [path, sessionTitle]);

  // Unsaved edits survive reloads triggered by other views; the editor keeps its content until a save or close.
  useLoad(
    () => (isDirtyRef.current ? Promise.resolve(null) : commands.readFileDiff(sessionId, path)),
    {
      onValue: (result) => {
        if (!result) return;
        setDiff(result);
        setError(null);
      },
      onError: (reason) => setError(errorText(reason)),
    },
    [sessionId, path, editVersion],
  );

  // The badge follows the file's current line counts; a file that left the changelist closes its window.
  useLoad(
    () => commands.changeStats(sessionId),
    {
      onValue: (stats) => {
        const current = stats.find((candidate) => candidate.path === path);
        if (!current) {
          void getCurrentWindow().destroy();
          return;
        }
        setStat(current);
      },
      onError: (reason) => setError(errorText(reason)),
    },
    [sessionId, path, editVersion],
  );

  // The window is pointless once its session is gone (removed together with its worktree).
  const hasSession = !!session;
  useEffect(() => {
    if (!isLoaded || hasSession) return;
    void getCurrentWindow().destroy();
  }, [isLoaded, hasSession]);

  const saveFile = useCallback(
    (content: string) => {
      commands
        .writeFile(sessionId, path, content)
        .then(() => {
          setDiff((current) => (current ? { ...current, newContent: content } : current));
          markDirty(false);
          // ⌘S saves the other files with unsaved edits too, as in the editor tab.
          return worktreePath ? workspaceFor(sessionId, worktreePath).saveAll(path) : undefined;
        })
        .then(() => setError(null))
        .catch((reason) => setError(String(reason)))
        .finally(() => noteWorktreeChanged(sessionId));
    },
    [sessionId, worktreePath, path, markDirty, noteWorktreeChanged],
  );

  return (
    <div className="flex h-full flex-col bg-(--surface-inspector)">
      {/* The macOS traffic lights sit in this row (see ui/nativeWindow.ts), so it starts further right and drags the
          window. In split mode the file comment button and the line counts start where the right side's line numbers do. */}
      <div ref={headerRef} data-tauri-drag-region="" className={`${HEADER_BAR} border-b border-(--line) pr-3 text-xs`}>
        <span
          data-tauri-drag-region=""
          className="flex min-w-0 items-center pr-2 pl-23 font-mono text-neutral-300"
          style={lineNumbersLeft === null ? { flex: "1 1 0%" } : { width: lineNumbersLeft, flexShrink: 0 }}
          title={path}
        >
          <img data-tauri-drag-region="" src={fileIconUrl(path)} alt="" draggable={false} className="mr-1.5 size-4 shrink-0" />
          <span data-tauri-drag-region="" className="truncate">{path}</span>
          {isDirty ? <span data-tauri-drag-region="" className="ml-1.5 size-2 shrink-0 rounded-full bg-blue-400" title="Unsaved changes" /> : null}
        </span>
        <div data-tauri-drag-region="" className={`flex items-center gap-2 self-stretch ${lineNumbersLeft === null ? "" : "flex-1"}`}>
          {pullRequest ? (
            <button type="button" onClick={() => editorRef.current?.commentOnFile()} className={SECONDARY_BUTTON_XS} title="Comment on the whole file; it goes out with your review">
              Comment on file
            </button>
          ) : null}
          {stat ? <ChangeBadge added={stat.added} removed={stat.removed} /> : null}
          {lineNumbersLeft === null ? null : <span data-tauri-drag-region="" className="flex-1 self-stretch" />}
          <button type="button" onClick={() => setMode(mode === "split" ? "unified" : "split")} className={SECONDARY_BUTTON_XS}>
            {mode === "split" ? "Split" : "Unified"}
          </button>
          <button type="button" onClick={() => setIsCollapsed(!isCollapsed)} className={SECONDARY_BUTTON_XS} title={isCollapsed ? "Show every unchanged line" : "Collapse every unchanged stretch"}>
            {isCollapsed ? "Expand all" : "Collapse unchanged"}
          </button>
          <button
            type="button"
            onClick={() => void openInEditorWindow(sessionId, { path, revealFirstChange: true })}
            className={SECONDARY_BUTTON_XS}
            title="Open the file in the editor window at its first change"
          >
            Open in editor
          </button>
        </div>
      </div>
      {error ? <p className="border-b border-(--line) px-3 py-2 text-xs text-red-400">{error}</p> : null}
      <div data-ide-root="" className="relative min-h-0 flex-1 bg-(--diff-bg)">
        {/* The editable side shares the worktree document, which needs the session's worktree path. */}
        {diff && session ? (
          <CodeDiffEditor
            key={`${sessionId}:${diff.path}`}
            ref={editorRef}
            sessionId={sessionId}
            diff={diff}
            mode={mode}
            collapseUnchanged={isCollapsed}
            fontSize={fontSize}
            lineHeight={lineHeight}
            fontFamily={fontFamily}
            onSave={saveFile}
            onDirtyChange={markDirty}
            onNavigate={(line, column, name) => void openInEditorWindow(sessionId, { path, line, column, definitionOf: name })}
            onOpenInIde={(line, column) => commands.openFileInWebstorm(sessionId, path, line, column).catch((reason) => setError(String(reason)))}
            onOpenUsage={(usage) => void openInEditorWindow(sessionId, { path: usage.path, line: usage.line, column: usage.column })}
            onError={setError}
            onOpenSubChat={subChat.open}
            onToggleSubChat={subChat.toggle}
            onLineNumbersLeftChange={alignWithLineNumbers}
          />
        ) : (
          <p className="p-3 text-xs text-neutral-500">Loading diff…</p>
        )}
      </div>
      {subChat.shown ? (
        <SubChatPopover key={subChat.shown.key} parentSessionId={sessionId} request={subChat.shown.request} subSessionId={subChat.shown.subSessionId} onClose={subChat.close} />
      ) : null}
    </div>
  );
}
