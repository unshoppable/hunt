import { describe, expect, it } from "vitest";
import { vmIdleLines } from "./vm-card.utils";

const NOW = Date.parse("2026-11-08T14:00:00Z");
const REPORT = { at: NOW / 1000 - 90, decision: "keep: a turn ended within 30 min", idleSeconds: 720, suspendInSeconds: 1980, idleMinutes: 30, idleChecks: 15 };

describe("vmIdleLines", () => {
  it("carries the report forward to now and names the suspend time", () => {
    const lines = vmIdleLines(REPORT, NOW);
    expect(lines.idle).toBe("13 min");
    expect(lines.suspend).toMatch(/^≈ \d{1,2}:\d{2}( [AP]M)? · in 31 min$/);
    expect(lines.title).toBe("keep: a turn ended within 30 min\nSuspended after 30 min without activity and 15 checks in a row that find nothing");
  });

  it("shows a VM that is busy, idle or powering off", () => {
    expect(vmIdleLines({ ...REPORT, at: NOW / 1000, idleSeconds: 0, suspendInSeconds: 2700 }, NOW)).toMatchObject({ idle: "—", suspend: expect.stringMatching(/in 45 min$/) });
    expect(vmIdleLines({ ...REPORT, decision: "idle: no turn for 30 min", idleSeconds: 7200, suspendInSeconds: 0 }, NOW)).toMatchObject({ idle: "2 h 1 min", suspend: "now" });
    expect(vmIdleLines({ ...REPORT, decision: "wait: 14 of 15", suspendInSeconds: 60 }, NOW)).toMatchObject({ suspend: "now" });
    expect(vmIdleLines({ ...REPORT, decision: "poweroff: idle for 15 min", suspendInSeconds: 0 }, NOW)).toMatchObject({ suspend: "powering off" });
  });
});
