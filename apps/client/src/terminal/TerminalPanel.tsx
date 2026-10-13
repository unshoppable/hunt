import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal, type ITheme } from "@xterm/xterm";
import { commands } from "../ipc/commands";
import { listenTo } from "../ipc/events";
import { useSettingsStore } from "../state/settings";
import { HEADER_BAR } from "../ui/bars";
import { SECONDARY_BUTTON_XS } from "../ui/buttons";
import { Spinner } from "../ui/icons";
import { errorText } from "../ui/useLoad";
import { createResizeSync, decodeBase64, describeExit, encodeBinaryInput, encodeTextInput } from "./terminalStream";

/** Waits this long after the last size change before the remote programs learn the new size and redraw. */
const RESIZE_DELAY_MS = 80;

/** Line height for terminals: full-screen programs (tmux's borders and status line) need rows close to the font size. */
const LINE_HEIGHT = 1.2;

/** ANSI colors of VS Code's dark terminal theme, legible on the code pane's dark background. */
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

/** The xterm.js view of the panel and its fit addon. */
type TerminalView = { terminal: Terminal; fit: FitAddon };

/** Fits the view to its host; a hidden host has no size to fit to. */
function fitToHost(view: TerminalView, host: HTMLElement): void {
  if (!host.clientWidth || !host.clientHeight) return;
  view.fit.fit();
}

/**
 * A terminal on the VM of the remote session `sessionId`, attached to the tmux session in which the agent runs the
 * app's long-running processes (one window per process). It connects the first time the panel is shown and stays
 * connected while hidden, so switching tabs keeps it; it ends with the panel. Font family and size follow the code
 * pane's settings. While it has the focus, it takes every key it understands (Escape included) and stops the event, so
 * the window's shortcuts do not see them; ⌘C copies its selection, ⌘V pastes through the Edit menu, ⌘click opens a link.
 */
export function TerminalPanel({ sessionId, isVisible }: { sessionId: string; isVisible: boolean }) {
  const fontFamily = useSettingsStore((state) => state.panes.diff.fontFamily);
  const fontSize = useSettingsStore((state) => state.panes.diff.fontSize);
  const background = useSettingsStore((state) => state.panes.diff.background);
  const hostRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<TerminalView | null>(null);
  const [status, setStatus] = useState<TerminalStatus>(CONNECTING);
  /** Bumped by "Reconnect"; every value opens a new connection. */
  const [attempt, setAttempt] = useState(0);
  const wasVisibleRef = useRef(isVisible);
  const wantsFocusRef = useRef(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!isVisible || view || !host) return;
    const terminal = new Terminal({
      fontFamily,
      fontSize,
      lineHeight: LINE_HEIGHT,
      theme: terminalTheme(background),
      cursorBlink: true,
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
    terminal.open(host);
    const created = { terminal, fit };
    fitToHost(created, host);
    setView(created);
  }, [isVisible, view, fontFamily, fontSize, background]);

  useEffect(() => {
    if (!view) return;
    return () => view.terminal.dispose();
  }, [view]);

  useEffect(() => {
    const host = hostRef.current;
    if (!view || !host) return;
    view.terminal.options.fontFamily = fontFamily;
    view.terminal.options.fontSize = fontSize;
    view.terminal.options.theme = terminalTheme(background);
    fitToHost(view, host);
  }, [view, fontFamily, fontSize, background]);

  useEffect(() => {
    const host = hostRef.current;
    if (!view || !host) return;
    const observer = new ResizeObserver(() => fitToHost(view, host));
    observer.observe(host);
    return () => observer.disconnect();
  }, [view]);

  // Showing the tab focuses the terminal; a panel that mounts visible (another session opened) leaves the focus alone.
  useEffect(() => {
    if (isVisible && !wasVisibleRef.current) {
      wantsFocusRef.current = true;
    }
    wasVisibleRef.current = isVisible;
    if (!view || !wantsFocusRef.current) return;
    wantsFocusRef.current = false;
    view.terminal.focus();
  }, [isVisible, view]);

  useEffect(() => {
    if (!view) return;
    const { terminal } = view;
    const terminalId = crypto.randomUUID();
    const target = getCurrentWindow().label;
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
    const listeners = [
      listenTo(
        "terminal:output",
        (event) => {
          if (event.id === terminalId) {
            terminal.write(decodeBase64(event.data));
          }
        },
        { target },
      ),
      listenTo(
        "terminal:exit",
        (event) => {
          if (event.id !== terminalId) return;
          isOpen = false;
          setStatus({ state: "ended", message: describeExit(event.code) });
        },
        { target },
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
        await commands.openTerminal(sessionId, terminalId, size.cols, size.rows);
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
  }, [view, sessionId, attempt]);

  const reconnect = () => {
    setStatus(CONNECTING);
    setAttempt((current) => current + 1);
    view?.terminal.focus();
  };

  return (
    <div className={`h-full min-h-0 flex-col ${isVisible ? "flex" : "hidden"}`}>
      <div className={`${HEADER_BAR} gap-2 border-b border-(--line) px-4`}>
        <span className="text-sm font-medium text-neutral-100">Terminal</span>
        <span className="font-mono text-[13px] text-neutral-500">tmux app</span>
        {status.state === "connecting" ? <span className="text-[13px] text-neutral-400">Connecting…</span> : null}
        {status.state === "ended" ? <span className="min-w-0 truncate text-[13px] text-red-300" title={status.message}>{status.message}</span> : null}
        <span className="flex-1" />
        {status.state === "connecting" ? <Spinner /> : null}
        {status.state === "ended" ? (
          <button type="button" onClick={reconnect} className={SECONDARY_BUTTON_XS}>
            Reconnect
          </button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden p-2" style={{ background }}>
        <div ref={hostRef} className="h-full w-full" />
      </div>
    </div>
  );
}
