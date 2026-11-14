import type { Blame, BlameCommit, LineCommits } from "./blame.types";

/** Characters an annotation gives the author's name; a longer name is cut. */
const AUTHOR_WIDTH = 16;
/** Characters of an annotation: `YYYY-MM-DD`, a space and the author. */
export const ANNOTATION_WIDTH = 10 + 1 + AUTHOR_WIDTH;

/** Lines `startLine`…`endLine` (1-based) of one commit. */
export type BlameRun = { startLine: number; endLine: number; commit: BlameCommit };

/** An edit of a text: the lines `startLine`…`endLine` it replaced and the line breaks of the text it put there. */
export type LineEdit = { startLine: number; endLine: number; insertedLineBreaks: number };

export function lineCommits(blame: Blame): LineCommits {
  return blame.lines.map((index) => (index === null ? null : (blame.commits[index] ?? null)));
}

/** The day a commit was authored in local time, as `YYYY-MM-DD`. */
function authoredDay(commit: BlameCommit): string {
  const date = new Date(commit.authoredAt);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** What the gutter shows beside a line of `commit`: its day and author, `ANNOTATION_WIDTH` characters wide. */
export function annotationOf(commit: BlameCommit): string {
  const author = commit.author.length > AUTHOR_WIDTH ? `${commit.author.slice(0, AUTHOR_WIDTH - 1)}…` : commit.author;
  return `${authoredDay(commit)} ${author}`.padEnd(ANNOTATION_WIDTH);
}

/** The lines of `lines` grouped into runs of neighbours that share a commit; lines without a commit belong to no run. */
export function blameRuns(lines: LineCommits): BlameRun[] {
  const runs: BlameRun[] = [];
  lines.forEach((commit, index) => {
    if (!commit) return;
    const last = runs[runs.length - 1];
    if (last && last.commit === commit && last.endLine === index) {
      last.endLine = index + 1;
    } else {
      runs.push({ startLine: index + 1, endLine: index + 1, commit });
    }
  });
  return runs;
}

/** `lines` after `edits` of one change of the text: every line an edit touched or added has no commit, the others keep theirs. */
export function withEdits(lines: LineCommits, edits: readonly LineEdit[]): LineCommits {
  const next = [...lines];
  // From the bottom up, an edit leaves the line numbers of the edits above it alone.
  for (const edit of [...edits].sort((left, right) => right.startLine - left.startLine)) {
    next.splice(edit.startLine - 1, edit.endLine - edit.startLine + 1, ...new Array<null>(edit.insertedLineBreaks + 1).fill(null));
  }
  return next;
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, "\\$&");
}

/** Markdown of the hover of a line of `commit`: its subject, then author, day and short hash. */
export function blameHover(commit: BlameCommit): string {
  return `**${escapeMarkdown(commit.subject)}**\n\n${escapeMarkdown(commit.author)} · ${authoredDay(commit)} · \`${commit.id.slice(0, 8)}\``;
}
