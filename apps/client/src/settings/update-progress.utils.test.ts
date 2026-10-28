import { describe, expect, it } from "vitest";
import { NO_PROGRESS, applyDownloadEvent, describeProgress, downloadFraction, formatBytes, type DownloadProgress } from "./update-progress.utils";

function run(events: Parameters<typeof applyDownloadEvent>[1][]): DownloadProgress {
  return events.reduce(applyDownloadEvent, NO_PROGRESS);
}

describe("applyDownloadEvent", () => {
  it("takes the total from Started and sums Progress chunks", () => {
    const progress = run([{ event: "Started", data: { contentLength: 100 } }, { event: "Progress", data: { chunkLength: 30 } }, { event: "Progress", data: { chunkLength: 20 } }]);
    expect(progress).toEqual({ downloadedBytes: 50, totalBytes: 100, isFinished: false });
  });

  it("keeps the total unknown when Started has no content length", () => {
    expect(run([{ event: "Started", data: {} }, { event: "Progress", data: { chunkLength: 5 } }])).toEqual({ downloadedBytes: 5, totalBytes: null, isFinished: false });
  });

  it("marks Finished without touching the counts", () => {
    expect(run([{ event: "Started", data: { contentLength: 10 } }, { event: "Progress", data: { chunkLength: 10 } }, { event: "Finished" }])).toEqual({ downloadedBytes: 10, totalBytes: 10, isFinished: true });
  });
});

describe("downloadFraction", () => {
  it("is null without a total, clamped to 1 and 1 once finished", () => {
    expect(downloadFraction({ downloadedBytes: 5, totalBytes: null, isFinished: false })).toBeNull();
    expect(downloadFraction({ downloadedBytes: 25, totalBytes: 100, isFinished: false })).toBe(0.25);
    expect(downloadFraction({ downloadedBytes: 120, totalBytes: 100, isFinished: false })).toBe(1);
    expect(downloadFraction({ downloadedBytes: 0, totalBytes: null, isFinished: true })).toBe(1);
  });
});

describe("formatBytes and describeProgress", () => {
  it("picks the unit by size", () => {
    expect(formatBytes(12)).toBe("12 B");
    expect(formatBytes(840_000)).toBe("840 kB");
    expect(formatBytes(45_000_000)).toBe("45.0 MB");
  });

  it("describes the three download states", () => {
    expect(describeProgress({ downloadedBytes: 12_300_000, totalBytes: 45_000_000, isFinished: false })).toBe("12.3 MB of 45.0 MB");
    expect(describeProgress({ downloadedBytes: 12_300_000, totalBytes: null, isFinished: false })).toBe("12.3 MB");
    expect(describeProgress({ downloadedBytes: 1, totalBytes: 1, isFinished: true })).toBe("Installing…");
  });
});
