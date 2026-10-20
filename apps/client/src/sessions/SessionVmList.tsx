import { useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { commands } from "../ipc/commands";
import type { SessionVm } from "../ipc/types";
import { useHuntStore } from "../state/store";
import { ICON_BUTTON_SM } from "../ui/buttons";
import { AGENT_CHIP, Chip } from "../ui/Chip";
import { CloudIcon, CloudSyncIcon, ExternalIcon, Spinner } from "../ui/icons";
import { errorText, useLoad } from "../ui/useLoad";
import { ListPane } from "./ListPane";
import { Separator } from "./PullRequestList";
import { sessionMarks } from "./sessionLabels";
import { MarkGlyph, SessionMark } from "./SessionMark";
import { filterSessionVms, sessionVmAgentLabel, sessionVmMarkState, sessionVmMeta, sessionVmOriginLabel, sessionVmStatusLabel, sessionVmUrl } from "./sessionVms";

/**
 * The session VMs the gateway lists, filling the chat pane in place of the start view: the running ones and those whose
 * agent waits for an answer, or every one with "Show stopped", filtered by a search box. A row starts with the session's
 * mark as the sidebar shows it (its letter and live state for a session the sidebar lists, else a `+` with the state
 * the gateway recorded), names the session and its origin (`swf #123` for the poller's, `remote` for another person's
 * handoff); clicking it shows the session, adopting it into the sidebar first when this Mac does not know it, and the
 * arrow at its end opens the issue or repository on GitHub. Loads once when shown and again with the reload button.
 */
export function SessionVmList({ onClose }: { onClose: () => void }) {
  const sessions = useHuntStore((state) => state.sessions);
  const openSessionVm = useHuntStore((state) => state.openSessionVm);
  const marks = useMemo(() => sessionMarks(sessions), [sessions]);
  const [query, setQuery] = useState("");
  const [showsStopped, setShowsStopped] = useState(false);
  const [vms, setVms] = useState<SessionVm[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Counts the reloads; a change loads the list again. */
  const [generation, setGeneration] = useState(0);
  const [isReloading, setIsReloading] = useState(false);
  /** The VM whose session is being opened; its row shows a spinner meanwhile. */
  const [openingId, setOpeningId] = useState<string | null>(null);
  const rows = useMemo(() => filterSessionVms(vms ?? [], query, showsStopped), [vms, query, showsStopped]);

  useLoad(
    () => commands.listSessionVms(),
    {
      onValue: (listed) => {
        setVms(listed);
        setError(null);
        setIsReloading(false);
      },
      onError: (reason) => {
        setError(errorText(reason));
        setIsReloading(false);
      },
    },
    [generation],
  );

  function reload() {
    setIsReloading(true);
    setGeneration((current) => current + 1);
  }

  async function open(vm: SessionVm) {
    setOpeningId(vm.id);
    setError(null);
    try {
      await openSessionVm(vm.id);
    } catch (reason) {
      setError(`failed to open the session: ${errorText(reason)}`);
      setOpeningId(null);
    }
  }

  const tools = (
    <>
      <label className="flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-md px-2.5 text-neutral-400 transition-colors hover:bg-(--row-hover) hover:text-neutral-200">
        <input type="checkbox" checked={showsStopped} onChange={(event) => setShowsStopped(event.target.checked)} className="accent-blue-500" />
        Show stopped
      </label>
      <button type="button" onClick={reload} disabled={isReloading} className={ICON_BUTTON_SM} title="Ask the gateway again" aria-label="Reload the remote sessions">
        {isReloading ? <Spinner className="size-4" /> : <CloudSyncIcon />}
      </button>
    </>
  );

  return (
    <ListPane
      query={query}
      onQueryChange={setQuery}
      searchPlaceholder="Search remote sessions"
      ariaLabel="Remote sessions"
      tools={tools}
      error={error}
      isLoading={!vms}
      emptyText="The gateway lists no session VMs"
      noMatchText={query ? `No remote sessions match “${query}”` : "No session VM is running or waits for an answer; “Show stopped” lists the others"}
      rowCount={rows.length}
      hasItems={Boolean(vms?.length)}
      onClose={onClose}
    >
      {rows.map((vm) => {
        const mark = marks.get(vm.id);
        const isKnown = mark !== undefined;
        const agent = sessionVmAgentLabel(vm);
        const markState = sessionVmMarkState(vm);
        return (
          <li key={vm.id}>
            <div className="group flex items-center rounded-lg transition-colors hover:bg-(--row-hover)">
              <button
                type="button"
                onClick={() => void open(vm)}
                disabled={openingId !== null}
                className="flex min-w-0 flex-1 flex-col items-start gap-0.5 overflow-hidden py-2 pr-1 pl-3 text-left disabled:opacity-60"
                title={isKnown ? "Show the session" : "Add the session to the sidebar and show it"}
              >
                <span className="flex w-full items-center gap-1.5">
                  {isKnown ? (
                    <SessionMark sessionId={vm.id} mark={mark} />
                  ) : (
                    <MarkGlyph mark="+" isBusy={markState.isBusy} badge={markState.hasQuestion ? "question" : null} tone="remote" label="Not in the sidebar" />
                  )}
                  <span className="min-w-0 flex-1 truncate font-medium text-neutral-100">{vm.title}</span>
                  <span className="flex shrink-0 items-center gap-1 text-sky-300" title={`Runs on the VM ${vm.vm.instance} in ${vm.vm.zone}`}>
                    <CloudIcon className="size-4" />
                    <span className="rounded-md bg-sky-400/10 px-1.5 text-[11px] leading-5 font-medium">{sessionVmOriginLabel(vm)}</span>
                  </span>
                  {vm.isRunning ? (
                    <Chip className="border-emerald-400/40 bg-emerald-400/10 text-emerald-300">{sessionVmStatusLabel(vm)}</Chip>
                  ) : (
                    <Chip className="border-white/10 text-neutral-400">{sessionVmStatusLabel(vm)}</Chip>
                  )}
                  {agent ? (
                    <Chip className={AGENT_CHIP[agent.tone]} title={agent.title}>
                      {agent.label}
                    </Chip>
                  ) : null}
                  {isKnown ? <Chip className="border-white/10 text-neutral-400">In sidebar</Chip> : null}
                  {openingId === vm.id ? <Spinner className="size-3.5 shrink-0" /> : null}
                </span>
                <span className="flex w-full min-w-0 items-center gap-1 overflow-hidden pl-6 text-[12px] text-neutral-500">
                  {sessionVmMeta(vm).map((part, index) => (
                    <span key={part} className={`${index === 0 ? "shrink-0" : "truncate"} flex min-w-0 items-center gap-1`}>
                      {index > 0 ? <Separator /> : null}
                      <span className={index === 1 && vm.branch ? "truncate font-mono" : "truncate"}>{part}</span>
                    </span>
                  ))}
                </span>
              </button>
              <button
                type="button"
                onClick={() => void openUrl(sessionVmUrl(vm))}
                className="mr-1 flex size-8 shrink-0 items-center justify-center rounded-md text-neutral-500 opacity-0 transition-colors group-hover:opacity-100 hover:bg-white/10 hover:text-white focus-visible:opacity-100"
                title={vm.origin === "swf" && vm.issue ? `Open issue #${vm.issue} on GitHub` : "Open the repository on GitHub"}
                aria-label={vm.origin === "swf" && vm.issue ? `Open issue #${vm.issue} on GitHub` : `Open ${vm.repo} on GitHub`}
              >
                <ExternalIcon />
              </button>
            </div>
          </li>
        );
      })}
    </ListPane>
  );
}
