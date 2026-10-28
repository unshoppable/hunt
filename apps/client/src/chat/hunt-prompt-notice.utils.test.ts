import { describe, expect, it } from "vitest";
import { HANDOFF_START_PROMPT } from "../preview/preview-services.utils";
import { huntPromptNotice } from "./hunt-prompt-notice.utils";

describe("huntPromptNotice", () => {
  it("names the handoff prompt, also as a transcript replays it with surrounding whitespace", () => {
    expect(huntPromptNotice(HANDOFF_START_PROMPT)).toBe("Hunt asked the agent to start the services on the VM");
    expect(huntPromptNotice(`${HANDOFF_START_PROMPT}\n`)).toBe("Hunt asked the agent to start the services on the VM");
  });

  it("leaves a prompt of the user alone, also one that quotes the handoff prompt", () => {
    expect(huntPromptNotice("Start the services")).toBeNull();
    expect(huntPromptNotice(`Why did you get this?\n${HANDOFF_START_PROMPT}`)).toBeNull();
  });
});
