import { describe, expect, it } from "vitest";
import type { SessionView } from "../sessions/session.types";
import type { LintRule, LintRules } from "./lint-rules.types";
import { filterLintEntries, lintRuleChat, lintRuleEntries, lintRuleRows, lintTask, optionsText, scopeOf } from "./lint-rules.utils";

function rule(id: string, more: Partial<LintRule> = {}): LintRule {
  return { id, severity: "error", options: [], description: null, url: null, origin: "core", ...more };
}

const RULES: LintRules = {
  configs: [
    {
      path: "eslint.config.mjs",
      installed: true,
      error: null,
      blocks: [
        { files: ["**/*.ts"], ignores: [], rules: [rule("eqeqeq", { severity: "warn", description: "Require the use of `===`" }), rule("enum-casing/upper-snake-case-keys", { origin: "repository" })] },
        { files: ["**/*.html"], ignores: ["**/index.html"], rules: [rule("template-max-lines/max-lines", { origin: "repository", options: [{ max: 300 }] })] },
      ],
    },
    { path: "apps/web/eslint.config.mjs", installed: true, error: null, blocks: [{ files: [], ignores: [], rules: [rule("eqeqeq", { url: "https://eslint.org/docs/latest/rules/eqeqeq" }), rule("@nx/dependency-checks", { origin: "package" })] }] },
  ],
};

describe("lintRuleEntries", () => {
  it("lists every rule once by id, with all its uses, the highest severity and the first known documentation", () => {
    const entries = lintRuleEntries(RULES);
    expect(entries.map((entry) => entry.id)).toEqual(["@nx/dependency-checks", "enum-casing/upper-snake-case-keys", "eqeqeq", "template-max-lines/max-lines"]);
    const eqeqeq = entries.find((entry) => entry.id === "eqeqeq");
    expect(eqeqeq?.severity).toBe("error");
    expect(eqeqeq?.description).toBe("Require the use of `===`");
    expect(eqeqeq?.url).toBe("https://eslint.org/docs/latest/rules/eqeqeq");
    expect(eqeqeq?.uses.map((use) => [use.configPath, use.severity])).toEqual([
      ["eslint.config.mjs", "warn"],
      ["apps/web/eslint.config.mjs", "error"],
    ]);
  });
});

describe("filterLintEntries", () => {
  const entries = lintRuleEntries(RULES);

  it("keeps every entry without a query and matches ids and descriptions ignoring case", () => {
    expect(filterLintEntries(entries, "  ")).toBe(entries);
    expect(filterLintEntries(entries, "ENUM").map((entry) => entry.id)).toEqual(["enum-casing/upper-snake-case-keys"]);
    expect(filterLintEntries(entries, "use of").map((entry) => entry.id)).toEqual(["eqeqeq"]);
  });
});

describe("lintRuleRows", () => {
  const entries = lintRuleEntries(RULES);

  it("groups the rules by origin, repository plugins first, and hides the rules of a collapsed group", () => {
    const shown = (collapsed: Set<"core" | "package" | "repository">) =>
      lintRuleRows(entries, collapsed).map((row) => (row.type === "group" ? `${row.label} (${row.count})` : row.entry.id));
    expect(shown(new Set())).toEqual([
      "Repository plugins (2)",
      "enum-casing/upper-snake-case-keys",
      "template-max-lines/max-lines",
      "ESLint (1)",
      "eqeqeq",
      "Installed plugins (1)",
      "@nx/dependency-checks",
    ]);
    expect(shown(new Set(["repository"]))).toEqual(["Repository plugins (2)", "ESLint (1)", "eqeqeq", "Installed plugins (1)", "@nx/dependency-checks"]);
  });
});

describe("scopeOf", () => {
  it("names the globs, the ignored globs, or all files", () => {
    const use = { configPath: "eslint.config.mjs", severity: "error" as const, options: [] };
    expect(scopeOf({ ...use, files: ["**/*.ts", "**/*.tsx"], ignores: [] })).toBe("**/*.ts, **/*.tsx");
    expect(scopeOf({ ...use, files: ["**/*.html"], ignores: ["**/index.html"] })).toBe("**/*.html · except **/index.html");
    expect(scopeOf({ ...use, files: [], ignores: [] })).toBe("All files");
  });
});

describe("optionsText", () => {
  it("shows a single option without its array and several as an array", () => {
    expect(optionsText([])).toBe("");
    expect(optionsText([{ max: 300 }])).toBe('{\n  "max": 300\n}');
    expect(optionsText(["always", "never"])).toBe('[\n  "always",\n  "never"\n]');
  });
});

describe("lintTask and lintRuleChat", () => {
  const eqeqeq = lintRuleEntries(RULES).find((entry) => entry.id === "eqeqeq")!;

  it("names the rule and every place that sets it", () => {
    const task = lintTask(eqeqeq);
    expect(task).toContain("`eqeqeq`");
    expect(task).toContain("- `eslint.config.mjs` (**/*.ts): warn");
    expect(task).toContain("- `apps/web/eslint.config.mjs` (All files): error");
  });

  it("finds the sub chat of the same worktree with the rule's task", () => {
    const task = lintTask(eqeqeq);
    const selection = { path: "eslint.config.mjs", startLine: 1, endLine: 1, text: "", task };
    const sessions = [
      { id: "parent", worktreePath: "/repo", selection: null },
      { id: "other-worktree", worktreePath: "/elsewhere", selection },
      { id: "chat", worktreePath: "/repo", selection },
    ] as unknown as SessionView[];
    expect(lintRuleChat(sessions, "parent", task)).toEqual({ sessionId: "chat", selection });
    expect(lintRuleChat(sessions, "parent", "another task")).toBeNull();
  });
});
