import { describe, expect, it } from "vitest";
import { vmCost } from "./vm-cost.utils";

describe("vmCost", () => {
  it("prices the running time at the list price of the machine type", () => {
    expect(vmCost({ machineType: "c4d-standard-8", runningSeconds: 66825 })).toEqual({
      cost: "≈ €6.79",
      duration: "18h 33m",
      title: "c4d-standard-8 at €0.366 per hour, on-demand list price in europe-west1 on 2026-11-08, without disk · ran 18h 33m in the last six weeks (Cloud Monitoring, up to 4 min behind)",
    });
    expect(vmCost({ machineType: "c3d-highcpu-16", runningSeconds: 3600 })?.cost).toBe("≈ €0.59");
  });

  it("shows only the running time for a machine type without a price or a deleted VM, and nothing for a VM that never ran", () => {
    expect(vmCost({ machineType: "e2-small", runningSeconds: 120 })).toMatchObject({ cost: "€ –", duration: "2m", title: expect.stringMatching(/^e2-small: no price known/) });
    expect(vmCost({ machineType: null, runningSeconds: 120 })).toMatchObject({ cost: "€ –", title: expect.stringMatching(/^VM deleted: no price known/) });
    expect(vmCost({ machineType: "c4d-standard-8", runningSeconds: 0 })?.cost).toBe("≈ €0.00");
    expect(vmCost({ machineType: null, runningSeconds: 0 })).toBeNull();
  });
});
