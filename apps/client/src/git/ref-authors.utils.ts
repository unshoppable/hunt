import type { GitRef } from "./git.types";

/** Who wrote the last commit of one or more refs; `login` is the GitHub account, when the email names one. */
export type RefAuthor = { name: string; login: string | null };

/** The GitHub login an email of the form `<id>+<login>@users.noreply.github.com` (or `<login>@users.noreply.github.com`) names. */
export function githubLoginOf(email: string): string | null {
  const match = /^(?:\d+\+)?([^@+]+)@users\.noreply\.github\.com$/i.exec(email);
  return match ? match[1] : null;
}

/**
 * The authors of `refs`, each name once, sorted; the author filter of the branch tree offers them. A name's login is
 * the first of its emails that names a GitHub account.
 */
export function refAuthors(refs: readonly GitRef[]): RefAuthor[] {
  const logins = new Map<string, string | null>();
  for (const ref of refs) {
    if (!ref.author) continue;
    const login = logins.get(ref.author) ?? null;
    logins.set(ref.author, login ?? githubLoginOf(ref.authorEmail));
  }
  return [...logins]
    .map(([name, login]) => ({ name, login }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** The refs whose author is one of `authors`; every ref when `authors` is empty. */
export function refsByAuthors(refs: readonly GitRef[], authors: readonly string[]): GitRef[] {
  return authors.length ? refs.filter((ref) => authors.includes(ref.author)) : [...refs];
}
