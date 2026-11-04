import { describe, expect, it } from "vitest";
import type { ContextPart } from "./loaded-context.types";
import { estimateTokens, partKindTotals, startsExpanded } from "./context-parts.utils";

const part = (kind: ContextPart["kind"], length: number): ContextPart => ({ kind, title: kind, text: "x".repeat(length) });

describe("estimateTokens", () => {
  it("counts four characters per token, rounded up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcde")).toBe(2);
  });
});

describe("startsExpanded", () => {
  it("expands prompts, replies and summaries always and other parts while they are short", () => {
    expect(startsExpanded(part("user", 5000))).toBe(true);
    expect(startsExpanded(part("assistant", 5000))).toBe(true);
    expect(startsExpanded(part("summary", 5000))).toBe(true);
    expect(startsExpanded(part("toolResult", 400))).toBe(true);
    expect(startsExpanded(part("toolResult", 401))).toBe(false);
    expect(startsExpanded(part("systemPrompt", 5000))).toBe(false);
  });
});

describe("partKindTotals", () => {
  it("sums count and tokens per kind in the fixed kind order and leaves out absent kinds", () => {
    expect(partKindTotals([part("user", 8), part("systemPrompt", 40), part("user", 4)])).toEqual([
      { kind: "systemPrompt", count: 1, tokens: 10 },
      { kind: "user", count: 2, tokens: 3 },
    ]);
  });
});
