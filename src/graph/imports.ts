import { commands } from "../ipc/commands";
import type { GraphEdge } from "../ipc/types";

/** Files whose import statements the diagram reads; `resolve_imports` only knows TypeScript/JavaScript specifiers. */
const SCRIPT_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs"]);
/** The names an import statement takes from a module; `isTypeOnly` when every one of them is a type. */
export type ImportStatement = { specifier: string; names: string[]; isTypeOnly: boolean };

const STATIC_IMPORT = /\b(?:import|export)\s+(type\s+)?([\s\S]*?)\s*from\s*["']([^"']+)["']/g;
const BARE_IMPORT = /\bimport\s*["']([^"']+)["']/g;
const DYNAMIC_IMPORT = /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;

/** Import specifiers of a TypeScript/JavaScript source with the imported names (default, namespace and named). */
export function parseImports(source: string): ImportStatement[] {
  const bySpecifier = new Map<string, { names: Set<string>; isTypeOnly: boolean }>();
  const add = (specifier: string, names: ImportedName[]) => {
    const entry = bySpecifier.get(specifier) ?? { names: new Set<string>(), isTypeOnly: true };
    for (const { name } of names) {
      entry.names.add(name);
    }
    entry.isTypeOnly = entry.isTypeOnly && names.length > 0 && names.every((imported) => imported.isType);
    bySpecifier.set(specifier, entry);
  };
  for (const match of source.matchAll(STATIC_IMPORT)) {
    add(match[3], importedNames(match[2], Boolean(match[1])));
  }
  for (const match of source.matchAll(BARE_IMPORT)) {
    add(match[1], []);
  }
  for (const match of source.matchAll(DYNAMIC_IMPORT)) {
    add(match[1], []);
  }
  return [...bySpecifier].map(([specifier, entry]) => ({ specifier, names: [...entry.names], isTypeOnly: entry.isTypeOnly }));
}

type ImportedName = { name: string; isType: boolean };

/**
 * Local names of an import clause such as `React, { useState, type Foo as Bar }` or `* as monaco`; `isStatementType`
 * for an `import type` clause, where every name is a type.
 */
function importedNames(clause: string, isStatementType: boolean): ImportedName[] {
  const names: ImportedName[] = [];
  const braces = clause.match(/\{([\s\S]*)\}/);
  const outside = clause.replace(/\{[\s\S]*\}/, "");
  for (const part of outside.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const namespace = trimmed.match(/^\*\s+as\s+(\w+)/);
    names.push(namespace ? { name: namespace[1], isType: isStatementType } : { name: trimmed, isType: isStatementType });
  }
  if (braces) {
    for (const part of braces[1].split(",")) {
      const trimmed = part.trim();
      const isType = isStatementType || /^type\s+/.test(trimmed);
      const name = trimmed.replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
      if (!name || name === "*") continue;
      names.push({ name, isType });
    }
  }
  return names.filter(({ name }) => /^\w+$/.test(name));
}

export function isScriptFile(path: string): boolean {
  return SCRIPT_EXTENSIONS.has(path.split(".").pop() ?? "");
}

/**
 * Unlabeled edges for the relative imports of `sources` that point at one of `targets`, read from the worktree; only
 * the agent knows what a dependency is used for. Files that cannot be read (deleted, binary) contribute nothing.
 */
export async function collectImportEdges(sessionId: string, sources: string[], targets: Set<string>): Promise<GraphEdge[]> {
  const perSource = await Promise.all(
    sources.filter(isScriptFile).map(async (source): Promise<GraphEdge[]> => {
      let content: string;
      try {
        content = await commands.readFile(sessionId, source);
      } catch {
        return [];
      }
      const statements = parseImports(content).filter((statement) => statement.specifier.startsWith("."));
      if (!statements.length) return [];
      const resolved = await commands.resolveImports(
        sessionId,
        source,
        statements.map((statement) => statement.specifier),
      );
      return resolved.filter((target): target is string => target !== null && target !== source && targets.has(target)).map((target) => ({ source, target }));
    }),
  );
  return perSource.flat();
}
