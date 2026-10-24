import { describe, expect, it } from "vitest";
import type { LintBlock, LintConfig, LintRule } from "../ipc/types";
import { blockScope, enabledRuleCount, filterLintBlocks, lintTask, optionsText } from "./lintRules";

function rule(id: string, more: Partial<LintRule> = {}): LintRule {
  return { id, severity: "error", options: [], description: null, url: null, origin: "core", ...more };
}

function config(blocks: LintBlock[]): LintConfig {
  return { path: "eslint.config.mjs", installed: true, error: null, blocks };
}

describe("enabledRuleCount", () => {
  it("counts the rules switched on in every block, not those switched off", () => {
    const counted = config([
      { files: ["**/*.ts"], ignores: [], rules: [rule("eqeqeq"), rule("curly", { severity: "warn" })] },
      { files: ["**/*.spec.ts"], ignores: [], rules: [rule("curly", { severity: "off" }), rule("eqeqeq")] },
    ]);
    expect(enabledRuleCount(counted)).toBe(3);
  });
});

describe("filterLintBlocks", () => {
  const filtered = config([
    { files: ["**/*.ts"], ignores: [], rules: [rule("eqeqeq", { description: "Require the use of `===`" }), rule("enum-casing/upper-snake-case-keys")] },
    { files: ["**/*.html"], ignores: [], rules: [rule("template-max-lines/max-lines")] },
  ]);

  it("keeps every block without a query", () => {
    expect(filterLintBlocks(filtered, "  ")).toBe(filtered.blocks);
  });

  it("matches ids and descriptions ignoring case and drops blocks without a match", () => {
    expect(filterLintBlocks(filtered, "ENUM").map((block) => block.rules.map((match) => match.id))).toEqual([["enum-casing/upper-snake-case-keys"]]);
    expect(filterLintBlocks(filtered, "use of").map((block) => block.rules.map((match) => match.id))).toEqual([["eqeqeq"]]);
    expect(filterLintBlocks(filtered, "nothing")).toEqual([]);
  });
});

describe("blockScope", () => {
  it("names the globs, the ignored globs, or all files", () => {
    expect(blockScope({ files: ["**/*.ts", "**/*.tsx"], ignores: [], rules: [] })).toBe("**/*.ts, **/*.tsx");
    expect(blockScope({ files: ["**/*.html"], ignores: ["**/index.html"], rules: [] })).toBe("**/*.html · except **/index.html");
    expect(blockScope({ files: [], ignores: [], rules: [] })).toBe("All files");
  });
});

describe("optionsText", () => {
  it("shows a single option without its array and several as an array", () => {
    expect(optionsText([])).toBe("");
    expect(optionsText([{ max: 300 }])).toBe('{"max":300}');
    expect(optionsText(["always", { null: "ignore" }])).toBe('["always",{"null":"ignore"}]');
  });
});

describe("lintTask", () => {
  it("names the config the agent starts from", () => {
    expect(lintTask("apps/web/eslint.config.mjs")).toContain("`apps/web/eslint.config.mjs`");
  });
});
