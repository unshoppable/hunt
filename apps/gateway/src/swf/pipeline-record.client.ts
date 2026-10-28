/**
 * Where a poller session's pipeline (`swf/pipeline.domain.ts`) is stored: one comment of the GitHub App's bot on the
 * issue, the record comment, whose body is `Pipeline.toComment()`. The poller (`swf/poller.service.ts`) posts it when it
 * claims the issue, finds it at every poll and saves the pipeline into it after every intent by editing it in place, so
 * that a restart of the poller loses nothing.
 */
import type { Repository } from "../../../../libs/domain/src/session/repository.value-object.ts";
import type { GitHub, IssueComment } from "./github.client.ts";
import { Pipeline } from "./pipeline.domain.ts";

/** A pipeline with the id of the record comment that holds it. */
export interface StoredPipeline {
  commentId: number;
  pipeline: Pipeline;
}

export class PipelineRecordClient {
  private readonly github: GitHub;

  constructor(github: GitHub) {
    this.github = github;
  }

  /**
   * The pipeline of the issue: the latest comment of `botLogin` that carries a usable record, so that a record anyone else
   * posts never counts; null without one. `comments` are the issue's comments, oldest first, when the caller has read
   * them already; without them they are read.
   */
  async find(repo: Repository, issueNumber: number, botLogin: string, comments?: IssueComment[]): Promise<StoredPipeline | null> {
    const thread = comments ?? (await this.github.comments(repo, issueNumber));
    for (let index = thread.length - 1; index >= 0; index--) {
      const comment = thread[index];
      if (comment.author !== botLogin) continue;
      const pipeline = Pipeline.fromComment(comment.body);
      if (pipeline) return { commentId: comment.id, pipeline };
    }
    return null;
  }

  /** Posts the record comment of `pipeline` on the issue and gives the comment's id. */
  create(repo: Repository, issueNumber: number, pipeline: Pipeline): Promise<number> {
    return this.github.comment(repo, issueNumber, pipeline.toComment());
  }

  /** Writes `pipeline` into its record comment `commentId`. */
  save(repo: Repository, commentId: number, pipeline: Pipeline): Promise<void> {
    return this.github.updateComment(repo, commentId, pipeline.toComment());
  }
}
