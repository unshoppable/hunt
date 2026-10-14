/**
 * The configuration of hunt-swf, the gateway's GitHub poller (`swf.ts`), from the gateway's instance metadata, which
 * Terraform sets: `hunt-swf-repos` lists the repositories it checks for open issues labelled SWF_LABEL (comma-separated
 * `<owner>/<repo>`), `hunt-swf-max-sessions` how many of its session VMs may be up at once. The poller reads both at
 * every poll; a missing attribute means no repositories or DEFAULT_MAX_SESSIONS, and no repositories leaves it idle.
 */
import type { Metadata } from "./gcp.ts";

export const REPOS_ATTRIBUTE = "hunt-swf-repos";
export const MAX_SESSIONS_ATTRIBUTE = "hunt-swf-max-sessions";
/** The label that asks for a session; the poller adds `<label>:running`, `<label>:done` and `<label>:failed`. */
export const SWF_LABEL = "swf";
export const DEFAULT_MAX_SESSIONS = 2;
export const MAX_SESSIONS_LIMIT = 10;

export interface SwfConfig {
  /** `<owner>/<repo>` of each repository, in the order the poller checks them. */
  repos: string[];
  /** How many session VMs the poller started may run at once; 0 pauses it. */
  maxSessions: number;
}

/** `<owner>/<repo>` with the characters `hunt-ctl` accepts; no part starts with a dot. */
export const REPOSITORY = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;

export type ParsedSwfConfig = { config: SwfConfig; problems?: undefined } | { config?: undefined; problems: string[] };

/**
 * Validates the values of the two metadata attributes; null or blank values get their defaults. Repositories are
 * trimmed, empty entries skipped and duplicates dropped without regard to case.
 */
export function parseSwfConfig(repos: string | null, maxSessions: string | null): ParsedSwfConfig {
  const problems: string[] = [];

  const parsedRepos: string[] = [];
  for (const entry of (repos ?? "").split(",")) {
    const repo = entry.trim();
    if (!repo) continue;
    if (!REPOSITORY.test(repo)) {
      problems.push(`${REPOS_ATTRIBUTE}: ${JSON.stringify(repo)} is no <owner>/<repo>`);
      continue;
    }
    if (!parsedRepos.some((known) => known.toLowerCase() === repo.toLowerCase())) {
      parsedRepos.push(repo);
    }
  }

  const maxSessionsText = maxSessions?.trim() ?? "";
  const parsedMaxSessions = maxSessionsText ? Number(maxSessionsText) : DEFAULT_MAX_SESSIONS;
  if (!/^\d*$/.test(maxSessionsText) || parsedMaxSessions > MAX_SESSIONS_LIMIT) {
    problems.push(`${MAX_SESSIONS_ATTRIBUTE}: ${JSON.stringify(maxSessionsText)} is no whole number from 0 to ${MAX_SESSIONS_LIMIT}`);
  }

  if (problems.length > 0) return { problems };
  return { config: { repos: parsedRepos, maxSessions: parsedMaxSessions } };
}

/** The configuration in the gateway's instance metadata, read anew at every call; throws for invalid attributes. */
export async function readSwfConfig(metadata: Pick<Metadata, "attribute">): Promise<SwfConfig> {
  const [repos, maxSessions] = await Promise.all([metadata.attribute(REPOS_ATTRIBUTE), metadata.attribute(MAX_SESSIONS_ATTRIBUTE)]);
  const parsed = parseSwfConfig(repos, maxSessions);
  if (parsed.problems) throw new Error(`invalid instance metadata: ${parsed.problems.join("; ")}`);
  return parsed.config;
}
