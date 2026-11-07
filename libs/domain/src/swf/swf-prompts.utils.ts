/**
 * The prompts of a swf session, free of I/O: the session's system prompt and its `hunt-session.json`, which the gateway's
 * poller writes at the setup (`apps/gateway/src/swf/poller.service.ts`), and the prompts its agent gets
 * (`libs/domain/prompts/swf/*.user-prompt.md`, filled here), which the runner on the session VM sends
 * (`apps/session/src/swf-runner/swf-runner.service.ts`). The labels of the workflow are `WorkflowLabels` beside this file.
 */
import { Repository } from "../session/repository.value-object.ts";
import type { SessionId } from "../session/session-id.value-object.ts";
import { fillPrompt } from "../shared/prompts.utils.ts";
import type { WorkflowLabels } from "./workflow-labels.value-object.ts";
import { isAgentStep, type SwfStep } from "./swf-step.types.ts";
import type { Pipeline } from "./pipeline.domain.ts";

/** How many of the last lines of a failed check's output the gate prompt quotes. */
const GATE_OUTPUT_LINES = 80;

/** What the plan prompt tells of the issue; the gateway's `Issue` and the runner's `gh issue view` both give it. */
export interface IssueText {
  number: number;
  title: string;
  body: string;
  author: string;
  /** ISO 8601. */
  createdAt: string;
  url: string;
}

/** A comment of the issue's thread as the prompts quote it. */
export interface CommentText {
  author: string;
  createdAt: string;
  body: string;
}

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
  swfReview: string;
  swfPr: string;
  swfNudge: string;
  /** The prompt that sends the agent on with its step after a person's command or a resume ended or interrupted its turn. */
  swfContinue: string;
  swfAnswer: string;
  /** The prompt that tells the agent its step result is unusable, with the `{{problem}}` placeholder. */
  swfBadResult: string;
  /** The prompt that gives the agent its step result back because the step's gate failed, and the one past `maxGateRuns`. */
  swfGateFailed: string;
  swfGateEscalate: string;
}

/**
 * A check of a step's gate that failed on the step's result: its name in hunt.json, its exit code (null when it was
 * killed or timed out) and its output. `dirty` names the files the checks changed or left uncommitted; a failure with
 * dirty files and exit code 0 failed because of them alone.
 */
export interface GateFailure {
  name: string;
  exitCode: number | null;
  output: string;
  dirty?: string[];
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
 * `hunt-session.json` of a new poller session, in the shape the desktop's handoff writes; `configOptions` are the config
 * options of the conversation (`model`, `effort`; `configOptionsOf` of the pipeline for a step), and Claude Code's default
 * applies to each option they leave out.
 */
export function huntSessionFile(huntSessionId: SessionId, cwd: string, systemPromptAppend: string, configOptions: Record<string, string>): string {
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

/**
 * The placeholders every swf prompt may use: the issue, the labels and the commands that move between them at `step`,
 * and `questionPrefix`, what the repository puts in front of the title of an issue with an open question (`swf.questionPrefix`).
 */
function labelValues(repo: Repository, issue: number, labels: WorkflowLabels, step: SwfStep, questionPrefix: string): Record<string, string> {
  const stepLabel = labels.step(step);
  return {
    number: String(issue),
    repo: repo.slug,
    requested: labels.requested,
    step,
    stepLabel,
    questionPrefix,
    question: labels.question,
    done: labels.done,
    failed: labels.failed,
    relabelFailed: relabelCommand(repo, issue, stepLabel, labels.failed),
    relabelQuestion: relabelCommand(repo, issue, stepLabel, labels.question),
    relabelResume: relabelCommand(repo, issue, labels.question, stepLabel),
  };
}

/**
 * The swf part of a poller session's system prompt, `0-system-prompt.md` filled with the issue's number and repository
 * and the repository's question prefix: the protocol of the steps, how to ask a question and how to give up. The branch
 * is not in it: the plan step creates it.
 */
export function swfSystemPrompt(template: string, repo: Repository, issue: number, labels: WorkflowLabels, questionPrefix: string): string {
  return fillPrompt(template, labelValues(repo, issue, labels, "plan", questionPrefix));
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
 * The prompt of the step the pipeline is at, for the agent steps: `1-plan.user-prompt.md` with the issue and all its
 * comments (the plan step creates the branch and reports it); `2-implement.user-prompt.md` with the branch, the findings
 * to fix and, after a return, which step sent the change back how often of its limit (`2-implement-escalate.user-prompt.md`,
 * with that step and its limit, when the agent is to ask the humans instead); `3-verify`, `4-review` (with the pull
 * request, when it exists) and `5-pr`, each with the branch of the pipeline.
 * Every prompt carries the issue, the step's label, the commands that move the issue to the question label and back, the
 * repository's question prefix and, as `skill`, the repository's skill for the step (`skillOf` of the pipeline).
 */
export function stepPrompt(prompts: PromptFiles, repo: Repository, issue: IssueText, comments: CommentText[], labels: WorkflowLabels, pipeline: Pipeline): string {
  const values: Record<string, string> = { ...labelValues(repo, issue.number, labels, pipeline.step, pipeline.settings.questionPrefix), branch: pipeline.branch };
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
    case "implement": {
      const findings = formatFindings(pipeline.findings);
      const cause = pipeline.causeOf;
      if (pipeline.escalate) {
        const limit = cause === null ? null : pipeline.limitOf(cause);
        return fillPrompt(prompts.swfEscalate, {
          ...values,
          findings,
          causeStep: cause === null ? "a later step" : `\`${cause}\``,
          maxReturns: limit === null ? "the allowed number of" : String(limit),
        });
      }
      const attemptNote = cause === null ? "" : ` (${pipeline.returnCountOf(cause)}, sent back by ${cause})`;
      return fillPrompt(prompts.swfImplement, { ...values, findings, attemptNote });
    }
    case "verify":
      return fillPrompt(prompts.swfVerify, values);
    case "review":
      return fillPrompt(prompts.swfReview, {
        ...values,
        pullRequest: pipeline.pullRequest === null ? "(not opened yet)" : `#${pipeline.pullRequest}`,
      });
    case "pr":
      return fillPrompt(prompts.swfPr, values);
    default:
      throw new Error(`the step ${pipeline.step} has no prompt for the agent`);
  }
}

/** The comments as a Markdown thread, each with its author and date; `(none)` without any. */
function formatThread(comments: CommentText[]): string {
  if (comments.length === 0) return "(none)";
  return comments.map((comment) => `**@${comment.author}** on ${formatDate(comment.createdAt)}:\n\n${comment.body.trim()}`).join("\n\n---\n\n");
}

/**
 * The prompt that brings the answers `answers` from the issue to an agent that waits with the question label:
 * `answer.user-prompt.md` filled with the comments and the command that takes the label back to the pipeline's step.
 */
export function answerPrompt(template: string, repo: Repository, answers: CommentText[], labels: WorkflowLabels, pipeline: Pipeline): string {
  return fillPrompt(template, { ...pipelineValues(repo, labels, pipeline), comments: formatThread(answers) });
}

/**
 * The prompt the runner sends when the agent ended its turn with the issue still at its step (no step result, no
 * question, no failure was reported): `nudge.user-prompt.md` filled with the issue, the step and its labels.
 */
export function nudgePrompt(template: string, repo: Repository, labels: WorkflowLabels, pipeline: Pipeline): string {
  return fillPrompt(template, pipelineValues(repo, labels, pipeline));
}

/**
 * The prompt the runner sends when a person's slash command ended the agent's turn before the step's result, or a
 * person resumed the failed step in its conversation: `continue.user-prompt.md` filled with the issue and the step.
 */
export function continuePrompt(template: string, repo: Repository, labels: WorkflowLabels, pipeline: Pipeline): string {
  return fillPrompt(template, pipelineValues(repo, labels, pipeline));
}

/** `labelValues` of the pipeline's issue at its step, with the repository's question prefix of its settings. */
function pipelineValues(repo: Repository, labels: WorkflowLabels, pipeline: Pipeline): Record<string, string> {
  return labelValues(repo, pipeline.issue, labels, pipeline.step, pipeline.settings.questionPrefix);
}

/**
 * The prompt the runner sends when the result of the current agent step failed its gate: `gate-failed.user-prompt.md`
 * with the failed checks (`failures`) and the gate run of its limit, or `gate-escalate.user-prompt.md` once the result
 * failed more often than the limit allows (`gateEscalates` of the pipeline), with the commands of the step's labels.
 * `pipeline` has counted the failure (`noteGateFailure`) already.
 */
export function gatePrompt(prompts: PromptFiles, labels: WorkflowLabels, pipeline: Pipeline, failures: GateFailure[]): string {
  if (!isAgentStep(pipeline.step)) throw new Error(`the step ${pipeline.step} has no gate`);
  return fillPrompt(pipeline.gateEscalates ? prompts.swfGateEscalate : prompts.swfGateFailed, {
    ...pipelineValues(Repository.fromSlug(pipeline.repo), labels, pipeline),
    failures: formatGateFailures(failures),
    gateRuns: String(pipeline.gateRuns),
    maxGateRuns: String(pipeline.settings.maxGateRuns),
  });
}

/**
 * The failed checks as Markdown: per check a heading with its name and exit code and the last GATE_OUTPUT_LINES lines
 * of its output in a fence, then the files the checks left dirty under a heading of their own.
 */
function formatGateFailures(failures: GateFailure[]): string {
  const sections: string[] = [];
  const dirty = new Set<string>();
  for (const failure of failures) {
    const files = failure.dirty ?? [];
    files.forEach((file) => dirty.add(file));
    if (failure.exitCode === 0 && files.length > 0) continue;
    const exit = failure.exitCode === null ? "no exit code" : `exit ${failure.exitCode}`;
    sections.push(`### ${failure.name} (${exit})\n\n${formatOutput(failure.output)}`);
  }
  if (dirty.size > 0) {
    sections.push(`### working tree not clean after the checks\n\n${[...dirty].map((file) => `- \`${file}\``).join("\n")}`);
  }
  return sections.length > 0 ? sections.join("\n\n") : "(none)";
}

/** The last GATE_OUTPUT_LINES lines of a check's `output` in a fence longer than any backtick run in it; `(no output)` without any. */
function formatOutput(output: string): string {
  const lines = output.trimEnd().split("\n");
  if (lines.length === 1 && lines[0].trim() === "") return "(no output)";
  const longestRun = Math.max(0, ...(output.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}\n${lines.slice(-GATE_OUTPUT_LINES).join("\n")}\n${fence}`;
}

/**
 * The prompt the poller sends when the agent's step result is unusable (`problem`, why): `bad-result.user-prompt.md`
 * filled with the problem, which asks the agent to post the result again.
 */
export function badResultPrompt(template: string, problem: string): string {
  return fillFragment(template, { problem });
}
