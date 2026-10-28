import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { commands } from "../ipc/commands";
import { listenTo } from "../ipc/events";
import type { TerminalTarget } from "./terminal.types";
import { SECONDARY_BUTTON_XS } from "../ui/buttons.constants";
import { Spinner } from "../ui/Icons";
import { errorText } from "../ui/error-text.utils";
import { createResizeSync, decodeBase64, describeExit, encodeBinaryInput, encodeTextInput } from "./terminal-stream.utils";
import { useXterm } from "./xterm.hook";

/** Waits this long after the last size change before the remote programs learn the new size and redraw. */
const RESIZE_DELAY_MS = 80;

/** Hides the cursor of a service's log: it takes no input, so a cursor would suggest that it does. */
const HIDE_CURSOR = "\u001b[?25l";

type TerminalStatus = { state: "connecting" } | { state: "open" } | { state: "ended"; message: string };

const CONNECTING: TerminalStatus = { state: "connecting" };

/**
 * One terminal of the session `sessionId`, showing `target`: a service's log on the VM of a remote session, read-only,
 * or a tmux window on the VM or this Mac, which takes input. It connects the first time it is shown and stays connected
 * while hidden, so switching tabs keeps it; it ends when it unmounts. Each new value of `focusRequest` focuses it once while it is visible. Font,
 * line height and background follow the Terminal pane's settings. While it has the focus, it takes every key it understands (Escape
 * included) and stops the event, so the window's shortcuts do not see them; ⌘C copies its selection, a mouse selection
 * in a tmux window reaches the clipboard too, ⌘V pastes through the Edit menu, ⌘click opens a link.
 */
export function TerminalView({
  sessionId,
  target,
  isVisible,
  focusRequest,
}: {
  sessionId: string;
  target: TerminalTarget;
  isVisible: boolean;
  focusRequest: number;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  /** Set once the view was first shown; its terminal exists from then on until the view unmounts. */
  const [isStarted, setIsStarted] = useState(isVisible);
  const [status, setStatus] = useState<TerminalStatus>(CONNECTING);
  /** Bumped by "Reconnect"; every value opens a new connection. */
  const [attempt, setAttempt] = useState(0);
  const handledFocusRef = useRef(0);
  /** The service's name or the window's ID; with `windowMachine` it names the process, whose target object changes every poll. */
  const process = target.kind === "service" ? target.name : target.id;
  /** The machine of a window; null for a service. */
  const windowMachine = target.kind === "window" ? target.machine : null;
  const isReadOnly = !windowMachine;
  const { view, background } = useXterm(hostRef, { isStarted, isReadOnly });

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
      setStatus((current) => (current.state === "ended" ? current : { state: "ended", message: errorText(reason) }));
    };
    const resizes = createResizeSync((size) => void commands.resizeTerminal(terminalId, size.cols, size.rows).catch(reportFailure), RESIZE_DELAY_MS);
    const send = (data: string) => {
      if (!isOpen) return;
      void commands.writeTerminal(terminalId, data).catch(reportFailure);
    };
    terminal.reset();
    if (!windowMachine) {
      terminal.write(HIDE_CURSOR);
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
          setStatus({ state: "ended", message: describeExit(event.code) });
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
        const processTarget: TerminalTarget = windowMachine ? { kind: "window", id: process, machine: windowMachine } : { kind: "service", name: process };
        await commands.openTerminal(sessionId, terminalId, processTarget, size.cols, size.rows);
        if (isDisposed) {
          void commands.closeTerminal(terminalId).catch((reason) => console.error("failed to close the terminal", reason));
          return;
        }
        isOpen = true;
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
  }, [view, sessionId, process, windowMachine, attempt]);

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
              <span className="text-neutral-400">Connecting…</span>
            </>
          ) : (
            <>
              <span className="min-w-0 truncate text-red-300" title={status.message}>
                {status.message}
              </span>
              <span className="flex-1" />
              <button type="button" onClick={reconnect} className={SECONDARY_BUTTON_XS}>
                Reconnect
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
