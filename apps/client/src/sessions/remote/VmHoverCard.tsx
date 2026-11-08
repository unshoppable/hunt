import { useState } from "react";
import { createPortal } from "react-dom";
import { commands } from "../../ipc/commands";
import type { SessionVmInfo, VmRef } from "./remote-session.types";
import { Chip } from "../../ui/Chip";
import { useLoad } from "../../ui/load.hook";
import { errorText } from "../../ui/error-text.utils";
import { vmStatusLabel, vmUptimeLabel } from "./session-vms.utils";

const WIDTH = 320;
const GAP = 6;
const MARGIN = 12;

/**
 * The card below the chat header's "On VM" button: the session's VM with its status, zone and uptime, which it asks the
 * gateway for when it opens (name and zone come from the stored VM meanwhile), and `hint`, what a click on the button
 * does or why it is blocked. Right-aligned with `anchor`; the mouse may move into it.
 */
export function VmHoverCard({
  sessionId,
  vm,
  hint,
  anchor,
  onEnter,
  onLeave,
}: {
  sessionId: string;
  vm: VmRef;
  hint: string;
  anchor: DOMRect;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const [info, setInfo] = useState<SessionVmInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useLoad(() => commands.sessionVmInfo(sessionId), { onValue: setInfo, onError: (reason) => setError(errorText(reason)) }, [sessionId]);

  const width = Math.min(WIDTH, window.innerWidth - 2 * MARGIN);
  const style: React.CSSProperties = {
    width,
    top: anchor.bottom + GAP,
    right: Math.max(MARGIN, Math.min(window.innerWidth - anchor.right, window.innerWidth - width - MARGIN)),
  };
  const isRunning = info?.status === "RUNNING";
  const pending = error ? "—" : "…";
  const status = info ? (info.exists ? vmStatusLabel(info.status ?? "") : "Deleted") : pending;
  const uptime = info ? (isRunning && info.startedAt ? (vmUptimeLabel(info.startedAt) ?? "—") : "—") : pending;

  return createPortal(
    <div
      role="tooltip"
      style={style}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      className="fixed z-50 flex flex-col gap-2 rounded-lg border border-neutral-600 bg-(--surface-chat) p-3 text-[13px] text-neutral-200 shadow-xl shadow-black/50"
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono">{info?.name ?? vm.instance}</span>
        <Chip className={isRunning ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-300" : "border-white/10 text-neutral-400"}>{status}</Chip>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-neutral-500">Zone</dt>
        <dd>{info?.zone ?? vm.zone}</dd>
        <dt className="text-neutral-500">Uptime</dt>
        <dd>{uptime}</dd>
      </dl>
      {error ? <p className="text-red-400">{error}</p> : null}
      <p className="border-t border-white/10 pt-2 text-neutral-400">{hint}</p>
    </div>,
    document.body,
  );
}
