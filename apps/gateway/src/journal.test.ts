import { describe, expect, it } from "vitest";
import { oneLine } from "./journal.ts";

describe("oneLine", () => {
  it("joins the lines of a message, such as a command's stderr tail, into one journal entry", () => {
    expect(oneLine("failed to run hunt-ctl deps on vm-hunt-s-1: exit status 1\n  npm ERR! code E404\nnpm ERR! 404 Not Found\n")).toBe(
      "failed to run hunt-ctl deps on vm-hunt-s-1: exit status 1 | npm ERR! code E404 | npm ERR! 404 Not Found",
    );
    expect(oneLine("ok in 12 ms")).toBe("ok in 12 ms");
  });
});
