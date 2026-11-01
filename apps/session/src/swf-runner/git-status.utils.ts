/**
 * The paths of `git status --porcelain -z` (format v1), which the runner reads after a step's gate
 * (`swf-runner.main.ts`): every file the checks changed or the agent left uncommitted, untracked ones included.
 */

/** The paths in `output`: each entry is `XY <path>` ending with NUL, a rename or copy followed by its source path, which is skipped. */
export function changedPathsOf(output: string): string[] {
  const entries = output.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C") index++;
  }
  return paths;
}
