/**
 * The prompts of a poller session (`swf/poller.service.ts`), free of I/O: the session's system prompt and its
 * `hunt-session.json`, and the prompts its agent gets (`apps/gateway/software-factory/*.user-prompt.md`, filled here).
 * The labels of the workflow are `WorkflowLabels` in `libs/domain/src/swf/`.
 */
import type { Repository } from "../../../../libs/domain/src/session/repository.value-object.ts";
import type { SessionId } from "../../../../libs/domain/src/session/session-id.value-object.ts";
import { fillPrompt } from "../../../../libs/domain/src/shared/prompts.utils.ts";
import type { WorkflowLabels } from "../../../../libs/domain/src/swf/workflow-labels.value-object.ts";
import { isAgentStep, type SwfStep } from "../../../../libs/domain/src/swf/swf-step.types.ts";
import type { Issue, IssueComment } from "./github.client.ts";
import { MAX_ATTEMPTS, type Pipeline } from "./pipeline.domain.ts";

/** The permission mode of every remote session: nobody is there to answer permission requests. */
export const REMOTE_MODE = "bypassPermissions";

/** The prompt files the poller compiles in: the system-prompt parts of `libs/domain/prompts/`, its own swf system prompt and its user prompts. */
export interface PromptFiles {
  remote: string;
  gitPush: string;
  question: string;
  /** The part on `.hunt/sessions.md`, with the `{{huntSessionId}}` placeholder. */
  sessions: string;
  swfSystem: string;
  /** The user prompt of each agent step. */
  swfPlan: string;
  swfImplement: string;
  swfEscalate: string;
  swfVerify: string;
  swfGate: string;
  swfPr: string;
  swfNudge: string;
  swfAnswer: string;
  /** The prompt that tells the agent its step result is unusable, with the `{{problem}}` placeholder. */
  swfBadResult: string;
}

/**
 * What the relay appends to Claude Code's system prompt, composed like `remote_system_prompt` in
 * `apps/client/src-tauri/src/session/commands/remote.rs` with an empty base: the gateway has none of the desktop user's settings
 * (response style, guardrail offer, diagram language), so the remote part, the Git part for a session with a GitHub
 * token, the part on questions to the user and the part on the sessions file, filled with the Hunt session id
 * `huntSessionId`, come first, then `swfPrompt`, the filled swf system prompt with the steps of the issue's workflow,
 * then the section on the repository's services and its hunt.agent.md, the last two as `hunt-ctl session-config`
 * reports them (`services_prompt`, `agent_md`).
 */
export function remoteSystemPrompt(
  prompts: PromptFiles,
  huntSessionId: SessionId,
  swfPrompt: string,
  servicesPrompt: string | null | undefined,
  agentMd: string | null | undefined,
): string {
  const sessions = fillPrompt(prompts.sessions, { huntSessionId: huntSessionId.id });
  let prompt = `\n\n${prompts.remote}\n${prompts.gitPush}\n${prompts.question}\n${sessions}\n${swfPrompt}`;
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

/**
 * `hunt-session.json` of a new poller session, in the shape the desktop's handoff writes; `model`, the `swf.model` of the
 * repository's hunt.json as `hunt-ctl session-config` reports it (`swf_model`), becomes the config option `model`, and
 * without one Claude Code's default model applies.
 */
export function huntSessionFile(huntSessionId: SessionId, cwd: string, systemPromptAppend: string, model: string | null): string {
  const configOptions = model ? { model } : {};
  const session = { huntSessionId: huntSessionId.id, acpSessionId: null, cwd, systemPromptAppend, modeId: REMOTE_MODE, configOptions };
  return `${JSON.stringify(session, null, 2)}\n`;
}

/** `2026-10-13T08:04:05Z` as `2026-10-13 08:04 UTC`; other text as it is. */
function formatDate(iso: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return match ? `${match[1]} ${match[2]} UTC` : iso;
}

/** The `gh` command that replaces the label `from` of the issue with `to`. */
function relabelCommand(repo: Repository, issue: number, from: string, to: string): string {
  return `gh issue edit ${issue} --repo ${repo.slug} --remove-label ${from} --add-label ${to}`;
}

/** The placeholders every swf prompt may use: the issue, the labels and the commands that move between them at `step`. */
function labelValues(repo: Repository, issue: number, labels: WorkflowLabels, step: SwfStep): Record<string, string> {
  const stepLabel = labels.step(step);
  return {
    number: String(issue),
    repo: repo.slug,
    requested: labels.requested,
    step,
    stepLabel,
    question: labels.question,
    done: labels.done,
    failed: labels.failed,
    relabelFailed: relabelCommand(repo, issue, stepLabel, labels.failed),
    relabelQuestion: relabelCommand(repo, issue, stepLabel, labels.question),
    relabelResume: relabelCommand(repo, issue, labels.question, stepLabel),
  };
}

/**
 * The swf part of a poller session's system prompt, `0-system-prompt.md` filled with the issue's number, repository
 * and branch: the protocol of the steps, how to ask a question and how to give up.
 */
export function swfSystemPrompt(template: string, repo: Repository, issue: number, branch: string, labels: WorkflowLabels): string {
  return fillPrompt(template, { ...labelValues(repo, issue, labels, "plan"), branch, maxAttempts: String(MAX_ATTEMPTS) });
}

/** `template` filled with `values`, without the final line break of its file: a prompt sent or inserted as it is. */
function fillFragment(template: string, values: Record<string, string>): string {
  return fillPrompt(template.trimEnd(), values);
}

/** The findings of an implement step as a Markdown list; `(none)` without any. */
function formatFindings(findings: string[]): string {
  if (findings.length === 0) return "(none)";
  return findings.map((finding) => `- ${finding.replace(/\n/g, "\n  ")}`).join("\n");
}

/**
 * The prompt of the step the pipeline is at, for the agent steps: `1-plan.user-prompt.md` with the issue, all its
 * comments and the branch; `2-implement.user-prompt.md` with the findings to fix (`2-implement-escalate.user-prompt.md` when
 * the agent is to ask the humans instead); `3-verify`, `4-gate` and `5-pr`. Every prompt carries the issue, the
 * step's label, the commands that move the issue to the question label and back and, as `skill`, the repository's skill
 * for the step (`skillOf` of the pipeline).
 */
export function stepPrompt(
  prompts: PromptFiles,
  repo: Repository,
  issue: Issue,
  comments: IssueComment[],
  branch: string,
  labels: WorkflowLabels,
  pipeline: Pipeline,
): string {
  const attemptNote = pipeline.attempt > 0 ? ` (attempt ${pipeline.attempt} of ${MAX_ATTEMPTS})` : "";
  const values: Record<string, string> = { ...labelValues(repo, issue.number, labels, pipeline.step), branch, attemptNote, maxAttempts: String(MAX_ATTEMPTS) };
  if (isAgentStep(pipeline.step)) {
    values.skill = pipeline.skillOf(pipeline.step);
  }
  switch (pipeline.step) {
    case "plan":
      return fillPrompt(prompts.swfPlan, {
        ...values,
        title: issue.title,
        url: issue.url,
        author: issue.author,
        createdAt: formatDate(issue.createdAt),
        body: issue.body.trim() || "(no description)",
        comments: formatThread(comments),
      });
    case "implement":
      return fillPrompt(pipeline.escalate ? prompts.swfEscalate : prompts.swfImplement, { ...values, findings: formatFindings(pipeline.findings) });
    case "verify":
      return fillPrompt(prompts.swfVerify, values);
    case "gate":
      return fillPrompt(prompts.swfGate, {
        ...values,
        pullRequest: pipeline.pullRequest === null ? "(not opened yet)" : `#${pipeline.pullRequest}`,
      });
    case "pr":
      return fillPrompt(prompts.swfPr, { ...values, humanReview: pipeline.humanReview ? "yes" : "no" });
    default:
      throw new Error(`the step ${pipeline.step} has no prompt for the agent`);
  }
}

/** The comments as a Markdown thread, each with its author and date; `(none)` without any. */
function formatThread(comments: IssueComment[]): string {
  if (comments.length === 0) return "(none)";
  return comments.map((comment) => `**@${comment.author}** on ${formatDate(comment.createdAt)}:\n\n${comment.body.trim()}`).join("\n\n---\n\n");
}

/**
 * The prompt that brings the answers `answers` from the issue to an agent that waits with the question label:
 * `answer.user-prompt.md` filled with the comments and the command that takes the label back to the step.
 */
export function answerPrompt(template: string, repo: Repository, issue: number, answers: IssueComment[], labels: WorkflowLabels, step: SwfStep): string {
  return fillPrompt(template, { ...labelValues(repo, issue, labels, step), comments: formatThread(answers) });
}

/**
 * The prompt the poller sends when the agent ended its turn with the issue still at its step (no step result, no
 * question, no failure was reported): `nudge.user-prompt.md` filled with the issue, the step and its labels.
 */
export function nudgePrompt(template: string, repo: Repository, issue: number, labels: WorkflowLabels, step: SwfStep): string {
  return fillPrompt(template, labelValues(repo, issue, labels, step));
}

/**
 * The prompt the poller sends when the agent's step result is unusable (`problem`, why): `bad-result.user-prompt.md`
 * filled with the problem, which asks the agent to post the result again.
 */
export function badResultPrompt(template: string, problem: string): string {
  return fillFragment(template, { problem });
}
