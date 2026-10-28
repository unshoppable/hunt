import { describe, expect, it } from "vitest";
import type * as z from "zod/mini";
import { Repository } from "../../../../libs/domain/src/session/repository.value-object.ts";
import type { SwfStep } from "../../../../libs/domain/src/swf/swf-step.types.ts";
import type { GitHub, IssueComment } from "./github.client.ts";
import { PipelineRecordClient } from "./pipeline-record.client.ts";
import { Pipeline } from "./pipeline.domain.ts";
import { SKILLS } from "./swf.fixtures.ts";

const BOT_NAME = "hunt-claude[bot]";
const REPO = Repository.fromSlug("acme/app");
const PULL_REQUEST = 31;
/** The id the fake GitHub gives a posted comment. */
const POSTED_ID = 5000;

/** A fresh pipeline at `step`, apart from `fields`. */
function pipelineAt(step: SwfStep, fields: Partial<z.input<typeof Pipeline.schema>> = {}): Pipeline {
  return new Pipeline({ ...Pipeline.start([], SKILLS).toJSON(), step, ...fields });
}

/** A GitHub whose every issue has the comments `thread`; it records the calls of the record client, any other call fails. */
function fakeGitHub(thread: IssueComment[] = []): GitHub & { calls: string[] } {
  const calls: string[] = [];
  const unexpected = async (): Promise<never> => {
    throw new Error("unexpected GitHub call");
  };
  return {
    calls,
    comments: async (repo, issue) => {
      calls.push(`comments ${repo.slug}#${issue}`);
      return structuredClone(thread);
    },
    comment: async (repo, issue, body) => {
      calls.push(`comment ${repo.slug}#${issue} ${body}`);
      return POSTED_ID;
    },
    updateComment: async (repo, id, body) => {
      calls.push(`update ${repo.slug} ${id} ${body}`);
    },
    openIssues: unexpected,
    issue: unexpected,
    removeLabel: unexpected,
    addLabels: unexpected,
    pullRequest: unexpected,
    pullRequestFiles: unexpected,
    reviews: unexpected,
    reviewComments: unexpected,
    requestReviewers: unexpected,
    updateBranch: unexpected,
    merge: unexpected,
    ensureLabel: unexpected,
    moveToStatus: unexpected,
  };
}

describe("PipelineRecordClient.find", () => {
  const thread: IssueComment[] = [
    { id: 1, author: BOT_NAME, createdAt: "", body: pipelineAt("plan").toComment() },
    { id: 2, author: BOT_NAME, createdAt: "", body: pipelineAt("verify", { attempt: 2 }).toComment() },
    { id: 3, author: "mallory", createdAt: "", body: pipelineAt("merge", { pullRequest: PULL_REQUEST }).toComment() },
    { id: 4, author: BOT_NAME, createdAt: "", body: "<!-- hunt:pipeline {\"step\":\"deploy\"} -->" },
  ];

  it("takes the latest record comment of the bot and ignores records anyone else posted, from the comments it is given", async () => {
    const github = fakeGitHub();
    const records = new PipelineRecordClient(github);
    expect(await records.find(REPO, 12, BOT_NAME, thread)).toEqual({ commentId: 2, pipeline: pipelineAt("verify", { attempt: 2 }) });
    expect(await records.find(REPO, 12, BOT_NAME, thread.slice(2))).toBeNull();
    expect(github.calls).toEqual([]);
  });

  it("reads the issue's comments when it is given none", async () => {
    const github = fakeGitHub(thread);
    const found = await new PipelineRecordClient(github).find(REPO, 12, BOT_NAME);
    expect(found?.commentId).toBe(2);
    expect(found?.pipeline.step).toBe("verify");
    expect(github.calls).toEqual(["comments acme/app#12"]);
  });
});

describe("PipelineRecordClient", () => {
  it("posts the record comment of a new pipeline and gives its id", async () => {
    const github = fakeGitHub();
    const pipeline = Pipeline.start(["**/migrations/**"], SKILLS);
    expect(await new PipelineRecordClient(github).create(REPO, 12, pipeline)).toBe(POSTED_ID);
    expect(github.calls).toEqual([`comment acme/app#12 ${pipeline.toComment()}`]);
  });

  it("saves the pipeline by editing its record comment in place", async () => {
    const github = fakeGitHub();
    const pipeline = pipelineAt("merge", { pullRequest: PULL_REQUEST });
    pipeline.noteMergeRequested("0123456789abcdef0123456789abcdef01234567");
    await new PipelineRecordClient(github).save(REPO, 1000, pipeline);
    expect(github.calls).toEqual([`update acme/app 1000 ${pipeline.toComment()}`]);
    expect(github.calls[0]).toContain("\"mergeSha\":\"0123456789abcdef0123456789abcdef01234567\"");
  });
});
