import { describe, expect, it } from "vitest";
import { isOffStatus, isShuttingDownStatus, isStoppedStatus } from "./vm-status.utils.ts";

describe("vm statuses", () => {
  it("tells stopped, off and shutting-down VMs apart", () => {
    expect(["TERMINATED", "STOPPED"].every(isStoppedStatus)).toBe(true);
    expect(isStoppedStatus("SUSPENDED")).toBe(false);
    expect(["TERMINATED", "STOPPED", "SUSPENDED"].every(isOffStatus)).toBe(true);
    expect(["RUNNING", "STOPPING", "SUSPENDING"].some(isOffStatus)).toBe(false);
    expect(["STOPPING", "SUSPENDING"].every(isShuttingDownStatus)).toBe(true);
    expect(isShuttingDownStatus("STOPPED")).toBe(false);
  });
});
