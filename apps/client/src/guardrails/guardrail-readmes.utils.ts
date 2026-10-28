import adrReadme from "../../prompts/adr.readme.md?raw";
import rulesReadme from "../../prompts/rules.readme.md?raw";
import { commands } from "../ipc/commands";
import type { GuardrailDirs } from "./guardrail.types";

const README_FILE = "README.md";

/** Guardrail kinds whose folder gets a README explaining when to write that kind rather than the other. */
export type ReadmeKind = "rule" | "adr";

const TEMPLATES: Record<ReadmeKind, string> = { rule: rulesReadme, adr: adrReadme };

/** The README of the `kind` folder, with the configured folders filled in. */
export function guardrailReadme(kind: ReadmeKind, dirs: GuardrailDirs): string {
  return TEMPLATES[kind].replace(/{{ruleDir}}/g, dirs.rule).replace(/{{adrDir}}/g, dirs.adr);
}

/** Whether a folder with these entries needs the README: it holds a guardrail (a Markdown file or, for rules, a subfolder) but no README. */
export function needsReadme(kind: ReadmeKind, entries: { name: string; isDir: boolean }[]): boolean {
  if (entries.some((entry) => !entry.isDir && entry.name.toLowerCase() === README_FILE.toLowerCase())) return false;
  return entries.some((entry) => (entry.isDir ? kind === "rule" : entry.name.toLowerCase().endsWith(".md")));
}

/**
 * Writes the README into the configured rules and ADR folders of the session's worktree once a folder holds its first
 * guardrail, so that people and agents adding one there learn which of the two kinds fits. An existing README is never
 * touched. Failures are reported to the console only, since the README is a courtesy that must not disturb the caller.
 */
export async function ensureGuardrailReadmes(sessionId: string, dirs: GuardrailDirs): Promise<void> {
  const kinds: ReadmeKind[] = ["rule", "adr"];
  await Promise.all(
    kinds.map(async (kind) => {
      try {
        const entries = await commands.listDir(sessionId, dirs[kind]).catch(() => []);
        if (!needsReadme(kind, entries)) return;
        await commands.writeFile(sessionId, `${dirs[kind]}/${README_FILE}`, guardrailReadme(kind, dirs));
      } catch (error) {
        console.error(`failed to write the README of ${dirs[kind]}:`, error);
      }
    }),
  );
}
