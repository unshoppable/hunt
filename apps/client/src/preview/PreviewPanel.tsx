import { useEffect } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { PreviewStatus } from "../ipc/types";
import { EMPTY_PREVIEW, usePreviewStore } from "../state/preview";
import { useHuntStore } from "../state/store";
import { HEADER_BAR } from "../ui/bars";
import { GHOST_BUTTON_XS, PRIMARY_BUTTON_XS, SECONDARY_BUTTON_XS } from "../ui/buttons";
import { Spinner } from "../ui/icons";

/** How often the panel asks what listens on the VM: often while it waits for the app to answer, rarely otherwise. */
const WAITING_POLL_MS = 3000;
const LIVE_POLL_MS = 10000;

const LINK = "min-w-0 truncate text-left font-mono text-[13px] text-sky-300 hover:underline";

/**
 * The Preview tab of a remote session: its main URL with whether the main port answers, and every port something
 * listens on with its URL. The agent starts the app itself; "Start the app" asks it to and opens the main URL once it
 * answers. The panel polls while the session is connected (a connected session proves a running VM) or while it waits
 * for the app, and only while the window is visible.
 */
export function PreviewPanel({ sessionId }: { sessionId: string }) {
  const session = useHuntStore((state) => state.sessions.find((candidate) => candidate.id === sessionId));
  const preview = usePreviewStore((state) => state.previews[sessionId] ?? EMPTY_PREVIEW);
  const { refresh, startApp, stopWaiting } = usePreviewStore.getState();
  const hasDomain = Boolean(session?.remote?.previewDomain);
  const isLive = Boolean(session?.isLive);
  const { status, opensWhenReady } = preview;

  useEffect(() => {
    if (!hasDomain) return;
    void refresh(sessionId);
    if (!isLive && !opensWhenReady) return;
    const timer = window.setInterval(
      () => {
        if (!document.hidden) {
          void refresh(sessionId);
        }
      },
      opensWhenReady ? WAITING_POLL_MS : LIVE_POLL_MS,
    );
    return () => window.clearInterval(timer);
  }, [sessionId, hasDomain, isLive, opensWhenReady, refresh]);

  if (!hasDomain) {
    return (
      <div className="flex h-full items-center justify-center px-8 text-center text-sm text-neutral-500">
        This session was handed off without a preview domain. Bring it back and hand it off again to open what it builds in the browser.
      </div>
    );
  }

  const state = describeStatus(status);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={`${HEADER_BAR} gap-2 border-b border-(--line) px-4`}>
        <span className="text-sm font-medium text-neutral-100">Preview</span>
        <span className={`min-w-0 truncate text-[13px] ${state.color}`}>{state.text}</span>
        <span className="flex-1" />
        {preview.isRefreshing ? <Spinner /> : null}
        {status ? (
          <button type="button" onClick={() => void openUrl(status.mainUrl)} className={PRIMARY_BUTTON_XS}>
            Open
          </button>
        ) : null}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4 text-sm text-neutral-300">
        {preview.error ? <p className="text-[13px] leading-snug break-words text-red-300">{preview.error}</p> : null}

        {status ? (
          <section className="flex flex-col gap-1">
            <div className="text-[13px] text-neutral-500">{status.main ? `Main port ${status.main}` : "Main URL"}</div>
            <button type="button" onClick={() => void openUrl(status.mainUrl)} className={LINK}>
              {status.mainUrl}
            </button>
          </section>
        ) : null}

        {status && !status.vmRunning ? (
          <p className="text-[13px] leading-snug text-neutral-500">The VM is off. The next prompt or opening a preview URL starts it.</p>
        ) : null}

        {status && status.listening.length ? (
          <section className="flex flex-col gap-1">
            <div className="text-[13px] text-neutral-500">Listening ports</div>
            {status.listening.map((port) => (
              <div key={port.port} className="flex min-w-0 items-center gap-3">
                <span className="w-14 shrink-0 font-mono text-[13px] text-neutral-200">{port.port}</span>
                <button type="button" onClick={() => void openUrl(port.url)} className={LINK}>
                  {port.url}
                </button>
              </div>
            ))}
          </section>
        ) : null}

        {status && !status.mainResponds && (status.main !== null || !status.vmRunning) ? (
          opensWhenReady ? (
            <div className="flex items-center gap-2 text-[13px] text-neutral-400">
              <Spinner />
              <span className="min-w-0 flex-1">Waiting for the app to answer, then the preview opens in the browser…</span>
              <button type="button" onClick={() => stopWaiting(sessionId)} className={GHOST_BUTTON_XS}>
                Stop waiting
              </button>
            </div>
          ) : (
            <div className="flex flex-col items-start gap-2">
              <button type="button" onClick={() => startApp(sessionId)} className={SECONDARY_BUTTON_XS}>
                Start the app
              </button>
              <p className="text-[13px] leading-snug text-neutral-500">
                Asks the agent to start the app as the repository describes it (HUNT.md, README) and opens the preview once its main port answers.
              </p>
            </div>
          )
        ) : null}

        <p className="text-[13px] leading-snug text-neutral-500">Diff, editor, graph and review work again once you bring the session back.</p>
      </div>
    </div>
  );
}

/** The preview's state as the header shows it. */
function describeStatus(status: PreviewStatus | null): { text: string; color: string } {
  if (!status) return { text: "…", color: "text-neutral-400" };
  if (!status.vmRunning) return { text: "VM off", color: "text-neutral-400" };
  if (status.mainResponds) return { text: "Responds", color: "text-green-300" };
  if (status.main === null) return { text: "No main port in hunt.json", color: "text-amber-300" };
  return { text: `Nothing answers on port ${status.main}`, color: "text-amber-300" };
}
