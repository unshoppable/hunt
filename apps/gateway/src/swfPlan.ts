/**
 * The decisions and texts of hunt-swf (`swf.ts`), free of I/O: which issues get a session, the names of a session's
 * VM and branch, what the poller writes on an issue, the system prompt and `hunt-session.json` of a session, and the
 * first prompt its agent gets.
 */
import type { Issue, IssueComment } from "./github.ts";

/** The VM statuses that do not count towards the session limit. */
const STOPPED_STATUSES = new Set(["TERMINATED", "STOPPED"]);
const SLUG_MAX_LENGTH = 40;
/** The scope of every session branch: `<type>/general/<name>`. */
const BRANCH_SCOPE = "general";
/** The issue label (in any case) that makes a session branch a `fix/` branch. */
const BUG_LABEL = "bug";
/** The permission mode of every remote session: nobody is there to answer permission requests. */
export const REMOTE_MODE = "bypassPermissions";

/** The labels the poller works with for the configured `label`. */
export interface SwfLabels {
  requested: string;
  running: string;
  done: string;
  failed: string;
}

export function swfLabels(label: string): SwfLabels {
  return { requested: label, running: `${label}:running`, done: `${label}:done`, failed: `${label}:failed` };
}

/** The repository labels the poller creates when they are missing. */
export function labelSpecs(labels: SwfLabels): { name: string; color: string; description: string }[] {
  return [
    { name: labels.running, color: "fbca04", description: "Hunt works on this issue on a session VM" },
    { name: labels.done, color: "0e8a16", description: "Hunt opened a pull request for this issue" },
    { name: labels.failed, color: "d93f0b", description: "Hunt could not complete this issue" },
  ];
}

/** A new session's IDs: the session ID, its short ID (first 8 hex digits) and its VM. */
export interface SessionNames {
  id: string;
  short: string;
  vm: string;
}

export function sessionNames(id: string): SessionNames {
  const short = id.replace(/-/g, "").slice(0, 8).toLowerCase();
  return { id, short, vm: `vm-hunt-s-${short}` };
}

/** `title` as lowercase ASCII words joined by `-`, at most 40 characters. */
export function slugify(title: string): string {
  const words = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return words.slice(0, SLUG_MAX_LENGTH).replace(/-+$/, "");
}

/**
 * The branch of the session for `issue`: `fix/general/<number>-<slug of the title>` for an issue labelled `bug`,
 * `feat/general/…` for any other, the `<type>/<scope>/<name>` form repositories check branch names against.
 */
export function branchName(issue: Issue): string {
  const type = issue.labels.some((label) => label.toLowerCase() === BUG_LABEL) ? "fix" : "feat";
  const slug = slugify(issue.title);
  return `${type}/${BRANCH_SCOPE}/${slug ? `${issue.number}-${slug}` : issue.number}`;
}

/** The poller's VMs that count towards the limit (any status but stopped) plus the VMs it is creating right now. */
export function activeSessionVms(vms: { name: string; status: string }[], creating: Iterable<string>): Set<string> {
  const active = new Set(creating);
  for (const vm of vms) {
    if (!STOPPED_STATUSES.has(vm.status)) {
      active.add(vm.name);
    }
  }
  return active;
}

export interface Candidate {
  repo: string;
  issue: Issue;
}

/**
 * Splits the open issues with the label, per repository in the configured order, into those that get a session now,
 * oldest first and at most `free` of them, and those that wait for a free slot.
 */
export function issuesToStart(issuesByRepo: { repo: string; issues: Issue[] }[], free: number): { start: Candidate[]; waiting: Candidate[] } {
  const candidates = issuesByRepo.flatMap(({ repo, issues }) => [...issues].sort((a, b) => a.number - b.number).map((issue) => ({ repo, issue })));
  const count = Math.max(0, free);
  return { start: candidates.slice(0, count), waiting: candidates.slice(count) };
}

/** The comment that claims the issue. */
export function claimComment(names: SessionNames, branch: string, domain: string): string {
  return (
    `Hunt started a session for this issue: previews at \`https://${names.short}-<port>.${domain}\` once the agent starts the services.\n\n` +
    `Session \`${names.id}\` on the VM \`${names.vm}\`, branch \`${branch}\`.`
  );
}

/** The comment that reports why the session could not start; `error` has been redacted. */
export function failureComment(error: string, vm: string | null): string {
  const kept = vm ? `\n\nThe VM \`${vm}\` stays for inspection.` : "";
  return `Hunt could not start a session for this issue:\n\n\`\`\`\n${error.replace(/`{3,}/g, "``")}\n\`\`\`${kept}`;
}

/** Placeholder for secrets in messages. */
const REDACTED = "[redacted]";
/** Token formats of GitHub and Claude, in case one appears that is not among the known secrets. */
const TOKEN_PATTERNS = [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, /\bsk-ant-[A-Za-z0-9_-]{20,}/g];

/** `text` with every secret of `secrets` and every token-like string replaced, for logs and issue comments. */
export function redact(text: string, secrets: string[]): string {
  let result = text;
  for (const secret of secrets) {
    if (secret.length >= 8) {
      result = result.split(secret).join(REDACTED);
    }
  }
  for (const pattern of TOKEN_PATTERNS) {
    result = result.replace(pattern, REDACTED);
  }
  return result;
}

/** The remote prompts of `libs/domain/prompts/` a poller session gets. */
export interface RemotePrompts {
  remote: string;
  gitPush: string;
}

/**
 * What the relay appends to Claude Code's system prompt, composed like `remote_system_prompt` in
 * `apps/client/src-tauri/src/session/commands.rs` with an empty base: the gateway has none of the desktop user's settings
 * (response style, guardrail offer, diagram language), so only the remote part, the Git part for a session with a
 * GitHub token, the section on the repository's services and its hunt.agent.md remain, the last two as
 * `hunt-ctl session-config` reports them (`services_prompt`, `agent_md`).
 */
export function remoteSystemPrompt(prompts: RemotePrompts, servicesPrompt: string | null | undefined, agentMd: string | null | undefined): string {
  let prompt = `\n\n${prompts.remote}\n${prompts.gitPush}`;
  const services = servicesPrompt?.trim();
  if (services) {
    prompt += `\n${services}\n`;
  }
  const text = agentMd?.trim();
  if (text) {
    prompt += `\n### The repository's hunt.agent.md\n${text}\n`;
  }
  return prompt;
}

/** `hunt-session.json` of a new poller session, in the shape the desktop's handoff writes. */
export function huntSessionFile(huntSessionId: string, cwd: string, systemPromptAppend: string): string {
  const session = { huntSessionId, acpSessionId: null, cwd, systemPromptAppend, modeId: REMOTE_MODE, configOptions: {} };
  return `${JSON.stringify(session, null, 2)}\n`;
}

/** `2026-10-13T08:04:05Z` as `2026-10-13 08:04 UTC`; other text as it is. */
function formatDate(iso: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return match ? `${match[1]} ${match[2]} UTC` : iso;
}

/** The first prompt of a poller session: the issue with all its comments and what the agent is to do with it. */
export function firstPrompt(repo: string, issue: Issue, comments: IssueComment[], branch: string, labels: SwfLabels): string {
  const body = issue.body.trim() || "(no description)";
  const thread = comments.length
    ? comments.map((comment) => `**@${comment.author}** on ${formatDate(comment.createdAt)}:\n\n${comment.body.trim()}`).join("\n\n---\n\n")
    : "(none)";
  const relabel = (label: string) => `gh issue edit ${issue.number} --repo ${repo} --remove-label ${labels.running} --add-label ${label}`;
  return [
    `Work on GitHub issue #${issue.number} of ${repo}: ${issue.title}`,
    issue.url,
    "",
    `## Issue, opened by @${issue.author} on ${formatDate(issue.createdAt)}`,
    "",
    body,
    "",
    "## Comments",
    "",
    thread,
    "",
    "## Your task",
    "",
    `Hunt's poller started this session because the issue has the label \`${labels.requested}\`. Nobody watches while you work: decide details on your own and name them in the pull request.`,
    "",
    "1. Implement the issue in this repository. Read the README, CLAUDE.md and the other instructions of the repository first.",
    "2. Check your change as a developer would locally: build it and run the tests and linters the repository uses; for changes the user sees, start the app and check it with the Playwright tools.",
    `3. Commit to the current branch \`${branch}\`, push it and open a pull request whose description contains \`Closes #${issue.number}\`.`,
    `4. Comment the pull request's link on the issue: \`gh issue comment ${issue.number} --repo ${repo} --body "…"\`.`,
    `5. Finally replace the label \`${labels.running}\` with \`${labels.done}\`: \`${relabel(labels.done)}\`.`,
    "",
    `When you cannot complete the task, replace \`${labels.running}\` with \`${labels.failed}\` instead (\`${relabel(labels.failed)}\`) and comment on the issue why.`,
  ].join("\n");
}
