/**
 * The globs of `swf.humanReviewPaths` in a repository's hunt.json, against which the poller (`swf/poller.service.ts`)
 * matches the files of a pull request at its review, free of I/O.
 */

/** A minimal glob: `**` crosses folders, `*` and `?` stay within one; anything else is literal. */
export function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let index = 0; index < glob.length; index++) {
    const character = glob[index];
    if (character === "*" && glob[index + 1] === "*") {
      index++;
      if (glob[index + 1] === "/") {
        index++;
        source += "(?:.*/)?";
      } else {
        source += ".*";
      }
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

/** The files of `files` that match one of `globs`. */
export function matchingFiles(files: string[], globs: string[]): string[] {
  const patterns = globs.map(globToRegExp);
  return files.filter((file) => patterns.some((pattern) => pattern.test(file)));
}
