import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal, type ITheme } from "@xterm/xterm";
import { commands } from "../ipc/commands";
import { listenTo } from "../ipc/events";
import type { TerminalTarget } from "../ipc/types";
import { useSettingsStore } from "../state/settings";
import { SECONDARY_BUTTON_XS } from "../ui/buttons";
import { Spinner } from "../ui/icons";
import { errorText } from "../ui/useLoad";
import { createResizeSync, decodeBase64, describeExit, encodeBinaryInput, encodeTextInput, parseClipboardWrite } from "./terminalStream";

/** Waits this long after the last size change before the remote programs learn the new size and redraw. */
const RESIZE_DELAY_MS = 80;

/** Hides the cursor of a service's log: it takes no input, so a cursor would suggest that it does. */
const HIDE_CURSOR = "\u001b[?25l";

/** OSC 52, the escape sequence with which tmux puts a mouse selection on the clipboard. */
const CLIPBOARD_OSC = 52;

/** ANSI colors of VS Code's dark terminal theme, legible on the terminal's dark background. */
const ANSI_COLORS: ITheme = {
  black: "#000000",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#e5e5e5",
};

function terminalTheme(background: string): ITheme {
  return { ...ANSI_COLORS, background, foreground: "#d4d4d4", cursor: "#d4d4d4", cursorAccent: background, selectionBackground: "#4c8bf580" };
}

type TerminalStatus = { state: "connecting" } | { state: "open" } | { state: "ended"; message: string };

const CONNECTING: TerminalStatus = { state: "connecting" };

/** The xterm.js view and its fit addon. */
type XtermView = { terminal: Terminal; fit: FitAddon };

/** Fits the view to its host; a hidden host has no size to fit to. */
function fitToHost(view: XtermView, host: HTMLElement): void {
  if (!host.clientWidth || !host.clientHeight) return;
  view.fit.fit();
}

/**
 * One terminal on the VM of the remote session `sessionId`, showing `target`: a service's log, read-only, or a tmux
 * window, which takes input. It connects the first time it is shown and stays connected while hidden, so switching
 * tabs keeps it; it ends when it unmounts. Each new value of `focusRequest` focuses it once while it is visible. Font,
 * line height and background follow the Terminal pane's settings. While it has the focus, it takes every key it understands (Escape
 * included) and stops the event, so the window's shortcuts do not see them; ⌘C copies its selection, a mouse selection
 * in a tmux window reaches the clipboard too, ⌘V pastes through the Edit menu, ⌘click opens a link.
 */
export function TerminalView({ sessionId, target, isVisible, focusRequest }: { sessionId: string; target: TerminalTarget; isVisible: boolean; focusRequest: number }) {
  const fontFamily = useSettingsStore((state) => state.panes.terminal.fontFamily);
  const fontSize = useSettingsStore((state) => state.panes.terminal.fontSize);
  const lineHeight = useSettingsStore((state) => state.panes.terminal.lineHeight);
  const background = useSettingsStore((state) => state.panes.terminal.background);
  const hostRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<XtermView | null>(null);
  /** Set once the view was first shown; its terminal exists from then on until the view unmounts. */
  const [isStarted, setIsStarted] = useState(isVisible);
  /** The appearance a new terminal starts with; an effect below keeps a running one in line with the settings. */
  const appearanceRef = useRef({ fontFamily, fontSize, lineHeight, background });
  const [status, setStatus] = useState<TerminalStatus>(CONNECTING);
  /** Bumped by "Reconnect"; every value opens a new connection. */
  const [attempt, setAttempt] = useState(0);
  const handledFocusRef = useRef(0);
  const kind = target.kind;
  /** The service's name or the window's ID; with `kind` it names the process, whose target object changes every poll. */
  const process = target.kind === "service" ? target.name : target.id;
  const isReadOnly = kind === "service";

  useEffect(() => {
    if (isVisible) {
      setIsStarted(true);
    }
  }, [isVisible]);

  useEffect(() => {
    appearanceRef.current = { fontFamily, fontSize, lineHeight, background };
  }, [fontFamily, fontSize, lineHeight, background]);

  // The effect that creates the terminal also disposes it, so that a second run (React's development mode) leaves no
  // orphan terminal in the host.
  useEffect(() => {
    const host = hostRef.current;
    if (!isStarted || !host) return;
    const appearance = appearanceRef.current;
    const terminal = new Terminal({
      fontFamily: appearance.fontFamily,
      fontSize: appearance.fontSize,
      lineHeight: appearance.lineHeight,
      theme: terminalTheme(appearance.background),
      cursorBlink: !isReadOnly,
      disableStdin: isReadOnly,
      macOptionClickForcesSelection: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(
      new WebLinksAddon((event, uri) => {
        if (!event.metaKey) return;
        void openUrl(uri).catch((reason) => console.error("failed to open the link", reason));
      }),
    );
    // WebKit's Copy menu item only sees DOM selections, so ⌘C copies the terminal's selection itself.
    terminal.attachCustomKeyEventHandler((event) => {
      const isCopy = event.type === "keydown" && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "c";
      if (!isCopy || !terminal.hasSelection()) return true;
      event.preventDefault();
      void navigator.clipboard.writeText(terminal.getSelection()).catch((reason) => console.error("failed to copy the terminal selection", reason));
      return false;
    });
    terminal.parser.registerOscHandler(CLIPBOARD_OSC, (data) => {
      const text = parseClipboardWrite(data);
      if (text !== null) {
        void navigator.clipboard.writeText(text).catch((reason) => console.error("failed to copy the tmux selection", reason));
      }
      return true;
    });
    terminal.open(host);
    const created = { terminal, fit };
    fitToHost(created, host);
    setView(created);
    return () => {
      setView(null);
      terminal.dispose();
    };
  }, [isStarted, isReadOnly]);

  useEffect(() => {
    const host = hostRef.current;
    if (!view || !host) return;
    view.terminal.options.fontFamily = fontFamily;
    view.terminal.options.fontSize = fontSize;
    view.terminal.options.lineHeight = lineHeight;
    view.terminal.options.theme = terminalTheme(background);
    fitToHost(view, host);
  }, [view, fontFamily, fontSize, lineHeight, background]);

  useEffect(() => {
    const host = hostRef.current;
    if (!view || !host) return;
    const observer = new ResizeObserver(() => fitToHost(view, host));
    observer.observe(host);
    return () => observer.disconnect();
  }, [view]);

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
    const shown: TerminalTarget = kind === "service" ? { kind, name: process } : { kind, id: process };
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
    if (kind === "service") {
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
        await commands.openTerminal(sessionId, terminalId, shown, size.cols, size.rows);
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
  }, [view, sessionId, kind, process, attempt]);

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
