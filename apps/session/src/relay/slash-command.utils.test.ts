import { describe, expect, it } from "vitest";
import { notificationMessage } from "../../../../libs/domain/src/shared/json-rpc.utils.ts";
import { isCommandPrompt } from "./slash-command.utils.ts";

const COMMANDS = notificationMessage("session/update", {
  sessionId: "acp-1",
  update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "compact", description: "Compact" }, { name: "swf-plan" }] },
});

const prompt = (...blocks: unknown[]) => ({ sessionId: "acp-1", prompt: blocks });
const text = (value: string) => ({ type: "text", text: value });

describe("isCommandPrompt", () => {
  it("takes a prompt that starts with a listed command, with or without arguments", () => {
    expect(isCommandPrompt(prompt(text("/compact")), COMMANDS)).toBe(true);
    expect(isCommandPrompt(prompt(text("  /compact keep the plan")), COMMANDS)).toBe(true);
    expect(isCommandPrompt(prompt(text("/swf-plan\n")), COMMANDS)).toBe(true);
  });

  it("leaves out text that only starts with a slash, an unlisted command and a prompt that starts with an image", () => {
    expect(isCommandPrompt(prompt(text("/tmp/out.log is empty")), COMMANDS)).toBe(false);
    expect(isCommandPrompt(prompt(text("/unknown")), COMMANDS)).toBe(false);
    expect(isCommandPrompt(prompt(text("please /compact")), COMMANDS)).toBe(false);
    expect(isCommandPrompt(prompt({ type: "image", data: "" }, text("/compact")), COMMANDS)).toBe(false);
  });

  it("counts nothing as a command before the session listed its commands", () => {
    expect(isCommandPrompt(prompt(text("/compact")), null)).toBe(false);
    expect(isCommandPrompt(null, COMMANDS)).toBe(false);
  });
});
