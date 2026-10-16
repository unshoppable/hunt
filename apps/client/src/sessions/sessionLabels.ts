import type { SelectionContext, SessionView } from "../ipc/types";
import { baseName } from "../ui/path";
import { issueLabel, remoteOriginTitle } from "./remoteOrigin";

/** The pull request or issue a session works on, shown as `#123` with its own icon on the sidebar's repository line. */
export type SessionReference = { kind: "pullRequest" | "issue"; label: string; title: string };

/** The pull request a session reviews, else the issue it works on; null for a session on neither. */
export function sessionReference(session: SessionView): SessionReference | null {
  if (session.pullRequest) {
    return { kind: "pullRequest", label: `#${session.pullRequest.number}`, title: `Reviews pull request ${session.pullRequest.url}` };
  }
  const issue = issueLabel(session);
  if (issue) return { kind: "issue", label: issue, title: remoteOriginTitle(session) ?? "" };
  return null;
}

/** The session's title for the sidebar, without the `#123 ` of its pull request that older sessions were named with. */
export function sidebarTitle(session: SessionView): string {
  if (!session.pullRequest) return session.title;
  const prefix = `#${session.pullRequest.number} `;
  return session.title.startsWith(prefix) ? session.title.slice(prefix.length) : session.title;
}

/** File name and line range a sub chat was opened from, e.g. `store.ts:L10-L12`. */
export function describeSubChatSource(selection: SelectionContext): string {
  const fileName = baseName(selection.path);
  const lines = selection.startLine === selection.endLine ? `L${selection.startLine}` : `L${selection.startLine}-L${selection.endLine}`;
  return `${fileName}:${lines}`;
}

/** Second line under a session title: the branch, or for a sub chat the file it was started from. */
export function sessionSubtitle(session: SessionView): string {
  if (!session.parentId) return session.branch;
  return session.selection ? describeSubChatSource(session.selection) : "sub session";
}

export type SessionRow = { session: SessionView; isSubChat: boolean };

/** Top-level sessions in store order (oldest first), each followed by its sub chats; a sub chat whose parent is gone is listed on top level. */
export function groupSessions(sessions: SessionView[]): SessionRow[] {
  const ids = new Set(sessions.map((session) => session.id));
  const rows: SessionRow[] = [];
  for (const session of sessions) {
    if (session.parentId && ids.has(session.parentId)) continue;
    rows.push({ session, isSubChat: false });
    for (const child of sessions) {
      if (child.parentId === session.id) {
        rows.push({ session: child, isSubChat: true });
      }
    }
  }
  return rows;
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
 * the current list, which is in creation order, so they shift only when a session is deleted.
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

const TITLE_LENGTH = 48;

/** Session title derived from the first prompt: its first line, trimmed to a sidebar-friendly length. */
export function titleFromPrompt(text: string): string {
  const firstLine = (text.split("\n").find((line) => line.trim()) ?? text).trim();
  return firstLine.length > TITLE_LENGTH ? `${firstLine.slice(0, TITLE_LENGTH - 1).trimEnd()}…` : firstLine;
}
