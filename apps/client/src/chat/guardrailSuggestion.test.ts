import { describe, expect, it } from "vitest";
import type { ChatItem } from "../ipc/types";
import { buildGuardrailRequest, buildTranscript, findGuardrailSuggestion, stripGuardrailMarker, transcriptTail } from "./guardrailSuggestion";

const user = (text: string): ChatItem => ({ kind: "user", id: text, text, images: [] });
const agent = (text: string): ChatItem => ({ kind: "agent", id: text, text, images: [] });

describe("findGuardrailSuggestion", () => {
  it("returns the kind and summary the last reply marks", () => {
    expect(findGuardrailSuggestion([user("q"), agent("Use ports.\n<!-- hunt:guardrail adr: Adapters wrap every external API. -->")])).toEqual({
      kind: "adr",
      summary: "Adapters wrap every external API.",
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
});

describe("buildGuardrailRequest", () => {
  it("prefills the suggestion or leaves the request open", () => {
    expect(buildGuardrailRequest({ kind: "adr", summary: "Use ports." }, "ADR")).toBe("Erzeuge eine passende Guardrail für folgendes:\nADR: Use ports.");
    expect(buildGuardrailRequest(null, "")).toBe("Erzeuge eine passende Guardrail für folgendes:\n");
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
