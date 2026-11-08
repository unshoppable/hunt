/**
 * Cloud Monitoring in the gateway's project, with the access token of the gateway's service account from the metadata
 * server (`gcp/metadata-server.client.ts`): how long a session VM ran, from the metric Compute Engine writes for every
 * VM. Plain REST through `fetch`; no dependencies.
 */
import { messageOf } from "../../../../libs/domain/src/shared/errors.utils.ts";
import type { Log } from "../../../../libs/domain/src/shared/journal.utils.ts";
import { failure } from "../shared/http-failure.utils.ts";
import { authorization, type Metadata } from "./metadata-server.client.ts";

const MONITORING = "https://monitoring.googleapis.com/v3";
/** The seconds a VM ran per sample, written every minute; Monitoring keeps it six weeks. */
const UPTIME_METRIC = "compute.googleapis.com/instance/uptime";
/** How far back Monitoring keeps the samples of Compute Engine's metrics. */
export const UPTIME_RETENTION_SECONDS = 6 * 7 * 24 * 3600;

export interface Monitoring {
  /**
   * The seconds the VMs named `name` ran within the retention before `now`, summed over every instance that carried
   * the name, such as the one before a move between zones; 0 without samples.
   */
  runningSeconds(name: string, now: Date): Promise<number>;
}

/** The query of `timeSeries.list` that sums the uptime of the VMs named `name` into one point per series. */
export function uptimeQuery(name: string, now: Date): URLSearchParams {
  return new URLSearchParams({
    filter: `metric.type = "${UPTIME_METRIC}" AND metric.labels.instance_name = "${name}"`,
    "interval.startTime": new Date(now.getTime() - UPTIME_RETENTION_SECONDS * 1000).toISOString(),
    "interval.endTime": now.toISOString(),
    "aggregation.alignmentPeriod": `${UPTIME_RETENTION_SECONDS}s`,
    "aggregation.perSeriesAligner": "ALIGN_SUM",
    "aggregation.crossSeriesReducer": "REDUCE_SUM",
  });
}

/** The sum of every point of a `timeSeries.list` page; a page without series is 0. */
export function sumPoints(value: unknown): number {
  const series = (value as { timeSeries?: unknown } | null)?.timeSeries;
  if (!Array.isArray(series)) return 0;
  let sum = 0;
  for (const entry of series as { points?: unknown }[]) {
    const points = Array.isArray(entry.points) ? (entry.points as { value?: { doubleValue?: unknown; int64Value?: unknown } }[]) : [];
    for (const point of points) {
      const number = Number(point.value?.doubleValue ?? point.value?.int64Value ?? 0);
      if (Number.isFinite(number)) {
        sum += number;
      }
    }
  }
  return sum;
}

/** `log` hears one line per API call: the VM, the HTTP status (or why the call failed) and the duration. */
export function createMonitoring(metadata: Metadata, fetchImpl: typeof fetch = fetch, log: Log = () => {}): Monitoring {
  return {
    async runningSeconds(name, now) {
      const base = `${MONITORING}/projects/${encodeURIComponent(await metadata.project())}/timeSeries?${uptimeQuery(name, now)}`;
      const what = `Cloud Monitoring GET the uptime of ${name}`;
      let sum = 0;
      let pageToken = "";
      do {
        const url = pageToken ? `${base}&pageToken=${encodeURIComponent(pageToken)}` : base;
        const startedAt = Date.now();
        let response: Response;
        try {
          response = await fetchImpl(url, { headers: await authorization(metadata) });
        } catch (error) {
          log(`${what}: failed after ${Date.now() - startedAt} ms: ${messageOf(error)}`, "error");
          throw error;
        }
        log(`${what}: HTTP ${response.status} in ${Date.now() - startedAt} ms`);
        if (!response.ok) throw await failure(response, `read the uptime of ${name}`);
        const page = (await response.json()) as { nextPageToken?: unknown };
        sum += sumPoints(page);
        pageToken = typeof page.nextPageToken === "string" ? page.nextPageToken : "";
      } while (pageToken);
      return sum;
    },
  };
}
