import type { PullRequestState, SelectionContext, SessionView } from "../ipc/types";
import { baseName } from "../ui/path";
import { issueLabel, remoteOriginTitle, repositoryLabel } from "./remoteOrigin";

/**
 * The pull request or issue a session works on, shown as `#123` with its own icon on the sidebar's repository line.
 * The tone follows GitHub: an issue is amber, an open pull request green, a draft grey, a merged one purple, a closed
 * one red; `neutral` while the pull request's state is not known yet.
 */
export type SessionReference = { kind: "pullRequest" | "issue"; label: string; title: string; tone: ReferenceTone };
export type ReferenceTone = "amber" | "green" | "grey" | "purple" | "red" | "neutral";

/** The pull request a session reviews (in `pullRequestState` as last fetched), else the issue it works on; null for a session on neither. */
export function sessionReference(session: SessionView, pullRequestState: PullRequestState | null = null): SessionReference | null {
  if (session.pullRequest) {
    const state = pullRequestState ? describePullRequestState(pullRequestState) : null;
    return {
      kind: "pullRequest",
      label: `#${session.pullRequest.number}`,
      title: `Reviews pull request ${session.pullRequest.url}${state ? ` (${state.label})` : ""}`,
      tone: state?.tone ?? "neutral",
    };
  }
  const issue = issueLabel(session);
  if (issue) return { kind: "issue", label: issue, title: remoteOriginTitle(session) ?? "", tone: "amber" };
  return null;
}

/** The word and tone of a pull request's state, as GitHub shows it. */
function describePullRequestState({ state, isDraft }: PullRequestState): { label: string; tone: ReferenceTone } {
  if (state === "MERGED") return { label: "merged", tone: "purple" };
  if (state === "CLOSED") return { label: "closed", tone: "red" };
  if (isDraft) return { label: "draft", tone: "grey" };
  return { label: "open", tone: "green" };
}

/** The session's title for the sidebar, without the `#123 ` of its pull request that older sessions were named with. */
export function sidebarTitle(session: SessionView): string {
  if (!session.pullRequest) return session.title;
  const prefix = `#${session.pullRequest.number} `;
  return session.title.startsWith(prefix) ? session.title.slice(prefix.length) : session.title;
}

/** File name and line range a sub chat was opened from, e.g. `store.ts:L10-L12`, or the folder it is about, e.g. `adr/`. */
export function describeSubChatSource(selection: SelectionContext): string {
  if (selection.isFolder) return `${baseName(selection.path)}/`;
  const fileName = baseName(selection.path);
  const lines = selection.startLine === selection.endLine ? `L${selection.startLine}` : `L${selection.startLine}-L${selection.endLine}`;
  return `${fileName}:${lines}`;
}

/** Second line under a session title: the branch, or for a sub chat the file it was started from. */
export function sessionSubtitle(session: SessionView): string {
  if (!session.parentId) return session.branch;
  return session.selection ? describeSubChatSource(session.selection) : "sub session";
}

/** A row of the sidebar: `repository` is the name of the group the row belongs to (`repositoryLabel` of its top-level session). */
export type SessionRow = { session: SessionView; isSubChat: boolean; repository: string };

/**
 * Sidebar rows grouped by repository: groups in alphabetical order of their name (a session without a known
 * repository last), inside a group the top-level sessions in store order (oldest first), each followed by its sub
 * chats. A sub chat whose parent is gone is listed on top level.
 */
export function groupSessions(sessions: SessionView[]): SessionRow[] {
  const ids = new Set(sessions.map((session) => session.id));
  const topLevel = sessions
    .filter((session) => !(session.parentId && ids.has(session.parentId)))
    .map((session) => ({ session, repository: repositoryLabel(session) }))
    .sort((a, b) => compareRepositories(a.repository, b.repository));
  const rows: SessionRow[] = [];
  for (const { session, repository } of topLevel) {
    rows.push({ session, isSubChat: false, repository });
    for (const child of sessions) {
      if (child.parentId === session.id) {
        rows.push({ session: child, isSubChat: true, repository });
      }
    }
  }
  return rows;
}

/** Group order of the sidebar: repository names case-insensitively, an empty name (no repository known) after all of them. */
function compareRepositories(a: string, b: string): number {
  if (!a || !b) return Number(!a) - Number(!b);
  return a.localeCompare(b, undefined, { sensitivity: "base" });
}

/** The most recently created top-level session: the last one of the list, which is in creation order. */
export function latestTopLevelSession(sessions: SessionView[]): SessionView | null {
  for (let index = sessions.length - 1; index >= 0; index--) {
    if (!sessions[index].parentId) return sessions[index];
  }
  return null;
}

/** Spreadsheet-style letters for a 0-based index: 0 → A, 25 → Z, 26 → AA. */
function letterFor(index: number): string {
  let letters = "";
  for (let rest = index; rest >= 0; rest = Math.floor(rest / 26) - 1) {
    letters = String.fromCharCode(65 + (rest % 26)) + letters;
  }
  return letters;
}

/**
 * Short marks that identify sessions in the sidebar and wherever a session is referenced: top-level sessions get
 * letters (A, B, …) in sidebar order, sub sessions get numbers (1, 2, …) counted per parent. Marks are derived from
 * the current list in its sidebar order (by repository, inside a repository by creation), so they shift only when a
 * session is deleted or one joins a repository group that is not the last.
 */
export function sessionMarks(sessions: SessionView[]): Map<string, string> {
  const marks = new Map<string, string>();
  let topLevelCount = 0;
  let subCount = 0;
  for (const { session, isSubChat } of groupSessions(sessions)) {
    if (isSubChat) {
      subCount += 1;
      marks.set(session.id, String(subCount));
    } else {
      marks.set(session.id, letterFor(topLevelCount));
      topLevelCount += 1;
      subCount = 0;
    }
  }
  return marks;
}

/** Case-insensitive match of every whitespace-separated word of `query` against the title, subtitle and branch. */
function matchesQuery(session: SessionView, words: string[]): boolean {
  const haystack = `${session.title} ${sessionSubtitle(session)} ${session.branch}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/**
 * Rows that match the sidebar search. A top-level session stays when it or one of its sub chats matches, and keeps
 * all its sub chats when it matches itself; otherwise only the matching sub chats are kept. A blank query keeps everything.
 */
export function filterSessionRows(rows: SessionRow[], query: string): SessionRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return rows;
  const result: SessionRow[] = [];
  let index = 0;
  while (index < rows.length) {
    const parent = rows[index];
    const children: SessionRow[] = [];
    index += 1;
    while (index < rows.length && rows[index].isSubChat) {
      children.push(rows[index]);
      index += 1;
    }
    if (matchesQuery(parent.session, words)) {
      result.push(parent, ...children);
      continue;
    }
    const matching = children.filter((child) => matchesQuery(child.session, words));
    if (matching.length > 0) {
      result.push(parent, ...matching);
    }
  }
  return result;
}

/**
 * Session `step` rows away from the active one (1 = next, -1 = previous), wrapping around at both ends. Without an
 * active row in the list, stepping forward starts at the first row and stepping back at the last.
 */
export function cycleSessionId(rows: SessionRow[], activeId: string | null, step: 1 | -1): string | null {
  if (rows.length === 0) return null;
  const index = rows.findIndex(({ session }) => session.id === activeId);
  const next = index === -1 ? (step === 1 ? 0 : rows.length - 1) : (index + step + rows.length) % rows.length;
  return rows[next].session.id;
}

/** Longest stored title: the places that show it cut it to their width, this only guards against a pasted paragraph. */
const TITLE_LENGTH = 200;

/** A GitHub issue or pull request a prompt names by its URL. */
export type IssueRef = { owner: string; name: string; number: number };

const ISSUE_URL = /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d+)(?:[/#?]\S*)?(?=\s|$)/;

/** The issue or pull request whose GitHub URL the first non-empty line of the prompt `text` starts with; else `null`. */
export function issueFromPrompt(text: string): IssueRef | null {
  const match = ISSUE_URL.exec(firstLine(text));
  if (!match) return null;
  return { owner: match[1], name: match[2], number: Number(match[3]) };
}

/**
 * Session title derived from the first prompt: its first line, cut to `TITLE_LENGTH` characters. A line starting
 * with the URL of a GitHub issue or pull request names it as `#<number>` plus the rest of the line; `issueFromPrompt`
 * tells which issue, so the title can get the issue's own title once it is looked up.
 */
export function titleFromPrompt(text: string): string {
  const line = firstLine(text).replace(ISSUE_URL, (_, _owner, _name, number) => `#${number}`);
  return line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH - 1).trimEnd()}…` : line;
}

/** The first non-empty line of `text`, trimmed. */
function firstLine(text: string): string {
  return (text.split("\n").find((line) => line.trim()) ?? text).trim();
}
