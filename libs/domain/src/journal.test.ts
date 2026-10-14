import { describe, expect, it } from "vitest";
import { journalLine } from "./journal.ts";

describe("journalLine", () => {
  it("prefixes every line with the syslog priority of its level when it goes to the journal", () => {
    expect(journalLine("listening", "info", true)).toBe("<6>listening");
    expect(journalLine("failed to serve\n  at main", "error", true)).toBe("<3>failed to serve\n<3>  at main");
    expect([journalLine("a", "debug", true), journalLine("a", "warn", true), journalLine("a", "fatal", true)]).toEqual(["<7>a", "<4>a", "<2>a"]);
  });

  it("leaves the message bare elsewhere", () => {
    expect(journalLine("failed to serve", "error", false)).toBe("failed to serve");
  });
});
