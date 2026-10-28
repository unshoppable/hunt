import { create } from "zustand";
import { persist } from "zustand/middleware";
import { onViewStateChange, snapshotOf, useIdeStore, type IdeSnapshot } from "../ide/ide.store";
import { PaneLayout } from "../ide/pane-layout.value-object";

/**
 * Views of the inspector pane: the changelist diff, the built-in editor, the component diagram, the reviewed pull
 * request, the checks of hunt.json or the terminals, and for a remote session also its preview and its VM's desktop.
 */
export type RightTab = "diff" | "git" | "editor" | "graph" | "pullRequest" | "preview" | "desktop" | "checks" | "terminal";

/** What the inspector of a session showed when it was left: the tab, the file selected in the Diff tab and the Editor tab's panes. */
export type InspectorView = { tab?: RightTab; diffPath?: string | null; editor?: IdeSnapshot };

/** How many sessions' views are kept; the least recently changed fall off beyond this. */
export const SESSION_VIEW_LIMIT = 200;

/** The editors are stored once their changes rested this long. */
const EDITOR_SAVE_DELAY_MS = 500;

type SessionViewState = {
  /** By session id, least recently changed first. */
  views: Record<string, InspectorView>;
  /** The tab picked last; a session without a remembered tab shows it. */
  lastTab: RightTab;
  /** Picks `tab` for the session `sessionId`, or for the next session without one when `sessionId` is `null`. */
  setTab: (sessionId: string | null, tab: RightTab) => void;
  setDiffPath: (sessionId: string, path: string | null) => void;
  setEditor: (sessionId: string, editor: IdeSnapshot) => void;
};

/** `views` with the entry of `sessionId` updated by `change` and moved to the end, cut to `SESSION_VIEW_LIMIT` entries. */
export function withSessionView(views: Record<string, InspectorView>, sessionId: string, change: Partial<InspectorView>): Record<string, InspectorView> {
  const { [sessionId]: current, ...others } = views;
  const kept = Object.entries(others).slice(-(SESSION_VIEW_LIMIT - 1));
  return Object.fromEntries([...kept, [sessionId, { ...current, ...change }]]);
}

/** An inspector view as storage holds it: its editor's layout is plain data until `mergeSessionViews` reads it. */
type StoredInspectorView = Omit<InspectorView, "editor"> & { editor?: Omit<IdeSnapshot, "layout"> & { layout: unknown } };

/** Layers the stored state over `current`, the layout of each stored editor read back into a `PaneLayout`. */
function mergeSessionViews(persisted: unknown, current: SessionViewState): SessionViewState {
  const stored = persisted as (Omit<Partial<SessionViewState>, "views"> & { views?: Record<string, StoredInspectorView> }) | undefined;
  if (!stored?.views) return { ...current, ...stored, views: current.views };
  const views = Object.entries(stored.views).map(([sessionId, { editor, ...view }]): [string, InspectorView] => [
    sessionId,
    editor ? { ...view, editor: { ...editor, layout: PaneLayout.fromStored(editor.layout) } } : view,
  ]);
  return { ...current, ...stored, views: Object.fromEntries(views) };
}

/**
 * The inspector of every session as it was left; survives restarts under `hunt-session-views`. Only the main window
 * writes it: every window holds its own copy, and a write stores the whole copy.
 */
export const useSessionViewStore = create<SessionViewState>()(
  persist(
    (set) => ({
      views: {},
      lastTab: "diff",
      setTab: (sessionId, tab) =>
        set((state) => ({ lastTab: tab, views: sessionId && state.views[sessionId]?.tab !== tab ? withSessionView(state.views, sessionId, { tab }) : state.views })),
      setDiffPath: (sessionId, path) =>
        set((state) => (state.views[sessionId]?.diffPath === path ? state : { views: withSessionView(state.views, sessionId, { diffPath: path }) })),
      setEditor: (sessionId, editor) => set((state) => ({ views: withSessionView(state.views, sessionId, { editor }) })),
    }),
    { name: "hunt-session-views", merge: mergeSessionViews },
  ),
);

/** The tab the inspector shows for `sessionId`. */
export function useRightTab(sessionId: string | null): RightTab {
  return useSessionViewStore((state) => (sessionId && state.views[sessionId]?.tab) || state.lastTab);
}

/**
 * Brings the stored editor of every session back into the ide store and stores each change of a session's panes or of
 * their caret and scroll positions from then on. The main window calls it once; returns the function that stops it.
 */
export function rememberEditors(): () => void {
  const { restoreSession } = useIdeStore.getState();
  for (const [sessionId, view] of Object.entries(useSessionViewStore.getState().views)) {
    if (view.editor) {
      restoreSession(sessionId, view.editor);
    }
  }

  const changedIds = new Set<string>();
  let timer: number | null = null;
  const save = () => {
    if (timer !== null) {
      window.clearTimeout(timer);
    }
    timer = null;
    const { sessions } = useIdeStore.getState();
    const { setEditor } = useSessionViewStore.getState();
    for (const sessionId of changedIds) {
      const session = sessions[sessionId];
      if (session) {
        setEditor(sessionId, snapshotOf(sessionId, session));
      }
    }
    changedIds.clear();
  };
  const noteChange = (sessionId: string) => {
    changedIds.add(sessionId);
    timer ??= window.setTimeout(save, EDITOR_SAVE_DELAY_MS);
  };

  const stopLayouts = useIdeStore.subscribe((state, previous) => {
    for (const [sessionId, session] of Object.entries(state.sessions)) {
      const before = previous.sessions[sessionId];
      if (session.layout !== before?.layout || session.activePaneId !== before.activePaneId) {
        noteChange(sessionId);
      }
    }
  });
  const stopViewStates = onViewStateChange(noteChange);
  window.addEventListener("beforeunload", save);
  return () => {
    stopLayouts();
    stopViewStates();
    window.removeEventListener("beforeunload", save);
    save();
  };
}
