/**
 * Conventional Commits 1.0 parsing, release-type calculation and release-note rendering. Pure functions, no I/O;
 * `release.ts` feeds them the git log.
 */

export type Bump = "major" | "minor" | "patch";

export interface RawCommit {
  hash: string;
  subject: string;
  body: string;
}

export interface ConventionalCommit {
  hash: string;
  type: string;
  scope: string | undefined;
  description: string;
  breaking: boolean;
}

const HEADER = /^(?<type>[a-z]+)(?:\((?<scope>[^()]*)\))?(?<bang>!)?: (?<description>.+)$/i;
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE: /m;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const BUMP_RANK: Record<Bump, number> = { patch: 1, minor: 2, major: 3 };

/** Parses a commit per Conventional Commits; returns undefined for a subject that does not follow the format. */
export function parseCommit(commit: RawCommit): ConventionalCommit | undefined {
  const match = HEADER.exec(commit.subject.trim());
  if (!match?.groups) return undefined;
  const { type, scope, bang, description } = match.groups;
  return {
    hash: commit.hash,
    type: type.toLowerCase(),
    scope: scope?.trim() || undefined,
    description: description.trim(),
    breaking: Boolean(bang) || BREAKING_FOOTER.test(commit.body),
  };
}

/** Release type a single commit asks for: breaking → major, feat → minor, fix/perf/revert → patch, else none. */
export function bumpOf(commit: ConventionalCommit): Bump | undefined {
  if (commit.breaking) return "major";
  if (commit.type === "feat") return "minor";
  if (commit.type === "fix" || commit.type === "perf" || commit.type === "revert") return "patch";
  return undefined;
}

/** Highest release type across the commits, or undefined when none of them is releasable. */
export function bumpFor(commits: ConventionalCommit[]): Bump | undefined {
  let highest: Bump | undefined;
  for (const commit of commits) {
    const bump = bumpOf(commit);
    if (!bump) continue;
    if (!highest || BUMP_RANK[bump] > BUMP_RANK[highest]) {
      highest = bump;
    }
  }
  return highest;
}

/** Applies a bump to a plain `major.minor.patch` version; pre-release and build suffixes are rejected. */
export function nextVersion(current: string, bump: Bump): string {
  const match = SEMVER.exec(current);
  if (!match) throw new Error(`failed to parse version "${current}": expected major.minor.patch`);
  const [major, minor, patch] = match.slice(1).map(Number);
  switch (bump) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
  }
}

interface NotesSection {
  title: string;
  accepts: (commit: ConventionalCommit) => boolean;
}

/** A commit lands in the first section that accepts it, so a breaking fix is listed once, under breaking changes. */
const SECTIONS: NotesSection[] = [
  { title: "Breaking changes", accepts: (commit) => commit.breaking },
  { title: "Features", accepts: (commit) => commit.type === "feat" },
  { title: "Fixes", accepts: (commit) => commit.type === "fix" || commit.type === "revert" },
  { title: "Performance", accepts: (commit) => commit.type === "perf" },
];

/** Markdown release notes: one `### Title` block per non-empty section, one `- scope: description (hash)` line each. */
export function renderNotes(commits: ConventionalCommit[]): string {
  const blocks: string[] = [];
  const remaining = [...commits];
  for (const section of SECTIONS) {
    const lines: string[] = [];
    for (let index = remaining.length - 1; index >= 0; index--) {
      const commit = remaining[index];
      if (!section.accepts(commit)) continue;
      remaining.splice(index, 1);
      lines.unshift(formatLine(commit));
    }
    if (lines.length > 0) {
      blocks.push(`### ${section.title}\n\n${lines.join("\n")}`);
    }
  }
  return blocks.join("\n\n");
}

function formatLine(commit: ConventionalCommit): string {
  const prefix = commit.scope ? `${commit.scope}: ` : "";
  return `- ${prefix}${commit.description} (${commit.hash.slice(0, 7)})`;
}
