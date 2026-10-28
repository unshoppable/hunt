import { describe, expect, it } from "vitest";
import type { AvailableCommand } from "@agentclientprotocol/sdk";
import { matchCommands, slashQueryOf } from "./slash-commands.utils";

const command = (name: string, description = ""): AvailableCommand => ({ name, description });

const COMMANDS = [
  command("compact", "Compact the conversation"),
  command("clear", "Start a new session with empty context"),
  command("claude-api", "Reference for the Claude API"),
  command("simplify", "Review the changed code for cleanups"),
  command("anthropic-skills:deep-research", "Research a topic"),
  command("model", "Pick a model"),
];

describe("slashQueryOf", () => {
  it("returns the text after the slash while the user is still naming the command", () => {
    expect(slashQueryOf("/")).toBe("");
    expect(slashQueryOf("/clea")).toBe("clea");
  });

  it("returns null once there is whitespace or no leading slash", () => {
    expect(slashQueryOf("/clear ")).toBeNull();
    expect(slashQueryOf("/code-review high\n")).toBeNull();
    expect(slashQueryOf("clear")).toBeNull();
    expect(slashQueryOf("")).toBeNull();
  });
});

describe("matchCommands", () => {
  it("lists every command for an empty query, in the agent's order, up to the limit", () => {
    expect(matchCommands(COMMANDS, "").map((item) => item.name)).toEqual(COMMANDS.map((item) => item.name));
    expect(matchCommands(COMMANDS, "", 2).map((item) => item.name)).toEqual(["compact", "clear"]);
  });

  it("ranks name prefixes before name substrings before description matches", () => {
    expect(matchCommands(COMMANDS, "clea").map((item) => item.name)).toEqual(["clear", "simplify"]);
    expect(matchCommands(COMMANDS, "mod").map((item) => item.name)).toEqual(["model"]);
    expect(matchCommands(COMMANDS, "research").map((item) => item.name)).toEqual(["anthropic-skills:deep-research"]);
  });

  it("ignores case", () => {
    expect(matchCommands(COMMANDS, "CL").map((item) => item.name)).toEqual(["clear", "claude-api", "simplify"]);
  });

  it("returns nothing when nothing matches", () => {
    expect(matchCommands(COMMANDS, "zzz")).toEqual([]);
  });
});
