/** The ESLint rules a worktree's flat configs set, one entry per `eslint.config.*` file (see `ide/lint_rules.rs`). */
export type LintRules = { configs: LintConfig[] };

/**
 * One `eslint.config.*` file: `installed` is false when no ESLint resolves from it, `error` is set when importing it
 * failed. `blocks` are its own config objects (not those of a config it spreads) that set a rule to "warn" or "error",
 * or switch off a rule an earlier block enabled.
 */
export type LintConfig = { path: string; installed: boolean; error: string | null; blocks: LintBlock[] };

/** A config object of a flat config: the globs it applies to (none: every file) and the rules it sets. */
export type LintBlock = { files: string[]; ignores: string[]; rules: LintRule[] };

export type LintSeverity = "error" | "warn" | "off";

/** Where a rule comes from: ESLint itself, a plugin installed from a registry, or a plugin that lives in the repository. */
export type LintRuleOrigin = "core" | "package" | "repository";

/** `options` are the entries after the severity; `description` and `url` are the rule's documentation, when it has one. */
export type LintRule = { id: string; severity: LintSeverity; options: unknown[]; description: string | null; url: string | null; origin: LintRuleOrigin };
