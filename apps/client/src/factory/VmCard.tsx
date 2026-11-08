import { useState } from "react";
import { commands } from "../ipc/commands";
import { useHuntStore } from "../sessions/hunt.store";
import type { SessionVmState } from "../sessions/remote/remote-session.types";
import { vmStatusLabel, vmUptimeLabel } from "../sessions/remote/session-vms.utils";
import { Chip } from "../ui/Chip";
import { errorText } from "../ui/error-text.utils";
import { useLoad } from "../ui/load.hook";
import { vmCost, type VmCost } from "./vm-cost.utils";
import { vmIdleLines } from "./vm-card.utils";

/** How often the VM's running time is read again from the gateway while the tab is open. */
const VM_USAGE_REFRESH_MS = 5 * 60_000;
const CARD = "flex w-72 flex-col gap-1.5 rounded-md border border-(--line) bg-black/50 px-3 py-2 backdrop-blur-md text-[13px] whitespace-nowrap text-neutral-500";
const ROW = "flex gap-2 leading-none";
const VALUE = "ml-auto shrink-0 tabular-nums text-neutral-300";

/** Colour of the VM's status chip: green while it runs, violet while it is suspended, grey otherwise. */
function statusChip(status: string | null): string {
  if (status === "RUNNING") return "border-emerald-400/40 bg-emerald-400/10 text-emerald-300";
  if (status === "SUSPENDED" || status === "SUSPENDING") return "border-violet-400/40 bg-violet-400/10 text-violet-300";
  return "border-white/10 text-neutral-400";
}

/**
 * The VM card below the plan usage of the Factory tab: the session VM's Compute Engine status and uptime from the
 * gateway, how long nothing has kept it up and when the gateway's idle sweeper suspends it from the report of the VM's
 * idle check (read over SSH, once a minute while the VM runs; `vm-card.utils.ts`), and the estimated cost of its
 * running time (`vms.usage`, also while the VM is off, every five minutes). Nothing for a session without a VM. `now`
 * ticks once a minute.
 */
export function VmCard({ sessionId, isTurnRunning, now }: { sessionId: string; isTurnRunning: boolean; now: number }) {
  const link = useHuntStore((state) => state.remoteLinks[sessionId]?.state ?? null);
  const [vm, setVm] = useState<SessionVmState | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [cost, setCost] = useState<VmCost | null>(null);
  const [costNote, setCostNote] = useState<string | null>(null);
  useLoad(
    () => commands.readSessionVmState(sessionId),
    {
      onValue: (state) => {
        setVm(state);
        setNote(state?.idleNote ?? null);
      },
      onError: (reason) => setNote(`Reading the session's VM failed: ${errorText(reason)}`),
    },
    [sessionId, link, isTurnRunning, Math.floor(now / 60_000)],
  );
  useLoad(
    () => commands.readSessionVmUsage(sessionId),
    {
      onValue: (usage) => {
        setCost(usage ? vmCost(usage) : null);
        setCostNote(null);
      },
      onError: (reason) => setCostNote(`Reading the VM's running time from the gateway failed: ${errorText(reason)}`),
    },
    [sessionId, link, isTurnRunning, Math.floor(now / VM_USAGE_REFRESH_MS)],
  );
  if (!vm && !cost) return null;
  const info = vm?.info ?? null;
  const isRunning = info?.status === "RUNNING";
  const status = info ? (info.exists ? vmStatusLabel(info.status ?? "") : "Deleted") : "…";
  const uptime = isRunning && info?.startedAt ? vmUptimeLabel(info.startedAt, now) : null;
  const idle = vm?.idle ? vmIdleLines(vm.idle, now) : null;
  return (
    <div className={CARD} title={note ?? undefined}>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium text-neutral-300">VM</span>
        <Chip className={statusChip(info?.status ?? null)} title={info?.name}>
          {status}
        </Chip>
      </div>
      {isRunning ? (
        <>
          <div className={ROW}>
            <span>Uptime</span>
            <span className={VALUE}>{uptime ?? "—"}</span>
          </div>
          <div className={ROW} title={idle?.title ?? note ?? "The VM has not run its idle check since it came up"}>
            <span>Idle</span>
            <span className={VALUE}>{idle?.idle ?? "—"}</span>
          </div>
          <div className={ROW} title={idle?.title ?? note ?? undefined}>
            <span>Suspends</span>
            <span className={VALUE}>{idle?.suspend ?? "—"}</span>
          </div>
        </>
      ) : null}
      {cost ? (
        <div title={costNote ? `${cost.title}\n${costNote}` : cost.title} className={`${ROW} border-t border-(--line) pt-1.5`}>
          <span className="min-w-0 truncate">Cost</span>
          <span className={VALUE}>{cost.cost}</span>
          <span className="shrink-0 text-[12px] tabular-nums text-neutral-600">{cost.duration}</span>
        </div>
      ) : null}
    </div>
  );
}
