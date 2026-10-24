import { useEffect, useRef, useState, type RefObject } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal, type ITheme } from "@xterm/xterm";
import { useSettingsStore } from "../state/settings";
import { parseClipboardWrite } from "./terminalStream";

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

/** The xterm.js view and its fit addon. */
export type XtermView = { terminal: Terminal; fit: FitAddon };

/** Fits the view to its host; a hidden host has no size to fit to. */
function fitToHost(view: XtermView, host: HTMLElement): void {
  if (!host.clientWidth || !host.clientHeight) return;
  view.fit.fit();
}

/**
 * An xterm.js view in `hostRef` once `isStarted`, disposed when the component unmounts; `null` before. It follows the
 * Terminal pane's font, line height and background and the size of its host. ⌘C copies its selection, an OSC 52
 * selection of tmux reaches the clipboard, ⌘click opens a link. A read-only view takes no input and shows no cursor
 * blink. Returns the view and the background, which the host's padding should share.
 */
export function useXterm(hostRef: RefObject<HTMLDivElement | null>, { isStarted, isReadOnly }: { isStarted: boolean; isReadOnly: boolean }) {
  const fontFamily = useSettingsStore((state) => state.panes.terminal.fontFamily);
  const fontSize = useSettingsStore((state) => state.panes.terminal.fontSize);
  const lineHeight = useSettingsStore((state) => state.panes.terminal.lineHeight);
  const background = useSettingsStore((state) => state.panes.terminal.background);
  const [view, setView] = useState<XtermView | null>(null);
  /** The appearance a new terminal starts with; an effect below keeps a running one in line with the settings. */
  const appearanceRef = useRef({ fontFamily, fontSize, lineHeight, background });

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
  }, [hostRef, isStarted, isReadOnly]);

  useEffect(() => {
    const host = hostRef.current;
    if (!view || !host) return;
    view.terminal.options.fontFamily = fontFamily;
    view.terminal.options.fontSize = fontSize;
    view.terminal.options.lineHeight = lineHeight;
    view.terminal.options.theme = terminalTheme(background);
    fitToHost(view, host);
  }, [hostRef, view, fontFamily, fontSize, lineHeight, background]);

  useEffect(() => {
    const host = hostRef.current;
    if (!view || !host) return;
    const observer = new ResizeObserver(() => fitToHost(view, host));
    observer.observe(host);
    return () => observer.disconnect();
  }, [hostRef, view]);

  return { view, background };
}
