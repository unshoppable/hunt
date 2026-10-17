/**
 * The decisions and texts of hunt-swf (`swf.ts`), free of I/O: which issues get a session, the names of a session's
 * VM and branch, what the poller writes on an issue, the system prompt and `hunt-session.json` of a session, the
 * prompts its agent gets (`apps/gateway/prompts/*.user-prompt.md`, filled here) and the state of the agent the
 * issue's labels report.
 */
import type { Issue, IssueComment, IssueState } from "./github.ts";

/** The VM statuses that do not count towards the session limit; the reaper deletes VMs that stay in them. */
export const STOPPED_STATUSES = new Set(["TERMINATED", "STOPPED"]);
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
  /** The agent asked a question on the issue and waits for the answer. */
  question: string;
  done: string;
  failed: string;
}

export function swfLabels(label: string): SwfLabels {
  return { requested: label, running: `${label}:running`, question: `${label}:question`, done: `${label}:done`, failed: `${label}:failed` };
}

/** The repository labels the poller creates when they are missing. */
export function labelSpecs(labels: SwfLabels): { name: string; color: string; description: string }[] {
  return [
    { name: labels.running, color: "fbca04", description: "Hunt works on this issue on a session VM" },
    { name: labels.question, color: "d876e3", description: "Hunt's agent asked a question on this issue and waits for the answer" },
    { name: labels.done, color: "0e8a16", description: "Hunt opened a pull request for this issue" },
    { name: labels.failed, color: "d93f0b", description: "Hunt could not complete this issue" },
  ];
}

/** The state of a session's agent, as the VM metadata `hunt-agent` records it for Hunt's lists. */
export type AgentState = "running" | "question" | "done" | "failed";

/**
 * The agent state the issue's labels report: `question` while the agent waits for an answer on the issue, `done` once
 * it finished (a closed or deleted issue counts as finished), `failed` when it gave up, `running` otherwise.
 */
export function agentStateOf(issue: { state: IssueState; labels: string[] } | null, labels: SwfLabels): AgentState {
  if (!issue) return "done";
  if (issue.labels.includes(labels.question)) return "question";
  if (issue.labels.includes(labels.done)) return "done";
  if (issue.labels.includes(labels.failed)) return "failed";
  return issue.state === "closed" ? "done" : "running";
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

/** The prefix of the Secret Manager secret that holds a repository's private files (`privateFilesSecret`). */
export const PRIVATE_FILES_SECRET_PREFIX = "HUNT_SWF_FILES_";
/** The first two bytes of a gzip stream. */
const GZIP_MAGIC = [0x1f, 0x8b];

/**
 * The name of the secret that holds the private files of `<owner>/<repo>` as a gzipped tar archive relative to the
 * repository's root: `HUNT_SWF_FILES_<owner>_<repo>`, with every character a secret name cannot hold replaced by `_`.
 */
export function privateFilesSecret(repo: string): string {
  return `${PRIVATE_FILES_SECRET_PREFIX}${repo.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/** Throws when `archive`, the value of the secret `name`, is no gzipped tar archive as `hunt-ctl put-files` expects. */
export function checkPrivateFilesArchive(archive: Uint8Array, name: string): void {
  if (archive.length < GZIP_MAGIC.length || archive[0] !== GZIP_MAGIC[0] || archive[1] !== GZIP_MAGIC[1]) {
    throw new Error(`the secret ${name} is no gzipped tar archive (tar -czf - <files> | gcloud secrets versions add ${name} --data-file=-)`);
  }
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

/** The comment that marks an issue as failed because its agent ended its turn twice without finishing, asking or giving up. */
export function stoppedComment(vm: string): string {
  return (
    "Hunt's agent ended its turn twice without opening a pull request, asking a question or giving up, so this issue is marked as failed. " +
    `The VM \`${vm}\` keeps the session: open it in Hunt to see what happened and to continue.`
  );
}

/** The comment that reports why the session could not start; `error` has been redacted. */
export function failureComment(error: string, vm: string | null): string {
  const kept = vm ? `\n\nThe VM \`${vm}\` stays for inspection.` : "";
  return `Hunt could not start a session for this issue:\n\n\`\`\`\n${error.replace(/`{3,}/g, "``")}\n\`\`\`${kept}`;
}

/** Placeholder for secrets in messages. */
const REDACTED = "[redacted]";
/**
 * Token formats of GitHub and Claude, a JWT (the GitHub App's signed assertion) and a PEM private key, in case one
 * appears that is not among the known secrets.
 */
const TOKEN_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

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

/**
 * The prompt files the poller compiles in: the system-prompt parts of `libs/domain/prompts/`, its own swf system prompt
 * and its user prompts.
 */
export interface PromptFiles {
  remote: string;
  gitPush: string;
  question: string;
  swfSystem: string;
  swfFirst: string;
  swfNudge: string;
}

/**
 * What the relay appends to Claude Code's system prompt, composed like `remote_system_prompt` in
 * `apps/client/src-tauri/src/session/commands.rs` with an empty base: the gateway has none of the desktop user's settings
 * (response style, guardrail offer, diagram language), so the remote part, the Git part for a session with a GitHub
 * token and the part on questions to the user come first, then `swfPrompt`, the filled swf system prompt with the
 * steps of the issue's workflow, then the section on the repository's services and its hunt.agent.md, the last two as
 * `hunt-ctl session-config` reports them (`services_prompt`, `agent_md`).
 */
export function remoteSystemPrompt(prompts: PromptFiles, swfPrompt: string, servicesPrompt: string | null | undefined, agentMd: string | null | undefined): string {
  let prompt = `\n\n${prompts.remote}\n${prompts.gitPush}\n${prompts.question}\n${swfPrompt}`;
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

/** The `gh` command that replaces the label `from` of the issue with `to`. */
function relabelCommand(repo: string, issue: number, from: string, to: string): string {
  return `gh issue edit ${issue} --repo ${repo} --remove-label ${from} --add-label ${to}`;
}

/** `template` with every `{{name}}` replaced by `values[name]`; a placeholder without a value is a bug. */
export function fillPrompt(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (placeholder, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`failed to fill the prompt: no value for ${placeholder}`);
    return value;
  });
}

/** The label placeholders of the swf prompts: the labels and the `gh` commands that move the issue between them. */
function labelValues(repo: string, issue: number, labels: SwfLabels): Record<string, string> {
  const relabel = (label: string) => relabelCommand(repo, issue, labels.running, label);
  return {
    number: String(issue),
    repo,
    requested: labels.requested,
    running: labels.running,
    question: labels.question,
    done: labels.done,
    failed: labels.failed,
    relabelDone: relabel(labels.done),
    relabelFailed: relabel(labels.failed),
    relabelQuestion: relabel(labels.question),
    relabelResume: relabelCommand(repo, issue, labels.question, labels.running),
  };
}

/**
 * The swf part of a poller session's system prompt, `swf.system-prompt.md` filled with the issue's number, repository,
 * branch and the labels the agent is to set: the steps from reading the issue to the pull request and `<label>:done`.
 */
export function swfSystemPrompt(template: string, repo: string, issue: number, branch: string, labels: SwfLabels): string {
  return fillPrompt(template, { ...labelValues(repo, issue, labels), branch });
}

/**
 * The first prompt of a poller session, `swf-first.user-prompt.md` filled with the issue, all its comments and the
 * branch; it sends the agent to the steps of the system prompt.
 */
export function firstPrompt(template: string, repo: string, issue: Issue, comments: IssueComment[], branch: string, labels: SwfLabels): string {
  const thread = comments.length
    ? comments.map((comment) => `**@${comment.author}** on ${formatDate(comment.createdAt)}:\n\n${comment.body.trim()}`).join("\n\n---\n\n")
    : "(none)";
  return fillPrompt(template, {
    ...labelValues(repo, issue.number, labels),
    title: issue.title,
    url: issue.url,
    author: issue.author,
    createdAt: formatDate(issue.createdAt),
    body: issue.body.trim() || "(no description)",
    comments: thread,
    branch,
  });
}

/**
 * The prompt the poller sends when the agent ended its turn with the issue still labelled running (neither a pull
 * request, a question nor a failure was reported): `swf-nudge.user-prompt.md` filled with the issue and its labels.
 */
export function nudgePrompt(template: string, repo: string, issue: number, labels: SwfLabels): string {
  return fillPrompt(template, labelValues(repo, issue, labels));
}
