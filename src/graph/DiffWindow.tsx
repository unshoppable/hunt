import { useCallback, useEffect, useRef, useState } from "react";
import * as monaco from "monaco-editor";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useBackendEvents, usePaneStyles, useSettingsSync } from "../app/bootstrap";
import { SubChatPopover, useSubChatPopover } from "../chat/SubChatPopover";
import { CodeDiffEditor, type CodeDiffEditorHandle } from "../diff/CodeDiffEditor";
import { openInEditorWindow } from "../ide/editorWindows";
import { commands } from "../ipc/commands";
import { listenTo } from "../ipc/events";
import type { ChangeStat, DiffOpenRequest, FileDiff } from "../ipc/types";
import { useSettingsStore } from "../state/settings";
import { useHuntStore } from "../state/store";
import { HEADER_BAR } from "../ui/bars";
import { BUTTON_SM, SECONDARY, SECONDARY_BUTTON_SM } from "../ui/buttons";
import { confirmDestructive } from "../ui/confirm";
import { useSecondaryWindow } from "../ui/nativeWindow";
import { baseName } from "../ui/path";
import { errorText, useLoad } from "../ui/useLoad";
import { restoreWindowBounds } from "../ui/windowBounds";
import { ChangeBadge } from "./nodes";

type DiffMode = "split" | "unified";

/**
 * The root of a diff window. A window booted ahead of time (see diffWindows.ts) has no file yet and takes it as the
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
  // out, so nothing moves once it is visible (a hidden window does not re-layout its editors, see nativeWindow.ts).
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
 * The diff of one changed file as a window of its own (see diffWindows.ts), opened from a diagram node. The window
 * stays hidden until the diff is in, so it appears rendered. The right side is editable and saves with ⌘S or the
 * Save button; the traffic light, Escape and ⌘W close the window (after a confirmation while there are unsaved
 * edits). It closes itself once the file left the changelist (committed, reverted) or its session was removed.
 */
export function DiffWindow({ sessionId, path }: { sessionId: string; path: string }) {
  const session = useHuntStore((state) => state.sessions.find((candidate) => candidate.id === sessionId) ?? null);
  const refreshSessions = useHuntStore((state) => state.refreshSessions);
  const ensureChat = useHuntStore((state) => state.ensureChat);
  const editVersion = useHuntStore((state) => state.chats[sessionId]?.editVersion ?? 0);
  const noteWorktreeChanged = useHuntStore((state) => state.noteWorktreeChanged);
  const fontSize = useSettingsStore((state) => state.panes.diff.fontSize);
  const lineHeight = useSettingsStore((state) => state.panes.diff.lineHeight);
  const fontFamily = useSettingsStore((state) => state.panes.diff.fontFamily);

  const [isLoaded, setIsLoaded] = useState(false);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [stat, setStat] = useState<ChangeStat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<DiffMode>("split");
  const [isDirty, setIsDirty] = useState(false);
  const isDirtyRef = useRef(false);
  const editorRef = useRef<CodeDiffEditorHandle>(null);
  const subChat = useSubChatPopover();

  const markDirty = useCallback((value: boolean) => {
    isDirtyRef.current = value;
    setIsDirty(value);
  }, []);

  const close = useCallback(async () => {
    if (isDirtyRef.current && !(await confirmDestructive("Discard unsaved changes in this file?", "Discard"))) return;
    await getCurrentWindow().destroy();
  }, []);

  usePaneStyles();
  useSettingsSync();
  useBackendEvents();
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
          setError(null);
          setDiff((current) => (current ? { ...current, newContent: content } : current));
          markDirty(false);
          noteWorktreeChanged(sessionId);
        })
        .catch((reason) => setError(String(reason)));
    },
    [sessionId, path, markDirty, noteWorktreeChanged],
  );

  return (
    <div className="flex h-full flex-col bg-(--surface-inspector)">
      {/* The macOS traffic lights sit in this row (see ui/nativeWindow.ts), so it starts further right and drags the window. */}
      <div data-tauri-drag-region="" className={`${HEADER_BAR} gap-2 border-b border-(--line) pr-3 pl-23 text-xs`}>
        <span data-tauri-drag-region="" className="min-w-0 flex-1 truncate font-mono text-neutral-300" title={path}>
          {path}
          {isDirty ? <span className="ml-1 text-amber-300" title="Unsaved changes">●</span> : null}
        </span>
        {stat ? <ChangeBadge added={stat.added} removed={stat.removed} /> : null}
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
        <button type="button" onClick={() => void openInEditorWindow(sessionId, { path })} className={SECONDARY_BUTTON_SM} title="Open the file in the editor window">
          Open in editor
        </button>
      </div>
      {error ? <p className="border-b border-(--line) px-3 py-2 text-xs text-red-400">{error}</p> : null}
      <div className="relative min-h-0 flex-1 bg-(--diff-bg)">
        {diff ? (
          <CodeDiffEditor
            key={`${sessionId}:${diff.path}`}
            ref={editorRef}
            sessionId={sessionId}
            diff={diff}
            mode={mode}
            fontSize={fontSize}
            lineHeight={lineHeight}
            fontFamily={fontFamily}
            onSave={saveFile}
            onDirtyChange={markDirty}
            onNavigate={(line, column) => void openInEditorWindow(sessionId, { path, line, column })}
            onOpenInIde={(line, column) => commands.openFileInWebstorm(sessionId, path, line, column).catch((reason) => setError(String(reason)))}
            onOpenSubChat={subChat.open}
            onToggleSubChat={subChat.toggle}
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
