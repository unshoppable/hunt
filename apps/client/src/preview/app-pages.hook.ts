import { useEffect, useState } from "react";
import { commands } from "../ipc/commands";
import type { AppPage } from "./preview.types";
import { isSamePages } from "./app-pages.utils";

/** How often the inspector asks which frontend services of the shown local session run. */
const POLL_MS = 5000;

const NO_PAGES: AppPage[] = [];

/**
 * The frontend services of the local session `sessionId` that run, read at once and every `POLL_MS` while the window
 * is visible; none for `null` (no session shown, or a remote one) and until the first read lands. A failed read counts
 * as none.
 */
export function useAppPages(sessionId: string | null): AppPage[] {
  const [read, setRead] = useState<{ sessionId: string; pages: AppPage[] } | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    let isCurrent = true;
    const land = (pages: AppPage[]) => {
      if (!isCurrent) return;
      setRead((previous) => (previous?.sessionId === sessionId && isSamePages(previous.pages, pages) ? previous : { sessionId, pages }));
    };
    const load = () => {
      if (document.hidden) return;
      commands.browserPages(sessionId).then(land, () => land(NO_PAGES));
    };
    load();
    const timer = window.setInterval(load, POLL_MS);
    return () => {
      isCurrent = false;
      window.clearInterval(timer);
    };
  }, [sessionId]);

  return read && read.sessionId === sessionId ? read.pages : NO_PAGES;
}
