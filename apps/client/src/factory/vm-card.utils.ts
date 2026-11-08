import type { SessionVmIdle } from "../sessions/remote/remote-session.types";

/** The idle lines of the VM card: how long nothing kept the VM up and when the gateway suspends it, each with a tooltip. */
export type VmIdleLines = { idle: string; suspend: string; title: string };

/** `12 min`, `2 h 5 min`, `under a minute`. */
function minutesText(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
}

/**
 * The idle lines from the report `idle`, carried forward to `now` (milliseconds since the epoch) since the check runs
 * once a minute: the idle time grows with the time since the report, the suspend moves nearer. A VM whose decision is
 * `idle:` or `poweroff:` is about to be suspended or powered off. The tooltip names the decision and the check's limits.
 */
export function vmIdleLines(idle: SessionVmIdle, now: number): VmIdleLines {
  const sinceReport = Math.max(0, Math.floor(now / 1000 - idle.at));
  const idleSeconds = idle.idleSeconds + sinceReport;
  const suspendIn = Math.max(0, idle.suspendInSeconds - sinceReport);
  const title = `${idle.decision}\nSuspended after ${idle.idleMinutes} min without activity and ${idle.idleChecks} checks in a row that find nothing`;
  if (idle.decision.startsWith("poweroff:")) return { idle: minutesText(idleSeconds), suspend: "powering off", title };
  if (idle.decision.startsWith("idle:") || suspendIn === 0) return { idle: minutesText(idleSeconds), suspend: "now", title };
  const at = new Date(now + suspendIn * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return { idle: idleSeconds < 60 ? "—" : minutesText(idleSeconds), suspend: `≈ ${at} · in ${minutesText(suspendIn)}`, title };
}
