/**
 * The messages the gateway's poller hands the swf runner on the session VM (`hunt-ctl swf-inbox <id>`, which puts each
 * one as a JSON file into `.hunt/swf/inbox/` of the worktree), free of I/O. The poller writes them with the builders
 * (`apps/gateway/src/swf/poller.service.ts`), the runner reads them with `parseInboxMessage`
 * (`apps/session/src/swf-runner/swf-runner.service.ts`):
 *
 * - `pipeline`: the pipeline as the poller recorded it after a transition it made itself (a poller step that sent the
 *   issue back to implement, a review it prepared) or when it started the VM again; the runner adopts it when it is
 *   further than its own.
 * - `answers`: the comments that answer the agent's question on the issue, for the runner to send to the agent.
 */
import { Pipeline } from "./pipeline.domain.ts";
import type { CommentText } from "./swf-prompts.utils.ts";
import { isRecord } from "../shared/json-rpc.utils.ts";

export type InboxMessage = { kind: "pipeline"; pipeline: Pipeline } | { kind: "answers"; comments: CommentText[] };

/** The message that hands the runner `pipeline`, as JSON. */
export function pipelineMessage(pipeline: Pipeline): Record<string, unknown> {
  return { kind: "pipeline", pipeline: pipeline.toJSON() };
}

/** The message that brings the runner the answers `comments`, as JSON; only what the answer prompt quotes is kept. */
export function answersMessage(comments: CommentText[]): Record<string, unknown> {
  return { kind: "answers", comments: comments.map(({ author, createdAt, body }) => ({ author, createdAt, body })) };
}

/** The message `value` holds; null for anything that is no message. */
export function parseInboxMessage(value: unknown): InboxMessage | null {
  if (!isRecord(value)) return null;
  switch (value.kind) {
    case "pipeline": {
      const parsed = Pipeline.schema.safeParse(value.pipeline);
      return parsed.success ? { kind: "pipeline", pipeline: new Pipeline(parsed.data) } : null;
    }
    case "answers": {
      if (!Array.isArray(value.comments)) return null;
      const comments: CommentText[] = [];
      for (const comment of value.comments) {
        if (!isRecord(comment) || typeof comment.author !== "string" || typeof comment.createdAt !== "string" || typeof comment.body !== "string") return null;
        comments.push({ author: comment.author, createdAt: comment.createdAt, body: comment.body });
      }
      return { kind: "answers", comments };
    }
    default:
      return null;
  }
}
