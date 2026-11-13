/**
 * What the poller (`swf/poller.service.ts`) reads from an issue and its comments, free of I/O: the step results the
 * runner mirrored onto the issue, which a replaced VM gets back, the answers to the agent's question and the people to
 * mention. Its own record comment is `swf/pipeline-record.client.ts`.
 */
import type { Run } from "../../../../libs/domain/src/swf/pipeline.domain.ts";
import { parseStepResult } from "../../../../libs/domain/src/swf/step-result.utils.ts";
import type { SwfStep } from "../../../../libs/domain/src/swf/swf-step.types.ts";
import type { Issue, IssueComment } from "./github.client.ts";

/** The step result of the run `n`, as `hunt-ctl swf-record` restores it to `.hunt/swf/steps/<nn>-<step>.md`. */
export interface RunResult {
  n: number;
  step: SwfStep;
  body: string;
}

/**
 * The step results of `runs` as the bot's comments on the issue hold them: every run of an agent step that ended with a
 * result (`passed` or `returned`) gets, in order, the bot's next usable result comment. A comment of another step than
 * the run's ends the pairing, since the thread and the log no longer match from there on.
 */
export function resultsOfRuns(comments: IssueComment[], botLogin: string, runs: Run[]): RunResult[] {
  const results = comments.filter((comment) => comment.author === botLogin).map((comment) => ({ body: comment.body, step: parseStepResult(comment.body)?.result?.step })).filter((result) => result.step);
  const restored: RunResult[] = [];
  let index = 0;
  for (const run of runs) {
    if (run.outcome !== "passed" && run.outcome !== "returned") continue;
    const next = results[index];
    if (next?.step !== run.step) break;
    restored.push({ n: run.n, step: run.step, body: next.body });
    index++;
  }
  return restored;
}

/**
 * The comments on the issue that answer the agent's question: those after the last comment of the GitHub App's bot user
 * `botLogin` (the agent comments through the app's token, so its question is the bot's latest comment) and newer than
 * `since`, the `createdAt` of the last answer delivered (empty: none yet). Without a bot comment nothing counts as an
 * answer.
 */
export function newAnswers(comments: IssueComment[], botLogin: string, since: string): IssueComment[] {
  let lastBot = -1;
  for (let index = 0; index < comments.length; index++) {
    if (comments[index].author === botLogin) {
      lastBot = index;
    }
  }
  if (lastBot < 0) return [];
  return comments.slice(lastBot + 1).filter((comment) => comment.createdAt > since);
}

/** The people who are to review or answer: the issue's assignees, or its author without any; bots never. */
export function mentionsOf(issue: Issue): string[] {
  const assignees = assigneesOf(issue);
  return assignees.length > 0 ? assignees : [issue.author].filter(isPerson);
}

/**
 * The people the issue is assigned to, bots never: the first is the author of the session's commits, all of them become
 * the assignees of its pull request.
 */
export function assigneesOf(issue: Issue): string[] {
  return [...new Set(issue.assignees.filter(isPerson))];
}

function isPerson(login: string): boolean {
  return !login.endsWith("[bot]") && login !== "ghost";
}
