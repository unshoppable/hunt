import { describe, expect, it } from "vitest";
import { SessionId } from "./session-id.value-object.ts";

describe("SessionId", () => {
  it("takes the short ID and the VM name from the first 8 hex digits", () => {
    const sessionId = SessionId.of("ab12cd34-0000-4000-8000-000000000001");
    expect(sessionId.short).toBe("ab12cd34");
    expect(sessionId.vm.name).toBe("vm-hunt-s-ab12cd34");
    expect(sessionId.toJSON()).toEqual({ id: "ab12cd34-0000-4000-8000-000000000001" });
  });

  it("accepts lowercase UUIDs only", () => {
    expect(SessionId.isValid("ab12cd34-0000-4000-8000-000000000001")).toBe(true);
    for (const id of ["AB12CD34-0000-4000-8000-000000000001", "ab12cd34", "", "ab12cd34000040008000000000000001"]) {
      expect(SessionId.isValid(id)).toBe(false);
      expect(() => SessionId.of(id)).toThrow(/lowercase UUID/);
    }
  });
});
