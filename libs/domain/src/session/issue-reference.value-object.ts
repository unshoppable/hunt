import * as z from "zod/mini";
import { ValueObject } from "../model/value-object.model.ts";
import { Repository } from "./repository.value-object.ts";

/** A GitHub issue or pull request URL, optionally followed by a path, fragment or query (`/files`, `#issuecomment-1`, `?x=1`). */
const ISSUE_URL = /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d+)(?:[/#?]\S*)?$/;

const ZodIssueReferenceState = z.object({
  repository: Repository.createParser(),
  number: z.int().check(z.minimum(1, "an issue number is a positive integer")),
});

export interface IssueReference extends z.infer<typeof ZodIssueReferenceState> {}

/** A GitHub issue or pull request: its repository and its number, which GitHub counts per repository for both. */
export class IssueReference extends ValueObject<typeof ZodIssueReferenceState> {
  static readonly schema = ZodIssueReferenceState;

  constructor(value: z.input<typeof ZodIssueReferenceState>) {
    super(value);
  }

  /** The issue or pull request whose GitHub URL `url` is as a whole; null for any other text. */
  static fromUrl(url: string): IssueReference | null {
    const match = ISSUE_URL.exec(url);
    if (!match) return null;
    const state = { repository: { owner: match[1], name: match[2] }, number: Number(match[3]) };
    return ZodIssueReferenceState.safeParse(state).success ? new IssueReference(state) : null;
  }

  /** The issue or pull request whose GitHub URL is the first whitespace-delimited word of `line`; null otherwise. */
  static fromPromptLine(line: string): IssueReference | null {
    const [firstWord = ""] = line.trimStart().split(/\s/, 1);
    return IssueReference.fromUrl(firstWord);
  }

  /** `#<number>`, as GitHub writes a reference within its repository. */
  get label(): string {
    return `#${this.number}`;
  }
}
