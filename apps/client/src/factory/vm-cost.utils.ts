import { MACHINE_TYPE_PRICES_NOTE, machineTypeEurPerHour } from "../../../../libs/domain/src/session/session-machine-type.types.ts";
import type { SessionVmUsage } from "../sessions/remote/remote-session.types";
import { formatRunDuration } from "./pipeline-graph.utils";

/** The estimated cost of a session's VM, for the Factory tab: `≈ €6.80` beside `18h 34m`, and how it was reckoned. */
export type VmCost = { cost: string; duration: string; title: string };

/**
 * The cost of the VM's running time at the list price of its machine type; without a known price only the running time,
 * and nothing for a VM that neither runs nor ran.
 */
export function vmCost(usage: SessionVmUsage): VmCost | null {
  if (!usage.machineType && usage.runningSeconds === 0) return null;
  const duration = formatRunDuration(usage.runningSeconds * 1000);
  const eurPerHour = usage.machineType ? machineTypeEurPerHour(usage.machineType) : null;
  const type = usage.machineType ?? "VM deleted";
  const running = `ran ${duration} in the last six weeks (Cloud Monitoring, up to 4 min behind)`;
  if (eurPerHour === null) return { cost: "€ –", duration, title: `${type}: no price known · ${running}` };
  return {
    cost: `≈ €${((usage.runningSeconds / 3600) * eurPerHour).toFixed(2)}`,
    duration,
    title: `${type} at €${eurPerHour.toFixed(3)} per hour, ${MACHINE_TYPE_PRICES_NOTE} · ${running}`,
  };
}
