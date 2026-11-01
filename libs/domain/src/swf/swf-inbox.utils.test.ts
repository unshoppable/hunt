import { describe, expect, it } from "vitest";
import { answersMessage, parseInboxMessage, pipelineMessage } from "./swf-inbox.utils.ts";
import { started } from "./swf.fixtures.ts";

const NOW = Date.parse("2026-10-25T10:00:00Z");

describe("the inbox messages", () => {
  it("carry a pipeline through JSON and back", () => {
    const pipeline = started(NOW);
    const message = parseInboxMessage(JSON.parse(JSON.stringify(pipelineMessage(pipeline))));
    expect(message?.kind).toBe("pipeline");
    expect(message?.kind === "pipeline" && message.pipeline.toJSON()).toEqual(pipeline.toJSON());
  });

  it("carry the answers with nothing but what the prompt quotes", () => {
    const comments = [{ author: "bob", createdAt: "2026-10-25T11:00:00Z", body: "Postgres.", id: 7 }];
    const json = JSON.parse(JSON.stringify(answersMessage(comments)));
    expect(json).toEqual({ kind: "answers", comments: [{ author: "bob", createdAt: "2026-10-25T11:00:00Z", body: "Postgres." }] });
    expect(parseInboxMessage(json)).toEqual({ kind: "answers", comments: [{ author: "bob", createdAt: "2026-10-25T11:00:00Z", body: "Postgres." }] });
  });

  it("are null for anything else", () => {
    expect(parseInboxMessage(null)).toBeNull();
    expect(parseInboxMessage({ kind: "nope" })).toBeNull();
    expect(parseInboxMessage({ kind: "pipeline", pipeline: { step: "nowhere" } })).toBeNull();
    expect(parseInboxMessage({ kind: "answers", comments: [{ author: "bob" }] })).toBeNull();
    expect(parseInboxMessage({ kind: "answers", comments: "all" })).toBeNull();
  });
});
