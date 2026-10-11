/** Compiled patterns by glob text; the icon rules repeat the same few globs for every file. */
const compiled = new Map<string, RegExp>();

/** Characters that mean something in a RegExp and nothing in a glob. */
const REGEXP_SPECIALS = /[.+^$(){}|[\]\\]/;

/**
 * Compiles a glob into a case-insensitive RegExp over a worktree-relative path with "/" separators: `**` spans
 * folders, `*` and `?` stay within one name, `{a,b}` lists alternatives (nesting allowed). A glob without a "/"
 * (`*.spec.ts`) matches the file name in any folder; a trailing `/**` also matches the folder itself. Unbalanced
 * braces are taken literally.
 */
export function globToRegExp(glob: string): RegExp {
  let pattern = glob.trim().replace(/^(\.\/|\/)+/, "");
  if (!pattern.includes("/")) {
    pattern = `**/${pattern}`;
  }
  const hasBraces = hasBalancedBraces(pattern);
  let source = "";
  let depth = 0;
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      const isSegmentStart = index === 0 || pattern[index - 1] === "/";
      if (isSegmentStart && pattern[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
      continue;
    }
    if (char === "/" && pattern.slice(index + 1) === "**") {
      source += "(?:/.*)?";
      break;
    }
    if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else if (hasBraces && char === "{") {
      source += "(?:";
      depth++;
    } else if (hasBraces && char === "}" && depth > 0) {
      source += ")";
      depth--;
    } else if (char === "," && depth > 0) {
      source += "|";
    } else {
      source += REGEXP_SPECIALS.test(char) ? `\\${char}` : char;
    }
  }
  return new RegExp(`^${source}$`, "i");
}

/** Whether every "{" is closed by a later "}" and there is at least one pair. */
function hasBalancedBraces(pattern: string): boolean {
  let depth = 0;
  for (const char of pattern) {
    if (char === "{") {
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0 && pattern.includes("{");
}

/** Whether the worktree-relative `path` matches `glob` (see globToRegExp); an empty glob matches nothing. */
export function matchesGlob(glob: string, path: string): boolean {
  if (!glob.trim()) return false;
  let regExp = compiled.get(glob);
  if (!regExp) {
    regExp = globToRegExp(glob);
    compiled.set(glob, regExp);
  }
  return regExp.test(path.replace(/^(\.\/|\/)+/, ""));
}
