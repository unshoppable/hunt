import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { commands } from "../ipc/commands";
import { listenTo } from "../ipc/events";
import type { LocalTerminalTarget, TerminalTarget } from "../ipc/types";
import { SECONDARY_BUTTON_XS } from "../ui/buttons";
import { Spinner } from "../ui/icons";
import { errorText } from "../ui/useLoad";
import { createResizeSync, decodeBase64, describeExit, describeLocalExit, encodeBinaryInput, encodeTextInput } from "./terminalStream";
import { useXterm } from "./useXterm";

/** Waits this long after the last size change before the remote programs learn the new size and redraw. */
const RESIZE_DELAY_MS = 80;

/** Hides the cursor of a service's log: it takes no input, so a cursor would suggest that it does. */
const HIDE_CURSOR = "\u001b[?25l";

type TerminalStatus = { state: "connecting" } | { state: "open" } | { state: "ended"; message: string; isSuccess?: boolean };

const CONNECTING: TerminalStatus = { state: "connecting" };

/** The command line a script's terminal starts with, dimmed, as the npm it runs would print it. */
function scriptHeader(script: string): string {
  return `\u001b[2m$ npm run ${script}\u001b[0m\r\n`;
}

/**
 * One terminal of the session `sessionId`, showing `target`: on the VM of a remote session a service's log, read-only,
 * or a tmux window, which takes input; in a local session a login shell or a package.json script run by npm. It connects the first time it is shown and stays connected while hidden, so switching
 * tabs keeps it; it ends when it unmounts. Each new value of `focusRequest` focuses it once while it is visible. Font,
 * line height and background follow the Terminal pane's settings. While it has the focus, it takes every key it understands (Escape
 * included) and stops the event, so the window's shortcuts do not see them; ⌘C copies its selection, a mouse selection
 * in a tmux window reaches the clipboard too, ⌘V pastes through the Edit menu, ⌘click opens a link.
 */
export function TerminalView({
  sessionId,
  target,
  isVisible,
  focusRequest,
  onRunningChange,
  onExit,
}: {
  sessionId: string;
  target: TerminalTarget | LocalTerminalTarget;
  isVisible: boolean;
  focusRequest: number;
  /** Told when the program starts and when it ends or the terminal fails. */
  onRunningChange?: (isRunning: boolean) => void;
  /** Told when the program ended by itself. */
  onExit?: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  /** Set once the view was first shown; its terminal exists from then on until the view unmounts. */
  const [isStarted, setIsStarted] = useState(isVisible);
  const [status, setStatus] = useState<TerminalStatus>(CONNECTING);
  /** Bumped by "Reconnect"; every value opens a new connection. */
  const [attempt, setAttempt] = useState(0);
  const handledFocusRef = useRef(0);
  const kind = target.kind;
  /** The service's name, the window's ID or the shell's folder; with `kind` it names the process, whose target object changes every poll. */
  const process = target.kind === "service" ? target.name : target.kind === "window" ? target.id : target.directory;
  const script = target.kind === "shell" ? target.script : null;
  const isReadOnly = kind === "service";
  const callbacksRef = useRef({ onRunningChange, onExit });
  const { view, background } = useXterm(hostRef, { isStarted, isReadOnly });

  useEffect(() => {
    callbacksRef.current = { onRunningChange, onExit };
  }, [onRunningChange, onExit]);

  useEffect(() => {
    if (isVisible) {
      setIsStarted(true);
    }
  }, [isVisible]);

  useEffect(() => {
    if (!view || !isVisible || focusRequest === handledFocusRef.current) return;
    handledFocusRef.current = focusRequest;
    view.terminal.focus();
  }, [view, isVisible, focusRequest]);

  useEffect(() => {
    if (!view) return;
    const { terminal } = view;
    const terminalId = crypto.randomUUID();
    const windowLabel = getCurrentWindow().label;
    let isDisposed = false;
    let isOpen = false;
    const reportFailure = (reason: unknown) => {
      if (isDisposed) return;
      isOpen = false;
      callbacksRef.current.onRunningChange?.(false);
      setStatus((current) => (current.state === "ended" ? current : { state: "ended", message: errorText(reason) }));
    };
    const resizes = createResizeSync((size) => void commands.resizeTerminal(terminalId, size.cols, size.rows).catch(reportFailure), RESIZE_DELAY_MS);
    const send = (data: string) => {
      if (!isOpen) return;
      void commands.writeTerminal(terminalId, data).catch(reportFailure);
    };
    terminal.reset();
    if (kind === "service") {
      terminal.write(HIDE_CURSOR);
    }
    if (script) {
      terminal.write(scriptHeader(script));
    }
    const listeners = [
      listenTo(
        "terminal:output",
        (event) => {
          if (event.id === terminalId) {
            terminal.write(decodeBase64(event.data));
          }
        },
        { target: windowLabel },
      ),
      listenTo(
        "terminal:exit",
        (event) => {
          if (event.id !== terminalId) return;
          isOpen = false;
          const isShell = kind === "shell";
          setStatus({ state: "ended", message: isShell ? describeLocalExit(event.code) : describeExit(event.code), isSuccess: isShell && event.code === 0 });
          callbacksRef.current.onRunningChange?.(false);
          callbacksRef.current.onExit?.();
        },
        { target: windowLabel },
      ),
    ];
    const subscriptions = [
      terminal.onData((text) => send(encodeTextInput(text))),
      terminal.onBinary((binary) => send(encodeBinaryInput(binary))),
      terminal.onResize((size) => {
        if (isOpen) {
          resizes.push(size);
        }
      }),
    ];
    // Both listeners must be in place before the backend starts the terminal, whose first output may come at once.
    void Promise.all(listeners)
      .then(async () => {
        if (isDisposed) return;
        const size = { cols: terminal.cols, rows: terminal.rows };
        resizes.markSent(size);
        if (kind === "shell") {
          await commands.openLocalTerminal(sessionId, terminalId, process, script, size.cols, size.rows);
        } else {
          await commands.openTerminal(sessionId, terminalId, kind === "service" ? { kind, name: process } : { kind, id: process }, size.cols, size.rows);
        }
        if (isDisposed) {
          void commands.closeTerminal(terminalId).catch((reason) => console.error("failed to close the terminal", reason));
          return;
        }
        isOpen = true;
        callbacksRef.current.onRunningChange?.(true);
        resizes.push({ cols: terminal.cols, rows: terminal.rows });
        setStatus((current) => (current.state === "connecting" ? { state: "open" } : current));
      })
      .catch(reportFailure);
    return () => {
      isDisposed = true;
      resizes.cancel();
      for (const subscription of subscriptions) {
        subscription.dispose();
      }
      for (const listener of listeners) {
        void listener.then((unlisten) => unlisten());
      }
      void commands.closeTerminal(terminalId).catch((reason) => console.error("failed to close the terminal", reason));
    };
  }, [view, sessionId, kind, process, script, attempt]);

  const reconnect = () => {
    setStatus(CONNECTING);
    setAttempt((current) => current + 1);
    view?.terminal.focus();
  };

  return (
    <div className={`h-full min-h-0 flex-col ${isVisible ? "flex" : "hidden"}`}>
      {status.state === "open" ? null : (
        <div className="flex h-[36px] shrink-0 items-center gap-2 border-b border-(--line) px-3 text-[13px]">
          {status.state === "connecting" ? (
            <>
              <Spinner />
              <span className="text-neutral-400">{kind === "shell" ? "Starting…" : "Connecting…"}</span>
            </>
          ) : (
            <>
              <span className={`min-w-0 truncate ${status.isSuccess ? "text-emerald-300" : "text-red-300"}`} title={status.message}>
                {status.message}
              </span>
              <span className="flex-1" />
              <button type="button" onClick={reconnect} className={SECONDARY_BUTTON_XS}>
                {script ? "Run again" : kind === "shell" ? "Restart" : "Reconnect"}
              </button>
            </>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-hidden p-2" style={{ background }}>
        <div ref={hostRef} className="h-full w-full" />
      </div>
    </div>
  );
}
