/**
 * What the poller (`swf/poller.service.ts`) reads from an issue and its comments, free of I/O: the agent's step results,
 * the answers to the agent's question and the people to mention. Its own record comment is `swf/pipeline-record.client.ts`.
 */
import { hasStepMarker } from "../../../../libs/domain/src/swf/step-result.utils.ts";
import type { Issue, IssueComment } from "./github.client.ts";

/**
 * The step results the agent posted since the poller last acted on one: the comments of the bot after `lastResultId`
 * that carry a step marker, oldest first.
 */
export function newStepResults(comments: IssueComment[], botLogin: string, lastResultId: number): IssueComment[] {
  return comments.filter((comment) => comment.author === botLogin && comment.id > lastResultId && hasStepMarker(comment.body));
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
  const people = (issue.assignees.length > 0 ? issue.assignees : [issue.author]).filter((login) => !login.endsWith("[bot]") && login !== "ghost");
  return [...new Set(people)];
}
