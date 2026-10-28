/**
 * The zones the gateway creates session VMs in, in order of preference, and moves a stopped one to when its own zone
 * has no capacity for its start. `hunt-ctl install` writes them to `/etc/hunt/session-zones`, one per line, from the
 * gateway's instance metadata `hunt-session-zones`; the edge proxy looks the session VMs up in the same zones.
 */
import { readFileSync } from "node:fs";

export const ZONES_FILE = "/etc/hunt/session-zones";
const ZONE_PATTERN = /^[a-z]+-[a-z]+[0-9]+-[a-z]$/;

/** The zones in `path`; the gateway's own zone `gatewayZone` when the file is missing or lists none. */
export function readSessionZones(gatewayZone: string, path = ZONES_FILE): string[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [gatewayZone];
  }
  const zones = [...new Set(text.split(/\s+/).filter((zone) => ZONE_PATTERN.test(zone)))];
  return zones.length > 0 ? zones : [gatewayZone];
}
