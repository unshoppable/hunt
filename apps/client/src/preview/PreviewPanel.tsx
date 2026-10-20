import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { PreviewService } from "../ipc/types";
import { EMPTY_PREVIEW, usePreviewStore } from "../state/preview";
import { useHuntStore } from "../state/store";
import { HEADER_BAR } from "../ui/bars";
import { GHOST_BUTTON_XS, SECONDARY_BUTTON_XS } from "../ui/buttons";
import { Spinner } from "../ui/icons";
import { errorText } from "../ui/useLoad";
import { describePreview, describeService, hasRespondingService, isServiceInUse, offersStart, shouldPollFast, type Tone } from "./services";

/** How often the panel asks the VM about its services: often while it waits for one to start, rarely otherwise. */
const WAITING_POLL_MS = 3000;
const LIVE_POLL_MS = 10000;

/** Size of the tab's text below the header bar from the Preview pane settings; other sizes are relative to it. */
const PANE_TEXT = "text-(length:--preview-font-size)";
const LINK = "min-w-0 truncate text-left font-mono text-sky-300 hover:underline";
const SECTION_LABEL = "text-neutral-500";
const HINT = "leading-snug text-neutral-500";

const TONE_COLOR: Record<Tone, string> = {
  ok: "text-green-300",
  pending: "text-neutral-300",
  warning: "text-amber-300",
  error: "text-red-300",
  idle: "text-neutral-400",
};

/**
 * The Preview tab of a remote session: the services of the repository's hunt.json that are in use with their state,
 * whether they answer and their URL, and the other ports something listens on. The agent starts the services itself;
 * "Start the app" asks it to. The panel polls while the session is connected (a connected session proves a running
 * VM), while it waits for a service to answer or while one starts, and only while the window is visible.
 */
export function PreviewPanel({ sessionId }: { sessionId: string }) {
  const session = useHuntStore((state) => state.sessions.find((candidate) => candidate.id === sessionId));
  const preview = usePreviewStore((state) => state.previews[sessionId] ?? EMPTY_PREVIEW);
  const { refresh, startApp, stopWaiting } = usePreviewStore.getState();
  const [openError, setOpenError] = useState<string | null>(null);
  const hasDomain = Boolean(session?.remote?.previewDomain);
  const isLive = Boolean(session?.isLive);
  const { status, awaitingStart } = preview;
  const isPollingFast = shouldPollFast(status, awaitingStart);

  useEffect(() => {
    if (!hasDomain) return;
    void refresh(sessionId);
    if (!isLive && !isPollingFast) return;
    const timer = window.setInterval(
      () => {
        if (!document.hidden) {
          void refresh(sessionId);
        }
      },
      isPollingFast ? WAITING_POLL_MS : LIVE_POLL_MS,
    );
    return () => window.clearInterval(timer);
  }, [sessionId, hasDomain, isLive, isPollingFast, refresh]);

  if (!hasDomain) {
    return (
      <div className={`flex h-full items-center justify-center px-8 text-center text-neutral-500 ${PANE_TEXT}`}>
        This session was handed off without a preview domain. Bring it back and hand it off again to open what it builds in the browser.
      </div>
    );
  }

  function open(url: string) {
    setOpenError(null);
    void openUrl(url).catch((reason) => setOpenError(errorText(reason)));
  }

  const summary = describePreview(status);
  const isWaiting = awaitingStart && !(status && hasRespondingService(status));
  const shownServices = status ? status.services.filter((service) => isServiceInUse(service, status.vmRunning)) : [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={`${HEADER_BAR} gap-2 border-b border-(--line) px-4`}>
        <span className="text-sm font-medium text-neutral-100">Preview</span>
        <span className={`min-w-0 truncate text-[13px] ${TONE_COLOR[summary.tone]}`}>{summary.text}</span>
        <span className="flex-1" />
        {preview.isRefreshing ? <Spinner /> : null}
      </div>

      <div className={`flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4 text-neutral-300 ${PANE_TEXT}`}>
        {preview.error ? <p className="leading-snug break-words text-red-300">{preview.error}</p> : null}
        {openError ? <p className="leading-snug break-words text-red-300">{openError}</p> : null}

        {status && !status.vmRunning ? (
          <p className={HINT}>The VM is off. The next prompt or opening a preview URL that is not public starts it.</p>
        ) : null}

        {status && status.vmRunning && !status.services.length ? (
          <p className={HINT}>
            {status.listening.length
              ? "hunt.json declares no services; below are the ports something listens on."
              : "hunt.json declares no services, and nothing listens on a port yet."}
          </p>
        ) : null}

        {status && shownServices.length ? (
          <section className="flex flex-col gap-3">
            <div className={SECTION_LABEL}>Services</div>
            {shownServices.map((service) => (
              <ServiceRow key={service.name} service={service} isVmRunning={status.vmRunning} onOpen={open} />
            ))}
          </section>
        ) : null}

        {isWaiting ? (
          <div className="flex items-center gap-2 text-neutral-400">
            <Spinner />
            <span className="min-w-0 flex-1">Waiting for a service to answer…</span>
            <button type="button" onClick={() => stopWaiting(sessionId)} className={GHOST_BUTTON_XS}>
              Stop waiting
            </button>
          </div>
        ) : status && offersStart(status) ? (
          <div className="flex flex-col items-start gap-2">
            <button type="button" onClick={() => startApp(sessionId)} className={SECONDARY_BUTTON_XS}>
              Start the app
            </button>
            <p className={HINT}>
              Asks the agent to start the services this task needs, as the repository's hunt.agent.md describes. Started services come back after a VM restart.
            </p>
          </div>
        ) : null}

        {status?.listening.length ? (
          <section className="flex flex-col gap-1">
            <div className={SECTION_LABEL}>{status.services.length ? "Other ports" : "Listening ports"}</div>
            {status.listening.map((port) => (
              <div key={port.port} className="flex min-w-0 items-center gap-3">
                <span className="w-[4.3em] shrink-0 font-mono text-neutral-200">{port.port}</span>
                <button type="button" onClick={() => open(port.url)} className={LINK}>
                  {port.url}
                </button>
              </div>
            ))}
          </section>
        ) : null}

        <p className={HINT}>Diff, editor, graph and review work again once you bring the session back.</p>
      </div>
    </div>
  );
}

/** A service of hunt.json: a dot that is green while it answers, its name, port, state and URL. */
function ServiceRow({ service, isVmRunning, onOpen }: { service: PreviewService; isVmRunning: boolean; onOpen: (url: string) => void }) {
  const state = describeService(service, isVmRunning);
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <div className="flex min-w-0 items-center gap-2">
        <span
          className={`size-2 shrink-0 rounded-full ${service.responds ? "bg-green-400" : "bg-neutral-600"}`}
          title={service.responds ? "Answers" : "Does not answer"}
        />
        <span className="min-w-0 truncate font-mono text-neutral-100">{service.name}</span>
        <span className="shrink-0 font-mono text-[0.92em] text-neutral-500">{service.port}</span>
        <span className="flex-1" />
        <span
          className={`shrink-0 ${TONE_COLOR[state.tone]}`}
          title={service.state === "failed" ? `Its log is /home/agent/logs/${service.name}.log on the VM` : undefined}
        >
          {state.text}
        </span>
      </div>
      <button type="button" onClick={() => onOpen(service.url)} className={`${LINK} max-w-full self-start pl-4`}>
        {service.url}
      </button>
    </div>
  );
}
