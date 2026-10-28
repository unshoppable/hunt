import { describe, expect, it } from "vitest";
import { SessionVmName } from "./session-vm-name.value-object.ts";

describe("SessionVmName", () => {
  it("derives the VM, moving and snapshot names from the short ID", () => {
    const vm = new SessionVmName({ short: "7c0c6f2e" });
    expect(vm.name).toBe("vm-hunt-s-7c0c6f2e");
    expect(vm.movingName).toBe("vm-hunt-s-7c0c6f2e-moving");
    expect(vm.snapshotName).toBe("vm-hunt-s-7c0c6f2e-move");
  });

  it("rejects a short ID that is no 8 hex digits", () => {
    expect(() => new SessionVmName({ short: "7C0C6F2E" })).toThrow(/8 hex digits/);
    expect(() => new SessionVmName({ short: "7c0c6f2" })).toThrow(/8 hex digits/);
  });

  it("recognizes a session VM by its name, but no moving or other VM", () => {
    expect(SessionVmName.fromName("vm-hunt-s-7c0c6f2e")?.short).toBe("7c0c6f2e");
    expect(SessionVmName.fromName("vm-hunt-s-7c0c6f2e-moving")).toBeNull();
    expect(SessionVmName.fromName("vm-hunt-gw")).toBeNull();
  });

  it("reads the short ID from the first label of a preview host, with or without a port", () => {
    expect(SessionVmName.fromPreviewHost("7c0c6f2e.hunt.example.com")?.name).toBe("vm-hunt-s-7c0c6f2e");
    expect(SessionVmName.fromPreviewHost("7C0C6F2E-4200.hunt.example.com:443")?.short).toBe("7c0c6f2e");
    expect(SessionVmName.fromPreviewHost("7c0c6f2e")).toBeNull();
    expect(SessionVmName.fromPreviewHost("7c0c6f2ex.hunt.example.com")).toBeNull();
    expect(SessionVmName.fromPreviewHost("7c0c6f2e-api.hunt.example.com")).toBeNull();
    expect(SessionVmName.fromPreviewHost("7c0c6f2e-3000-open.hunt.example.com")).toBeNull();
    expect(SessionVmName.fromPreviewHost(undefined)).toBeNull();
  });
});
