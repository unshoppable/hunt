import { useEffect, useMemo, useRef, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useBackendEvents, usePaneStyles, useSettingsSync } from "../app/bootstrap";
import { listenTo } from "../ipc/events";
import type { EditorOpenRequest } from "../ipc/types";
import { useHuntStore } from "../state/store";
import { useSecondaryWindow } from "../ui/nativeWindow";
import { workspaceFor } from "./documents";
import { FileSearchDialog, useFileSearchShortcut } from "./FileSearchDialog";
import { IdePanel } from "./IdePanel";
import { EMPTY_IDE_SESSION, useIdeSession, useIdeStore } from "./ideStore";
import { allPanes } from "./paneGrid";
import { HEADER_BAR } from "../ui/bars";

/**
 * The built-in editor as a window of its own (see editorWindows.ts), opened by ⌘click in the diff or "Go to File"
 * while the inspector shows another tab. It boots hidden, usually ahead of its first request, and appears with the
 * first file; it keeps its own tabs, takes further files as the `editor:open` event, asks before unsaved edits are
 * lost and, closed on ⌘W, Escape or the traffic light, only hides so the next request is instant.
 * It destroys itself once its session was removed.
 */
export function EditorWindow({ sessionId, initialRequest }: { sessionId: string; initialRequest: EditorOpenRequest | null }) {
  const session = useHuntStore((state) => state.sessions.find((candidate) => candidate.id === sessionId) ?? null);
  const refreshSessions = useHuntStore((state) => state.refreshSessions);
  const ensureChat = useHuntStore((state) => state.ensureChat);
  const openFile = useIdeStore((state) => state.openFile);
  const closeAllTabs = useIdeStore((state) => state.closeAllTabs);
  const ide = useIdeSession(sessionId);
  const openPaths = useMemo(() => [...new Set(allPanes(ide.layout).flatMap((pane) => pane.tabs))], [ide.layout]);
  const [isFileSearchOpen, setIsFileSearchOpen] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);
  const [isListening, setIsListening] = useState(false);
  /** Number of open requests so far; the window shows itself (again) with each one. */
  const [requestCount, setRequestCount] = useState(initialRequest ? 1 : 0);

  usePaneStyles();
  useSettingsSync();
  useBackendEvents();
  useFileSearchShortcut(() => setIsFileSearchOpen(true));

  // A failed session list leaves `session` empty, which destroys the window below instead of keeping it hidden.
  useEffect(() => {
    void refreshSessions()
      .catch(() => undefined)
      .finally(() => setIsLoaded(true));
  }, [refreshSessions]);

  // Worktree-change events only bump the edit version of sessions with a chat record.
  useEffect(() => ensureChat(sessionId), [ensureChat, sessionId]);

  useEffect(() => {
    if (initialRequest) {
      openFile(sessionId, initialRequest.path, { line: initialRequest.line, column: initialRequest.column, inRightSplit: initialRequest.inRightSplit });
    }
    const subscription = listenTo(
      "editor:open",
      (request) => {
        openFile(sessionId, request.path, { line: request.line, column: request.column, inRightSplit: request.inRightSplit });
        setRequestCount((count) => count + 1);
      },
      { target: getCurrentWindow().label },
    );
    void subscription.then(() => setIsListening(true));
    return () => void subscription.then((unlisten) => unlisten());
  }, [sessionId, initialRequest, openFile]);

  // The window that opened this one queues requests until the page listens and knows its sessions (see editorWindows.ts).
  useEffect(() => {
    if (!isLoaded || !isListening) return;
    void emit("editor:ready", { label: getCurrentWindow().label });
  }, [isLoaded, isListening]);

  /** Hides the window and drops its tabs and dialogs; unsaved edits are discarded after confirmation or keep the window open. */
  const closeWindow = async () => {
    const { dirtyPaths } = useIdeStore.getState().sessions[sessionId] ?? EMPTY_IDE_SESSION;
    if (dirtyPaths.length && !(await workspaceFor(sessionId, session?.worktreePath ?? "").discardIfConfirmed(dirtyPaths))) return;
    closeAllTabs(sessionId);
    setIsFileSearchOpen(false);
    await getCurrentWindow().hide();
  };
  const closeWindowRef = useRef(closeWindow);
  closeWindowRef.current = closeWindow;

  // Escape reaches the window only when nothing in the editor took it (a selection, the find widget, a popover). The
  // window does not show itself on readiness: it starts hidden and appears with each request (see below).
  useSecondaryWindow("editor", closeWindow, { isReady: false });

  // The window starts hidden (see editorWindows.ts) and appears with its first requested file; it is pointless once
  // its session is gone (removed together with its worktree).
  const hasSession = !!session;
  useEffect(() => {
    if (!isLoaded) return;
    if (!hasSession) {
      void getCurrentWindow().destroy();
      return;
    }
    if (!requestCount) return;
    void getCurrentWindow().show().then(() => getCurrentWindow().setFocus());
  }, [isLoaded, hasSession, requestCount]);

  if (!session) return null;

  return (
    <div className="flex h-full flex-col bg-(--surface-inspector)">
      {/* The macOS traffic lights sit in this row (see editorWindows.ts), so it starts further right and drags the window. */}
      <div data-tauri-drag-region="" className={`${HEADER_BAR} gap-2 border-b border-(--line) pr-3 pl-23 text-sm`}>
        <span data-tauri-drag-region="" className="shrink-0 font-semibold tracking-wide text-neutral-300">Editor</span>
        <span data-tauri-drag-region="" className="truncate text-neutral-500">{session.title}</span>
      </div>
      <div className="min-h-0 flex-1">
        <IdePanel sessionId={sessionId} onCloseEmpty={() => void closeWindowRef.current()} />
      </div>
      {isFileSearchOpen ? (
        <FileSearchDialog
          sessionId={sessionId}
          openPaths={openPaths}
          onClose={() => setIsFileSearchOpen(false)}
          onOpen={(path, line, inRightSplit) => openFile(sessionId, path, { line: line ?? undefined, inRightSplit })}
        />
      ) : null}
    </div>
  );
}
