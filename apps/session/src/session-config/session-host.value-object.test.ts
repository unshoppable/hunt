import { describe, expect, it } from "vitest";
import { SessionHost } from "./session-host.value-object.ts";

describe("SessionHost", () => {
  const host = new SessionHost({ short: "7c0c6f2e", domain: "hunt.example.com" });

  it("names the main, port and open hosts and the URL template of the port hosts", () => {
    expect(host.mainHost).toBe("7c0c6f2e.hunt.example.com");
    expect(host.portHost(4200)).toBe("7c0c6f2e-4200.hunt.example.com");
    expect(host.portHost("<port>")).toBe("7c0c6f2e-<port>.hunt.example.com");
    expect(host.openHost(3000)).toBe("7c0c6f2e-3000-open.hunt.example.com");
    expect(host.previewUrlTemplate).toBe("https://7c0c6f2e-{port}.hunt.example.com");
  });

  it("reads the command line's parts or reports each problem with the flag's name", () => {
    expect(SessionHost.fromParts({ short: "7c0c6f2e", domain: "hunt.example.com" }).sessionHost?.isEqualTo(host)).toBe(true);
    expect(SessionHost.fromParts({ short: "7C0C6F2E", domain: "localhost" }).problems).toEqual([
      "short: must be the first 8 hex digits of the session ID, in lowercase",
      "domain: must be a lowercase host name with at least two labels, the last of letters only",
    ]);
    expect(SessionHost.fromParts({ short: "7c0c6f2e", domain: `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(38)}.com` }).problems).toEqual([
      "domain: must be a lowercase host name with at least two labels, the last of letters only",
    ]);
  });

  it("rejects an invalid construction", () => {
    expect(() => new SessionHost({ short: "7c0c6f2", domain: "hunt.example.com" })).toThrow(/first 8 hex digits/);
  });
});
