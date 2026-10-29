import { describe, expect, it } from "vitest";
import type { ChatItem } from "../chat.types";
import { buildGuardrailRequest, buildTranscript, findGuardrailSuggestion, guardrailChatTask, stripGuardrailMarker, transcriptTail } from "./guardrail-suggestion.utils";

const user = (text: string): ChatItem => ({ kind: "user", id: text, text, images: [] });
const agent = (text: string): ChatItem => ({ kind: "agent", id: text, text, images: [] });

describe("findGuardrailSuggestion", () => {
  it("returns the kind and summary the last reply marks", () => {
    expect(findGuardrailSuggestion([user("q"), agent("Use ports.\n<!-- hunt:guardrail adr: Adapters wrap every external API. -->")])).toEqual({
      kind: "adr",
      summary: "Adapters wrap every external API.",
      reason: "",
      replyId: "Use ports.\n<!-- hunt:guardrail adr: Adapters wrap every external API. -->",
    });
  });

  it("splits the reason off the summary, also on a line of its own", () => {
    const sameLine = "Done.\n<!-- hunt:guardrail rule: Wrap `Base<T>` fields. Why: The build failed twice. -->";
    expect(findGuardrailSuggestion([user("q"), agent(sameLine)])).toEqual({ kind: "rule", summary: "Wrap `Base<T>` fields.", reason: "The build failed twice.", replyId: sameLine });
    const ownLine = "Done.\n<!-- hunt:guardrail skill: Seed first.\nWhy: Tests broke. -->";
    expect(findGuardrailSuggestion([user("q"), agent(ownLine)])).toEqual({ kind: "skill", summary: "Seed first.", reason: "Tests broke.", replyId: ownLine });
  });

  it("finds the marker before the question marker", () => {
    expect(findGuardrailSuggestion([user("q"), agent("Shall I go on?\n\n<!-- hunt:guardrail rule: Exclude new types. -->\n<!-- hunt:question -->")])).toEqual({
      kind: "rule",
      summary: "Exclude new types.",
      reason: "",
      replyId: "Shall I go on?\n\n<!-- hunt:guardrail rule: Exclude new types. -->\n<!-- hunt:question -->",
    });
  });

  it("ignores a marker of a reply before the last prompt and unknown kinds", () => {
    expect(findGuardrailSuggestion([agent("a <!-- hunt:guardrail rule: x -->"), user("next")])).toBeNull();
    expect(findGuardrailSuggestion([user("q"), agent("a <!-- hunt:guardrail memo: x -->")])).toBeNull();
  });
});

describe("stripGuardrailMarker", () => {
  it("removes a complete or still streaming marker at the end", () => {
    expect(stripGuardrailMarker("Done.\n\n<!-- hunt:guardrail skill: x -->\n")).toBe("Done.");
    expect(stripGuardrailMarker("Done.\n<!-- hunt:guard")).toBe("Done.");
  });

  it("strips a marker whose text holds a > and keeps a comment that is not at the end", () => {
    expect(stripGuardrailMarker("Done.\n<!-- hunt:guardrail rule: Extend `Base<TText>` and mark fields. -->")).toBe("Done.");
    expect(stripGuardrailMarker("Done.\n<!-- hunt:guardrail rule: Extend `Base<TText>` and")).toBe("Done.");
    expect(stripGuardrailMarker("<!-- note --> Done.")).toBe("<!-- note --> Done.");
  });

  it("strips a marker before the question marker and keeps one quoted inside a line", () => {
    expect(stripGuardrailMarker("Found it.\n\nShall I go on?\n\n<!-- hunt:guardrail rule: x -->\n<!-- hunt:question -->\n")).toBe("Found it.\n\nShall I go on?");
    expect(stripGuardrailMarker("End with `<!-- hunt:guardrail rule: x -->` there.")).toBe("End with `<!-- hunt:guardrail rule: x -->` there.");
  });
});

describe("buildGuardrailRequest", () => {
  it("invokes the guardrail skill with the suggestion or leaves the request open", () => {
    expect(buildGuardrailRequest({ kind: "adr", summary: "Use ports.", reason: "", replyId: "a1" }, "ADR", "guardrail")).toBe("/guardrail ADR: Use ports.");
    expect(buildGuardrailRequest(null, "", "team-lessons")).toBe("/team-lessons ");
  });
});

describe("guardrailChatTask", () => {
  it("names the skill and its file and ends with the conversation", () => {
    const task = guardrailChatTask("lessons", "### User\nq");
    expect(task).toContain("`/lessons` skill (`.claude/skills/lessons/SKILL.md`)");
    expect(task.trimEnd().endsWith("### User\nq")).toBe(true);
    expect(task).not.toContain("{{");
  });
});

describe("buildTranscript", () => {
  it("keeps user and agent messages without markers", () => {
    expect(buildTranscript([user("q"), { kind: "thought", id: "t", text: "hm" }, agent("a\n<!-- hunt:guardrail rule: x -->")])).toBe("### User\nq\n\n### Agent\na");
    expect(buildTranscript([agent("Which one?\n<!-- hunt:question -->\n")])).toBe("### Agent\nWhich one?");
  });
});

describe("transcriptTail", () => {
  it("keeps the last non-empty lines and marks the cut", () => {
    expect(transcriptTail("### User\nq\n\n### Agent\na\nb", 3)).toBe("…\n### Agent\na\nb");
  });

  it("returns a short transcript without empty lines", () => {
    expect(transcriptTail("### User\nq\n\n### Agent\na", 10)).toBe("### User\nq\n### Agent\na");
  });
});
