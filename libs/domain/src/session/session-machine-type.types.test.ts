import { describe, expect, it } from "vitest";
import { fallbackMachineTypes, machineTypeEurPerHour, SESSION_MACHINE_TYPES } from "./session-machine-type.types.ts";

describe("machineTypeEurPerHour", () => {
  it("prices every machine type a session VM can get, its fallbacks included", () => {
    for (const type of SESSION_MACHINE_TYPES) {
      expect(machineTypeEurPerHour(type.name)).toBe(type.eurPerHour);
      for (const fallback of fallbackMachineTypes(type.name)) {
        expect(machineTypeEurPerHour(fallback)).toBeGreaterThan(0);
      }
    }
  });

  it("knows no price for any other machine type", () => {
    expect(machineTypeEurPerHour("e2-small")).toBeNull();
    expect(machineTypeEurPerHour("constructor")).toBeNull();
  });
});
