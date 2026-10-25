import { create } from "zustand";
import type { editor } from "monaco-editor";
import { isInsideFolder } from "../ui/path";
import {
  EMPTY_LAYOUT,
  activateTab,
  allPanes,
  closeTab,
  closeTabsWhere,
  findPane,
  firstPane,
  moveActiveTab,
  openInPane,
  openInRightSplit,
  panesShowing,
  withFreshIds,
  type Direction,
  type PaneLayout,
} from "./paneGrid";

/**
 * A caret position the pane shows once `path` is open in it; with `endLine`, the lines `line..endLine` are selected
 * instead. `nonce` tells repeated requests apart.
 */
export type PendingPosition = { paneId: string; path: string; line: number; column: number; endLine?: number; nonce: number };

/** A caret position in a file, with the pane it was seen in (1-based line and column). */
export type Location = { paneId: string; path: string; line: number; column: number };

/** Where navigation came from (`back`) and where it went before stepping back (`forward`), newest last. */
export type NavigationHistory = { back: Location[]; forward: Location[] };

export type IdeSession = {
  layout: PaneLayout;
  activePaneId: string | null;
  pendingPosition: PendingPosition | null;
  /** The project tree expands to and selects this file (⇧⌘2), or this folder, which it expands as well. */
  revealRequest: { path: string; nonce: number; isFolder?: boolean } | null;
  history: NavigationHistory;
};

export const EMPTY_IDE_SESSION: IdeSession = { layout: EMPTY_LAYOUT, activePaneId: null, pendingPosition: null, revealRequest: null, history: { back: [], forward: [] } };

/** Oldest locations fall off the back stack beyond this many. */
const HISTORY_LIMIT = 100;

let nonceCounter = 0;

/** The caret each pane last reported, by `sessionId:paneId`; kept outside the store so cursor moves do not re-render. */
const carets = new Map<string, Location>();

/** Records where the caret of `paneId` is; the next navigation away from there can be undone with `navigateBack`. */
export function noteCaret(sessionId: string, location: Location): void {
  carets.set(`${sessionId}:${location.paneId}`, location);
}

/** Caret, selection and scroll position of each pane's tabs, by `sessionId:paneId:path`; outside the store so scrolling does not re-render. */
const viewStates = new Map<string, editor.ICodeEditorViewState>();

const viewStateListeners = new Set<(sessionId: string) => void>();

function viewStateKey(sessionId: string, paneId: string, path: string): string {
  return `${sessionId}:${paneId}:${path}`;
}

/** Records how `path` looked in `paneId`; the pane shows it that way when the tab comes back (`null` forgets it). */
export function noteViewState(sessionId: string, paneId: string, path: string, viewState: editor.ICodeEditorViewState | null): void {
  if (viewState) {
    viewStates.set(viewStateKey(sessionId, paneId, path), viewState);
  } else {
    viewStates.delete(viewStateKey(sessionId, paneId, path));
  }
  for (const listener of viewStateListeners) {
    listener(sessionId);
  }
}

export function viewStateOf(sessionId: string, paneId: string, path: string): editor.ICodeEditorViewState | null {
  return viewStates.get(viewStateKey(sessionId, paneId, path)) ?? null;
}

/** Calls `listener` with the session whose view states `noteViewState` changed; returns the unsubscribe function. */
export function onViewStateChange(listener: (sessionId: string) => void): () => void {
  viewStateListeners.add(listener);
  return () => viewStateListeners.delete(listener);
}

/** A session's editor as it can be stored and brought back: its layout and the view states of its tabs by pane id, then path. */
export type IdeSnapshot = { layout: PaneLayout; activePaneId: string | null; viewStates: Record<string, Record<string, editor.ICodeEditorViewState>> };

export function snapshotOf(sessionId: string, session: IdeSession): IdeSnapshot {
  const paneViewStates = allPanes(session.layout).map((pane) => {
    const tabStates = pane.tabs.flatMap((path) => {
      const viewState = viewStateOf(sessionId, pane.id, path);
      return viewState ? [[path, viewState] as const] : [];
    });
    return [pane.id, Object.fromEntries(tabStates)] as const;
  });
  return { layout: session.layout, activePaneId: session.activePaneId, viewStates: Object.fromEntries(paneViewStates) };
}

function caretOf(sessionId: string, paneId: string | null): Location | null {
  return paneId ? (carets.get(`${sessionId}:${paneId}`) ?? null) : null;
}

function isSameSpot(a: Location | null, b: Location | null): boolean {
  return !!a && !!b && a.path === b.path && a.line === b.line;
}

function pushed(stack: Location[], location: Location): Location[] {
  if (isSameSpot(stack[stack.length - 1] ?? null, location)) return stack;
  return [...stack, location].slice(-HISTORY_LIMIT);
}

/**
 * The layout with `path` shown: a pane already holding the file as a tab is reused (the preferred pane first),
 * otherwise the file opens as a new tab in the preferred pane, in the active pane, or in a first pane.
 */
/** The session with tabs closed in `layout`; the first pane becomes active when the active one closed. */
function withLayout(session: IdeSession, layout: PaneLayout): IdeSession {
  const activePaneId = session.activePaneId && findPane(layout, session.activePaneId) ? session.activePaneId : (layout.rows[0]?.panes[0]?.id ?? null);
  return { ...session, layout, activePaneId };
}

function show(session: IdeSession, path: string, preferredPaneId: string | null): { layout: PaneLayout; paneId: string } {
  const holders = panesShowing(session.layout, path);
  const holder = holders.find((pane) => pane.id === preferredPaneId) ?? holders.find((pane) => pane.id === session.activePaneId) ?? holders[0];
  const paneId = holder?.id ?? (preferredPaneId && findPane(session.layout, preferredPaneId) ? preferredPaneId : session.activePaneId);
  return openInPane(session.layout, paneId, path);
}

function pendingFor(paneId: string, path: string, line: number | undefined, column: number | undefined, fallback: PendingPosition | null, endLine?: number): PendingPosition | null {
  if (!line) return fallback;
  nonceCounter += 1;
  return { paneId, path, line, column: column ?? 1, endLine, nonce: nonceCounter };
}

export type OpenOptions = {
  /** Target pane; the active pane when omitted or gone. */
  paneId?: string | null;
  /** 1-based caret position to reveal after opening. */
  line?: number;
  column?: number;
  /** Selects the lines `line..endLine` (inclusive) instead of placing the caret. */
  endLine?: number;
  /** Opens the file right of the target pane instead of in it (WebStorm's "Open in Right Split"). */
  inRightSplit?: boolean;
};

type IdeState = {
  sessions: Record<string, IdeSession>;
  openFile: (sessionId: string, path: string, options?: OpenOptions) => void;
  activatePane: (sessionId: string, paneId: string) => void;
  activateTab: (sessionId: string, paneId: string, path: string) => void;
  closeTab: (sessionId: string, paneId: string, path: string) => void;
  /** Closes every tab of a deleted file, or of every file below a deleted folder. */
  closeTabsOf: (sessionId: string, deletedPath: string) => void;
  /** Closes every tab of every pane (⇧⌘W). */
  closeAllTabs: (sessionId: string) => void;
  /** Returns to where the last navigation came from (the mouse's back button, ⌘[); `navigateForward` undoes that. */
  navigateBack: (sessionId: string) => void;
  navigateForward: (sessionId: string) => void;
  /** Moves the active tab of the active pane like WebStorm's "Move Right/Left/Up/Down". */
  moveActiveTab: (sessionId: string, direction: Direction) => void;
  clearPendingPosition: (sessionId: string, nonce: number) => void;
  revealActiveFile: (sessionId: string) => void;
  /** Expands the project tree to the folder `path`, expands the folder and selects it. */
  revealFolder: (sessionId: string, path: string) => void;
  /** Brings back a stored editor under fresh pane ids; a session the store holds already keeps what it shows. */
  restoreSession: (sessionId: string, snapshot: IdeSnapshot) => void;
};

export const useIdeStore = create<IdeState>((set, get) => {
  function update(sessionId: string, updater: (session: IdeSession) => IdeSession) {
    set((state) => ({ sessions: { ...state.sessions, [sessionId]: updater(state.sessions[sessionId] ?? EMPTY_IDE_SESSION) } }));
  }

  return {
    sessions: {},

    openFile: (sessionId, path, options = {}) => {
      update(sessionId, (session) => {
        const target = options.paneId === undefined ? session.activePaneId : options.paneId;
        const { layout, paneId } = options.inRightSplit ? openInRightSplit(session.layout, target, path) : show(session, path, target);
        const pendingPosition = pendingFor(paneId, path, options.line, options.column, session.pendingPosition, options.endLine);
        // Leaving a file, or jumping to a position, is a navigation the back button undoes.
        const origin = caretOf(sessionId, target);
        const isNavigation = !!origin && (origin.path !== path || !!options.line);
        const history = isNavigation ? { back: pushed(session.history.back, origin), forward: [] } : session.history;
        return { ...session, layout, activePaneId: paneId, pendingPosition, history };
      });
    },

    navigateBack: (sessionId) => {
      update(sessionId, (session) => step(sessionId, session, "back"));
    },

    navigateForward: (sessionId) => {
      update(sessionId, (session) => step(sessionId, session, "forward"));
    },

    activatePane: (sessionId, paneId) => {
      update(sessionId, (session) => (session.activePaneId === paneId || !findPane(session.layout, paneId) ? session : { ...session, activePaneId: paneId }));
    },

    activateTab: (sessionId, paneId, path) => {
      update(sessionId, (session) => ({ ...session, layout: activateTab(session.layout, paneId, path), activePaneId: paneId }));
    },

    closeTab: (sessionId, paneId, path) => {
      update(sessionId, (session) => withLayout(session, closeTab(session.layout, paneId, path)));
    },

    closeTabsOf: (sessionId, deletedPath) => {
      update(sessionId, (session) => withLayout(session, closeTabsWhere(session.layout, (path) => path === deletedPath || isInsideFolder(path, deletedPath))));
    },

    closeAllTabs: (sessionId) => {
      update(sessionId, (session) => ({ ...session, layout: EMPTY_LAYOUT, activePaneId: null, pendingPosition: null, history: { back: [], forward: [] } }));
    },

    moveActiveTab: (sessionId, direction) => {
      const session = get().sessions[sessionId];
      if (!session?.activePaneId) return;
      const moved = moveActiveTab(session.layout, session.activePaneId, direction);
      if (!moved) return;
      update(sessionId, (current) => ({ ...current, layout: moved.layout, activePaneId: moved.paneId }));
    },

    clearPendingPosition: (sessionId, nonce) => {
      update(sessionId, (session) => (session.pendingPosition?.nonce === nonce ? { ...session, pendingPosition: null } : session));
    },

    revealActiveFile: (sessionId) => {
      update(sessionId, (session) => {
        const pane = session.activePaneId ? findPane(session.layout, session.activePaneId) : null;
        if (!pane?.activePath) return session;
        nonceCounter += 1;
        return { ...session, revealRequest: { path: pane.activePath, nonce: nonceCounter } };
      });
    },

    revealFolder: (sessionId, path) => {
      nonceCounter += 1;
      update(sessionId, (session) => ({ ...session, revealRequest: { path, nonce: nonceCounter, isFolder: true } }));
    },

    restoreSession: (sessionId, snapshot) => {
      if (get().sessions[sessionId]) return;
      const { layout, paneIds } = withFreshIds(snapshot.layout);
      for (const [storedPaneId, tabStates] of Object.entries(snapshot.viewStates)) {
        const paneId = paneIds.get(storedPaneId);
        if (!paneId) continue;
        for (const [path, viewState] of Object.entries(tabStates)) {
          viewStates.set(viewStateKey(sessionId, paneId, path), viewState);
        }
      }
      const activePaneId = (snapshot.activePaneId && paneIds.get(snapshot.activePaneId)) || (firstPane(layout)?.id ?? null);
      update(sessionId, () => ({ ...EMPTY_IDE_SESSION, layout, activePaneId }));
    },
  };
});

/**
 * Moves one step through the history: the newest location of `direction` is shown (in the pane it was seen in
 * when that still holds the file) and the current caret goes onto the opposite stack, so the step can be undone.
 */
function step(sessionId: string, session: IdeSession, direction: "back" | "forward"): IdeSession {
  const stack = session.history[direction];
  const location = stack[stack.length - 1];
  if (!location) return session;
  const opposite = direction === "back" ? "forward" : "back";
  const current = caretOf(sessionId, session.activePaneId);
  const history = { ...session.history, [direction]: stack.slice(0, -1), [opposite]: current ? pushed(session.history[opposite], current) : session.history[opposite] };
  const { layout, paneId } = show(session, location.path, location.paneId);
  const pendingPosition = pendingFor(paneId, location.path, location.line, location.column, session.pendingPosition);
  return { ...session, layout, activePaneId: paneId, pendingPosition, history };
}

export function useIdeSession(sessionId: string): IdeSession {
  return useIdeStore((state) => state.sessions[sessionId] ?? EMPTY_IDE_SESSION);
}
