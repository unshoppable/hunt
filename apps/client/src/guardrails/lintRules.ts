import { fillPrompt } from "../../../../libs/domain/src/prompts.ts";
import lintConfigPrompt from "../../prompts/lint-config.system-prompt.md?raw";
import type { LintBlock, LintConfig } from "../ipc/types";
import type { KindHelp } from "./guardrails";

/** Label of the Guardrails window's tab over the ESLint rules. */
export const LINT_TAB_LABEL = "Lint rules";

/** Help popover text of the lint rules tab, in the shape of `kindHelp`. */
export const LINT_HELP: KindHelp = {
  what: "The ESLint rules of the repository's flat configs (eslint.config.*), as the ESLint it installs reads them: per config the rules it switches on, the files they apply to and where each rule comes from. A config that spreads another one shows only what it adds.",
  loading:
    "Claude Code does not load lint rules. An agent learns about a rule only when it runs the linter and a violation fails the run; a CLAUDE.md or a rule that states the convention reaches it before it writes the code.",
  use: "Use a lint rule for a convention a machine can check: it holds for every change, also those no agent makes. A convention that needs judgment belongs in a rule or a CLAUDE.md. The tab only shows the configs; the Agent button lets an agent change the selected one.",
};

/** The task of the sub chat that changes the ESLint configuration, starting from the config at `configPath`. */
export function lintTask(configPath: string): string {
  return fillPrompt(lintConfigPrompt.trim(), { configPath });
}

/** How many rules `config` switches on; a rule switched on in several blocks counts once per block. */
export function enabledRuleCount(config: LintConfig): number {
  return config.blocks.reduce((sum, block) => sum + block.rules.filter((rule) => rule.severity !== "off").length, 0);
}

/** The blocks of `config` with only the rules whose id or description contains `query` (ignoring case); blocks left without a rule are dropped. */
export function filterLintBlocks(config: LintConfig, query: string): LintBlock[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return config.blocks;
  return config.blocks
    .map((block) => ({ ...block, rules: block.rules.filter((rule) => rule.id.toLowerCase().includes(needle) || !!rule.description?.toLowerCase().includes(needle)) }))
    .filter((block) => block.rules.length > 0);
}

/** The files a block applies to, as its heading: its globs, then the ignored ones, or "All files" without globs. */
export function blockScope(block: LintBlock): string {
  const files = block.files.length ? block.files.join(", ") : "All files";
  return block.ignores.length ? `${files} · except ${block.ignores.join(", ")}` : files;
}

/** A rule's options as one line of JSON (a single option without its array), empty without options. */
export function optionsText(options: unknown[]): string {
  if (!options.length) return "";
  return JSON.stringify(options.length === 1 ? options[0] : options);
}
