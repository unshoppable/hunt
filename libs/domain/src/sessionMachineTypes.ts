/**
 * The machine types a person may pick for new session VMs under Settings → Remote VM; the gateway accepts no other
 * (`sessions.provision`). Without a pick, a session VM gets the machine type of the instance template `tpl-hunt-session`.
 * Every entry must take the template's boot disk type, Hyperdisk Balanced (infrastructure ADR 0008): the gateway only
 * replaces the template's machine type, never its disk.
 */
export type SessionMachineType = {
  name: string;
  /** Physical cores; each runs two vCPUs. */
  cores: number;
  memoryGb: number;
  /**
   * On-demand list price in europe-west1 on 2026-10-14, per running hour. Prices come from the Cloud Billing catalog
   * (`services/6F81-5844-456A/skus`), fetched with a user token and no `x-goog-user-project` header; with one naming
   * a medconomy project the catalog answers 403.
   */
  eurPerHour: number;
};

/** AMD EPYC Turin (C4D), the fastest per core in a single-threaded Node benchmark of 2026-10-14; smallest first. */
export const SESSION_MACHINE_TYPES: readonly SessionMachineType[] = [
  { name: "c4d-standard-4", cores: 2, memoryGb: 15, eurPerHour: 0.178 },
  { name: "c4d-standard-8", cores: 4, memoryGb: 31, eurPerHour: 0.359 },
  { name: "c4d-highmem-8", cores: 4, memoryGb: 63, eurPerHour: 0.467 },
  { name: "c4d-highcpu-16", cores: 8, memoryGb: 30, eurPerHour: 0.609 },
  { name: "c4d-standard-16", cores: 8, memoryGb: 62, eurPerHour: 0.717 },
];

export function isSessionMachineType(name: string): boolean {
  return SESSION_MACHINE_TYPES.some((type) => type.name === name);
}
