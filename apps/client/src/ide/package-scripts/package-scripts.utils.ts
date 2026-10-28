/** A key of the top-level `"scripts"` object of a package.json and the 1-based line its opening quote is on. */
export type PackageScriptLine = {
  script: string;
  line: number;
};

/** An object or array the scanner is inside; `isScripts` marks the top-level `"scripts"` object. */
type Container = {
  isObject: boolean;
  isScripts: boolean;
};

/** The string's value; the raw text between the quotes when its escapes are invalid. */
function unescapeJsonString(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

/**
 * The keys directly inside the top-level `"scripts"` object of a package.json's text, in their order, each with its
 * 1-based line. The text may be invalid or incomplete JSON, as while it is being typed: the scan never throws and
 * returns the keys found up to where the structure breaks. A string ends at its line's end, so one left open does not
 * swallow the lines after it. Scanning stops when the top-level value closes.
 */
export function packageScriptLines(text: string): PackageScriptLine[] {
  const scriptLines: PackageScriptLine[] = [];
  const containers: Container[] = [];
  let line = 1;
  /** Whether the next string in the innermost object is a key. */
  let expectsKey = false;
  /** The last key of the top-level object, until its value starts or a comma follows. */
  let topLevelKey: string | null = null;
  let position = 0;
  while (position < text.length) {
    const character = text[position];
    if (character === "\n") {
      line++;
      position++;
      continue;
    }
    if (character === '"') {
      const startLine = line;
      const start = position + 1;
      position = start;
      while (position < text.length && text[position] !== '"' && text[position] !== "\n") {
        position += text[position] === "\\" && text[position + 1] !== "\n" ? 2 : 1;
      }
      const value = unescapeJsonString(text.slice(start, Math.min(position, text.length)));
      if (text[position] === '"') {
        position++;
      }
      const container = containers[containers.length - 1];
      if (container?.isObject && expectsKey) {
        if (container.isScripts) {
          scriptLines.push({ script: value, line: startLine });
        }
        if (containers.length === 1) {
          topLevelKey = value;
        }
        expectsKey = false;
      }
      continue;
    }
    if (character === "{") {
      const isScripts = containers.length === 1 && topLevelKey === "scripts";
      containers.push({ isObject: true, isScripts });
      expectsKey = true;
      topLevelKey = null;
    } else if (character === "[") {
      containers.push({ isObject: false, isScripts: false });
      expectsKey = false;
      topLevelKey = null;
    } else if (character === "}" || character === "]") {
      containers.pop();
      if (!containers.length) break;
      expectsKey = false;
    } else if (character === ",") {
      expectsKey = containers[containers.length - 1]?.isObject ?? false;
      if (containers.length === 1) {
        topLevelKey = null;
      }
    } else if (character === ":") {
      expectsKey = false;
    }
    position++;
  }
  return scriptLines;
}
