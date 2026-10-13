import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useFollowScroll } from "../chat/useFollowScroll";
import { EMPTY_LOG } from "./previewLogs";
import { EMPTY_PREVIEW, usePreviewStore } from "../state/preview";
import { configuredPreviewDomain, useSettingsStore } from "../state/settings";
import { useHuntStore } from "../state/store";
import { HEADER_BAR } from "../ui/bars";
import { GHOST_BUTTON_XS, PRIMARY_BUTTON_XS, SECONDARY_BUTTON_XS, TAB_ACTIVE, TAB_BUTTON_SM, TAB_INACTIVE } from "../ui/buttons";
import { Spinner } from "../ui/icons";

/** How often the panel asks for the preview's state: often while it starts, rarely once it is ready. */
const STARTING_POLL_MS = 2000;
const READY_POLL_MS = 10000;
const LOG_POLL_MS = 2000;

const STATE_COLORS: Record<string, string> = {
  ready: "text-green-300",
  failed: "text-red-300",
  degraded: "text-amber-300",
  crashed: "text-red-300",
};

/**
 * The right pane of a remote session: its preview on the VM. Shows the state, the main URL, the processes with their
 * URLs and a restart each, the services, and the log of the selected process or of the setup steps. It polls while the
 * session is connected (a connected session proves a running VM) and the window is visible.
 */
export function PreviewPanel({ sessionId }: { sessionId: string }) {
  const session = useHuntStore((state) => state.sessions.find((candidate) => candidate.id === sessionId));
  const domain = useSettingsStore((state) => configuredPreviewDomain(state.remote));
  const preview = usePreviewStore((state) => state.previews[sessionId] ?? EMPTY_PREVIEW);
  const { open, stop, restart, refresh, loadLog } = usePreviewStore.getState();
  const [logName, setLogName] = useState("setup");
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLPreElement>(null);
  useFollowScroll(scrollRef, contentRef, `${sessionId}:${logName}`);

  const status = preview.status;
  const isLive = Boolean(session?.isLive);
  const isActive = Boolean(status?.active);
  const isReady = status?.state === "ready";

  useEffect(() => {
    if (!domain) return;
    void refresh(sessionId);
    if (!isLive) return;
    let timer = 0;
    const poll = () => {
      timer = window.setTimeout(() => {
        if (!document.hidden) void refresh(sessionId);
        poll();
      }, isReady || !isActive ? READY_POLL_MS : STARTING_POLL_MS);
    };
    poll();
    return () => window.clearTimeout(timer);
  }, [sessionId, domain, isLive, isReady, isActive, refresh]);

  useEffect(() => {
    if (!domain || !isLive || !isActive) return;
    void loadLog(sessionId, logName);
    const timer = window.setInterval(() => {
      if (!document.hidden) void loadLog(sessionId, logName);
    }, LOG_POLL_MS);
    return () => window.clearInterval(timer);
  }, [sessionId, domain, isLive, isActive, logName, loadLog]);

  if (!domain) {
    return (
      <div className="flex h-full items-center justify-center px-8 text-center text-sm text-neutral-500">
        This session runs on the VM {session?.remote?.vm.instance}. Set a preview domain in Settings → Remote VM to open what it builds in the browser.
      </div>
    );
  }

  const log = preview.logs[logName] ?? EMPTY_LOG;
  const logNames = ["setup", ...(status?.processes ?? []).filter((process) => !process.optional || process.state !== "stopped").map((process) => process.name)];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={`${HEADER_BAR} gap-2 border-b border-(--line) px-4`}>
        <span className="text-sm font-medium text-neutral-100">Preview</span>
        <span className={`text-[13px] ${STATE_COLORS[status?.state ?? ""] ?? "text-neutral-400"}`}>{status ? describeState(status.state, status.step) : "…"}</span>
        <span className="flex-1" />
        {preview.isBusy ? <Spinner /> : null}
        <button type="button" onClick={() => void open(sessionId)} disabled={preview.isBusy} className={PRIMARY_BUTTON_XS}>
          Open in browser
        </button>
        {isActive ? (
          <button type="button" onClick={() => void stop(sessionId)} disabled={preview.isBusy} className={SECONDARY_BUTTON_XS}>
            Stop
          </button>
        ) : null}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4 text-sm text-neutral-300">
        {preview.error ? <p className="text-[13px] leading-snug break-words text-red-300">{preview.error}</p> : null}
        {status?.error ? <p className="text-[13px] leading-snug break-words text-red-300">{status.error}</p> : null}
        {!isActive ? (
          <p className="text-[13px] leading-snug text-neutral-500">
            "Open in browser" starts the VM if needed, the services and dev processes the repository's hunt.json declares, and opens{" "}
            <span className="font-mono text-neutral-400">{session ? `https://${session.id.slice(0, 8)}.${domain}` : domain}</span> once they are ready. The first start
            imports the data, which takes a few minutes.
          </p>
        ) : null}

        {status && status.processes.length ? (
          <section className="flex flex-col gap-1">
            <div className="text-[13px] text-neutral-500">Processes</div>
            {status.processes.map((process) => (
              <div key={process.name} className="flex min-w-0 items-center gap-2">
                <span className="w-24 shrink-0 truncate font-mono text-[13px] text-neutral-200">{process.name}</span>
                <span className={`w-20 shrink-0 text-[13px] ${STATE_COLORS[process.state] ?? "text-neutral-400"}`}>{process.state}</span>
                {process.url ? (
                  <button type="button" onClick={() => void openUrl(process.url ?? "")} className="min-w-0 truncate text-left font-mono text-[13px] text-sky-300 hover:underline">
                    {process.url}
                  </button>
                ) : (
                  <span className="min-w-0 flex-1" />
                )}
                <span className="flex-1" />
                {process.restarts ? <span className="shrink-0 text-[12px] text-neutral-500">{process.restarts} restarts</span> : null}
                {process.optional && process.state === "stopped" ? (
                  <button type="button" onClick={() => void restart(sessionId, process.name)} disabled={preview.isBusy} className={GHOST_BUTTON_XS}>
                    Start
                  </button>
                ) : isActive ? (
                  <button type="button" onClick={() => void restart(sessionId, process.name)} disabled={preview.isBusy} className={GHOST_BUTTON_XS}>
                    Restart
                  </button>
                ) : null}
              </div>
            ))}
          </section>
        ) : null}

        {status && status.services.length ? (
          <section className="flex flex-col gap-1">
            <div className="text-[13px] text-neutral-500">Services</div>
            {status.services.map((service) => (
              <div key={service.name} className="flex items-center gap-2 text-[13px]">
                <span className="w-24 shrink-0 truncate font-mono text-neutral-200">{service.name}</span>
                <span className={service.state === "running" ? "text-green-300" : "text-neutral-400"}>{service.state}</span>
              </div>
            ))}
          </section>
        ) : null}

        {isActive ? (
          <section className="flex min-h-48 flex-1 flex-col gap-2">
            <div className="flex flex-wrap gap-1">
              {logNames.map((name) => (
                <button key={name} type="button" onClick={() => setLogName(name)} className={`${TAB_BUTTON_SM} ${name === logName ? TAB_ACTIVE : TAB_INACTIVE}`}>
                  {name}
                </button>
              ))}
            </div>
            <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto rounded-md border border-(--line) bg-(--surface-inset) p-2">
              <pre ref={contentRef} className="font-mono text-[12px] leading-snug whitespace-pre-wrap text-neutral-300">
                {log.text || "No output yet."}
              </pre>
            </div>
          </section>
        ) : null}

        <p className="text-[13px] leading-snug text-neutral-500">Diff, editor, graph and review work again once you bring the session back.</p>
      </div>
    </div>
  );
}

/** The preview's state as the header shows it, with the setup step while one runs. */
function describeState(state: string, step: string | null): string {
  if (state === "preparing" || state === "init") return step ? `${state === "init" ? "Initializing" : "Preparing"}: ${step}` : "Preparing…";
  if (state === "starting") return "Starting…";
  if (state === "ready") return "Ready";
  if (state === "degraded") return "A process crashed";
  if (state === "failed") return "Failed";
  return "Not running";
}
