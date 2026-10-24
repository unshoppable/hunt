import { fillPrompt } from "../../../../libs/domain/src/prompts.ts";
import lintRulePrompt from "../../prompts/lint-rule.system-prompt.md?raw";
import type { SelectionChat } from "../ide/selectionChats";
import type { LintRuleOrigin, LintRules, LintSeverity, SessionView } from "../ipc/types";
import type { KindHelp } from "./guardrails";

/** Label of the Guardrails window's tab over the ESLint rules. */
export const LINT_TAB_LABEL = "Lint rules";

/** Help popover text of the lint rules tab, in the shape of `kindHelp`. */
export const LINT_HELP: KindHelp = {
  what: "The ESLint rules of the repository's flat configs (eslint.config.*), as the ESLint it installs reads them: every rule a config switches on, once, with what it checks and every config and file glob that sets it.",
  loading:
    "Claude Code does not load lint rules. An agent learns about a rule only when it runs the linter and a violation fails the run; a CLAUDE.md or a rule that states the convention reaches it before it writes the code.",
  use: "Use a lint rule for a convention a machine can check: it holds for every change, also those no agent makes. A convention that needs judgment belongs in a rule or a CLAUDE.md. The tab only shows the rules; the Agent button lets an agent change the selected one.",
};

/** One place a rule is set: a block of the config at `configPath`, for the files its globs match. */
export type LintRuleUse = { configPath: string; files: string[]; ignores: string[]; severity: LintSeverity; options: unknown[] };

/** A rule with every place that sets it; `severity` is the highest of its uses. */
export type LintRuleEntry = { id: string; description: string | null; url: string | null; origin: LintRuleOrigin; severity: LintSeverity; uses: LintRuleUse[] };

/** The groups of the rule list, in display order. */
export const ORIGIN_GROUPS: { origin: LintRuleOrigin; label: string }[] = [
  { origin: "repository", label: "Repository plugins" },
  { origin: "core", label: "ESLint" },
  { origin: "package", label: "Installed plugins" },
];

const SEVERITY_RANK: Record<LintSeverity, number> = { off: 0, warn: 1, error: 2 };

/** Every rule the configs of `rules` set, once, sorted by id, with its uses in config order. */
export function lintRuleEntries(rules: LintRules): LintRuleEntry[] {
  const entries = new Map<string, LintRuleEntry>();
  for (const config of rules.configs) {
    for (const block of config.blocks) {
      for (const rule of block.rules) {
        const use = { configPath: config.path, files: block.files, ignores: block.ignores, severity: rule.severity, options: rule.options };
        const entry = entries.get(rule.id);
        if (!entry) {
          entries.set(rule.id, { id: rule.id, description: rule.description, url: rule.url, origin: rule.origin, severity: rule.severity, uses: [use] });
          continue;
        }
        entry.uses.push(use);
        entry.description ??= rule.description;
        entry.url ??= rule.url;
        if (SEVERITY_RANK[rule.severity] > SEVERITY_RANK[entry.severity]) {
          entry.severity = rule.severity;
        }
      }
    }
  }
  return [...entries.values()].sort((left, right) => left.id.localeCompare(right.id));
}

/** The entries whose id or description contains `query`, ignoring case. */
export function filterLintEntries(entries: LintRuleEntry[], query: string): LintRuleEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return entries;
  return entries.filter((entry) => entry.id.toLowerCase().includes(needle) || !!entry.description?.toLowerCase().includes(needle));
}

export type LintRuleRow = { type: "group"; origin: LintRuleOrigin; label: string; count: number } | { type: "rule"; entry: LintRuleEntry };

/** The rows of the rule list: a heading per origin that has rules, followed by its rules unless it is in `collapsed`. */
export function lintRuleRows(entries: LintRuleEntry[], collapsed: ReadonlySet<LintRuleOrigin>): LintRuleRow[] {
  const rows: LintRuleRow[] = [];
  for (const { origin, label } of ORIGIN_GROUPS) {
    const members = entries.filter((entry) => entry.origin === origin);
    if (!members.length) continue;
    rows.push({ type: "group", origin, label, count: members.length });
    if (collapsed.has(origin)) continue;
    for (const entry of members) {
      rows.push({ type: "rule", entry });
    }
  }
  return rows;
}

/** The files a use applies to: its globs, then the ignored ones, or "All files" without globs. */
export function scopeOf(use: LintRuleUse): string {
  const files = use.files.length ? use.files.join(", ") : "All files";
  return use.ignores.length ? `${files} · except ${use.ignores.join(", ")}` : files;
}

/** A rule's options as indented JSON (a single option without its array), empty without options. */
export function optionsText(options: unknown[]): string {
  if (!options.length) return "";
  return JSON.stringify(options.length === 1 ? options[0] : options, null, 2);
}

/** The task of the sub chat that changes the rule of `entry`, naming every place that sets it. */
export function lintTask(entry: LintRuleEntry): string {
  const uses = entry.uses.map((use) => `- \`${use.configPath}\` (${scopeOf(use)}): ${use.severity}`).join("\n");
  return fillPrompt(lintRulePrompt.trim(), { ruleId: entry.id, uses });
}

/**
 * The sub chat of `sessionId`'s worktree whose task is `task` (see `lintTask`), the newest first in `sessions`; a
 * changed set of uses gives a new task and thereby a new chat.
 */
export function lintRuleChat(sessions: SessionView[], sessionId: string, task: string): SelectionChat | null {
  const worktreePath = sessions.find((session) => session.id === sessionId)?.worktreePath;
  if (!worktreePath) return null;
  const session = sessions.find((candidate) => candidate.worktreePath === worktreePath && candidate.selection?.task === task);
  return session?.selection ? { sessionId: session.id, selection: session.selection } : null;
}
