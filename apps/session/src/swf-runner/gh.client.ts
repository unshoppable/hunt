/**
 * What the runner (`swf-runner.service.ts`) does on GitHub, through `gh` on the VM: `/usr/local/bin/gh` is Hunt's wrapper
 * (`apps/session/vm/hunt-gh`), which exports the token of `/etc/hunt/github-token`, the GitHub App's installation token
 * the gateway keeps fresh, so the runner comments and labels as the app's bot, as the agent does. The runner reads the
 * issue once per step prompt and its labels once per turn that ended without a result; it never polls GitHub, so that
 * the VM can sleep while the pipeline waits for people.
 */
import { Repository } from "../../../../libs/domain/src/session/repository.value-object.ts";
import type { CommentText, IssueText } from "../../../../libs/domain/src/swf/swf-prompts.utils.ts";
import { isRecord } from "../../../../libs/domain/src/shared/json-rpc.utils.ts";

/** Runs `gh` with `args` and `input` on stdin, and gives its stdout; throws with stderr when it fails. */
export type GhExec = (args: string[], input?: string) => Promise<string>;

/** The issue as the step prompts quote it, its labels and its comments, oldest first. */
export interface IssueThread {
  issue: IssueText;
  labels: string[];
  comments: CommentText[];
}

/** What the runner does on GitHub; the class below does it with `gh`, the tests stand in. */
export interface RunnerGitHub {
  issue(repo: Repository, number: number): Promise<IssueThread>;
  /** The names of the issue's labels. */
  labels(repo: Repository, number: number): Promise<string[]>;
  comment(repo: Repository, number: number, body: string): Promise<void>;
  /** Replaces the body of the issue comment `commentId`. */
  editComment(repo: Repository, commentId: number, body: string): Promise<void>;
  /** Adds the labels `add` to the issue and removes `remove`; either may be empty. */
  editLabels(repo: Repository, number: number, add: string[], remove: string[]): Promise<void>;
}

export class GhClient implements RunnerGitHub {
  private readonly exec: GhExec;

  constructor(exec: GhExec) {
    this.exec = exec;
  }

  async issue(repo: Repository, number: number): Promise<IssueThread> {
    const output = await this.exec(["issue", "view", String(number), "--repo", repo.slug, "--json", "number,title,body,author,createdAt,url,labels,comments"]);
    const value = parseJson(output);
    if (!isRecord(value) || typeof value.number !== "number") throw new Error(`gh issue view ${number} gave no issue: ${output.slice(0, 200)}`);
    const issue: IssueText = {
      number: value.number,
      title: textOf(value.title),
      body: textOf(value.body),
      author: loginOf(value.author),
      createdAt: textOf(value.createdAt),
      url: textOf(value.url),
    };
    const comments = Array.isArray(value.comments)
      ? value.comments.filter(isRecord).map((comment) => ({ author: loginOf(comment.author), createdAt: textOf(comment.createdAt), body: textOf(comment.body) }))
      : [];
    return { issue, labels: labelNamesOf(value.labels), comments };
  }

  async labels(repo: Repository, number: number): Promise<string[]> {
    const output = await this.exec(["issue", "view", String(number), "--repo", repo.slug, "--json", "labels"]);
    const value = parseJson(output);
    if (!isRecord(value)) throw new Error(`gh issue view ${number} gave no labels: ${output.slice(0, 200)}`);
    return labelNamesOf(value.labels);
  }

  async comment(repo: Repository, number: number, body: string): Promise<void> {
    await this.exec(["issue", "comment", String(number), "--repo", repo.slug, "--body-file", "-"], body);
  }

  async editComment(repo: Repository, commentId: number, body: string): Promise<void> {
    await this.exec(["api", "--method", "PATCH", `repos/${repo.path}/issues/comments/${commentId}`, "--input", "-"], JSON.stringify({ body }));
  }

  async editLabels(repo: Repository, number: number, add: string[], remove: string[]): Promise<void> {
    if (add.length === 0 && remove.length === 0) return;
    const args = ["issue", "edit", String(number), "--repo", repo.slug];
    for (const label of add) {
      args.push("--add-label", label);
    }
    for (const label of remove) {
      args.push("--remove-label", label);
    }
    await this.exec(args);
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The login of a `gh` author object (`{"login": "…"}`); `ghost` for a deleted account, which gh gives as null. */
function loginOf(value: unknown): string {
  return isRecord(value) && typeof value.login === "string" ? value.login : "ghost";
}

/** The names of `gh`'s label objects (`[{"name": "…"}]`). */
function labelNamesOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((label) => label.name).filter((name): name is string => typeof name === "string");
}
