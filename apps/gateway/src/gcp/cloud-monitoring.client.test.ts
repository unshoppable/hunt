import { describe, expect, it } from "vitest";
import { createMonitoring, sumPoints, uptimeQuery } from "./cloud-monitoring.client.ts";
import { fakeFetch, fixedMetadata } from "./gcp.fixtures.ts";

const NOW = new Date("2026-11-08T12:00:00.000Z");
const BASE = "https://monitoring.googleapis.com/v3/projects/medconomy-hunt/timeSeries";

function series(...values: number[]) {
  return { timeSeries: values.map((value) => ({ metricKind: "DELTA", valueType: "DOUBLE", points: [{ value: { doubleValue: value } }] })) };
}

describe("uptimeQuery", () => {
  it("sums the uptime of the VM's name over the six weeks Monitoring keeps into one point", () => {
    expect(Object.fromEntries(uptimeQuery("vm-hunt-s-ab12cd34", NOW))).toEqual({
      filter: 'metric.type = "compute.googleapis.com/instance/uptime" AND metric.labels.instance_name = "vm-hunt-s-ab12cd34"',
      "interval.startTime": "2026-09-27T12:00:00.000Z",
      "interval.endTime": "2026-11-08T12:00:00.000Z",
      "aggregation.alignmentPeriod": "3628800s",
      "aggregation.perSeriesAligner": "ALIGN_SUM",
      "aggregation.crossSeriesReducer": "REDUCE_SUM",
    });
  });
});

describe("sumPoints", () => {
  it("adds the points of every series and counts a page without series or values as 0", () => {
    expect(sumPoints(series(66824.9, 100))).toBeCloseTo(66924.9);
    expect(sumPoints({ timeSeries: [{ points: [{ value: { int64Value: "60" } }, { value: {} }] }] })).toBe(60);
    expect(sumPoints({})).toBe(0);
    expect(sumPoints(null)).toBe(0);
  });
});

describe("createMonitoring", () => {
  it("reads every page with the gateway's token and sums them", async () => {
    const first = `${BASE}?${uptimeQuery("vm-hunt-s-ab12cd34", NOW)}`;
    const { fetchImpl, requests } = fakeFetch({
      [`GET ${first}`]: () => Response.json({ ...series(3600), nextPageToken: "p 2" }),
      [`GET ${first}&pageToken=p%202`]: () => Response.json(series(1800)),
    });
    const logs: string[] = [];

    expect(await createMonitoring(fixedMetadata, fetchImpl, (message) => logs.push(message)).runningSeconds("vm-hunt-s-ab12cd34", NOW)).toBe(5400);
    expect(requests.map((request) => request.authorization)).toEqual(["Bearer token-1", "Bearer token-1"]);
    expect(logs[0]).toMatch(/^Cloud Monitoring GET the uptime of vm-hunt-s-ab12cd34: HTTP 200 in \d+ ms$/);
  });

  it("fails with Monitoring's answer when the gateway may not read the metric", async () => {
    const { fetchImpl } = fakeFetch({
      [`GET ${BASE}?${uptimeQuery("vm-hunt-s-ab12cd34", NOW)}`]: () => new Response('{"error": {"code": 403, "message": "Permission denied"}}', { status: 403 }),
    });

    await expect(createMonitoring(fixedMetadata, fetchImpl).runningSeconds("vm-hunt-s-ab12cd34", NOW)).rejects.toThrow(
      'failed to read the uptime of vm-hunt-s-ab12cd34: HTTP 403 {"error": {"code": 403, "message": "Permission denied"}}',
    );
  });
});
