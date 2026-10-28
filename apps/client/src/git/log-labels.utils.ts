/** A branch or tag label of a commit; `head` is the checked-out branch (`HEAD -> name`) or a detached `HEAD`. */
export type DecorationChip = { kind: "head" | "local" | "remote" | "tag"; name: string };

/**
 * Reads one entry of `git log --decorate`: `HEAD -> master`, `HEAD`, `tag: v1.0`, `origin/master` or `master`. A name
 * with a slash is a local branch only when `localBranches` lists it, since git prints `feat/x` and `origin/x` alike.
 */
export function parseDecoration(decoration: string, localBranches: ReadonlySet<string> = EMPTY): DecorationChip {
  if (decoration.startsWith("HEAD -> ")) return { kind: "head", name: decoration.slice("HEAD -> ".length) };
  if (decoration === "HEAD") return { kind: "head", name: "HEAD" };
  if (decoration.startsWith("tag: ")) return { kind: "tag", name: decoration.slice("tag: ".length) };
  if (decoration.includes("/") && !localBranches.has(decoration)) return { kind: "remote", name: decoration };
  return { kind: "local", name: decoration };
}

const EMPTY: ReadonlySet<string> = new Set();

/** One label at the right end of a log row; `title` names every ref behind it in full. */
export type LogLabel =
  /** A branch, or a local branch together with the remote branches of the same name (`origin & master`). */
  | { kind: "branch"; text: string; title: string; isHead: boolean }
  /** The branches that did not fit: `+2`. */
  | { kind: "more"; text: string; title: string }
  /** The tags of the commit: one tag's name, or the count of several. */
  | { kind: "tags"; text: string; title: string };

/** Branch labels a row shows by name; further branches collapse into one `+n` label. */
const MAX_BRANCH_LABELS = 2;

/**
 * The compact labels of a log row for the commit's decorations, the way IntelliJ's log shows them: a local branch
 * and the remote branches of the same name become one label (`origin & master`), the checked-out branch leads and
 * is marked, long names keep their last two segments (`…/general/x`), at most two branches show by name and the
 * rest collapse into `+n`, and the tags into one label with the tag's name or, for several, their count.
 */
export function logLabels(decorations: readonly string[], head: string | null, localBranches: ReadonlySet<string>): LogLabel[] {
  const chips = decorations.map((decoration) => parseDecoration(decoration, localBranches));
  type Branch = { name: string; remotes: string[]; isLocal: boolean; isHead: boolean };
  const branches: Branch[] = [];
  for (const chip of chips) {
    if (chip.kind !== "head" && chip.kind !== "local") continue;
    branches.push({ name: chip.name, remotes: [], isLocal: true, isHead: chip.kind === "head" || chip.name === head });
  }
  for (const chip of chips) {
    if (chip.kind !== "remote") continue;
    const slash = chip.name.indexOf("/");
    const remote = chip.name.slice(0, slash);
    const local = branches.find((branch) => branch.isLocal && branch.name === chip.name.slice(slash + 1));
    if (local) {
      local.remotes.push(remote);
    } else {
      branches.push({ name: chip.name, remotes: [], isLocal: false, isHead: false });
    }
  }
  branches.sort((left, right) => Number(right.isHead) - Number(left.isHead) || Number(right.isLocal) - Number(left.isLocal));

  const fullNames = (branch: Branch) => [...(branch.isLocal ? [branch.name] : []), ...branch.remotes.map((remote) => `${remote}/${branch.name}`), ...(branch.isLocal ? [] : [branch.name])];
  const labels: LogLabel[] = branches.slice(0, MAX_BRANCH_LABELS).map((branch) => ({
    kind: "branch",
    text: `${branch.remotes.length ? `${branch.remotes.join(" & ")} & ` : ""}${shortRefName(branch.name)}`,
    title: fullNames(branch).join(", "),
    isHead: branch.isHead,
  }));
  const hidden = branches.slice(MAX_BRANCH_LABELS);
  if (hidden.length) {
    labels.push({ kind: "more", text: `+${hidden.length}`, title: hidden.flatMap(fullNames).join(", ") });
  }
  const tags = chips.filter((chip) => chip.kind === "tag").map((chip) => chip.name);
  if (tags.length) {
    labels.push({ kind: "tags", text: tags.length === 1 ? shortRefName(tags[0]) : String(tags.length), title: tags.join(", ") });
  }
  return labels;
}

/** A ref name shortened to its last two segments: `feat/general/x` is `…/general/x`, `origin/master` stays. */
export function shortRefName(name: string): string {
  const segments = name.split("/");
  if (segments.length <= 2) return name;
  return `…/${segments.slice(-2).join("/")}`;
}
