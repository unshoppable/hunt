/** Module specifiers a TypeScript/JavaScript source imports: `import … from "x"`, `import "x"`, `export … from "x"`, `require("x")`, `import("x")`. */
const SPECIFIER_PATTERNS = [
  /\b(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"\n]+)['"]/g,
  /\bimport\s*['"]([^'"\n]+)['"]/g,
  /\b(?:require|import)\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
];

/** Distinct specifiers in order of first appearance. */
export function parseImportSpecifiers(source: string): string[] {
  const found = new Map<string, number>();
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (!found.has(specifier)) {
        found.set(specifier, match.index ?? 0);
      }
    }
  }
  return [...found.entries()].sort((left, right) => left[1] - right[1]).map(([specifier]) => specifier);
}
