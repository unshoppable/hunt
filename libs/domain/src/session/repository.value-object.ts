import * as z from "zod/mini";
import { ValueObject } from "../model/value-object.model.ts";

/** A part of `<owner>/<repo>` with the characters `hunt-ctl` accepts; it never starts with a dot. */
const PART = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
const PART_RULE = "an owner or repository name has letters, digits, `_`, `-` and `.` only and starts with no dot";

const ZodRepositoryState = z.object({
  owner: z.string().check(z.regex(PART, PART_RULE)),
  name: z.string().check(z.regex(PART, PART_RULE)),
});

export interface Repository extends z.infer<typeof ZodRepositoryState> {}

/** A GitHub repository, `<owner>/<repo>`, as the gateway's configuration, its API and the poller name it. */
export class Repository extends ValueObject<typeof ZodRepositoryState> {
  static readonly schema = ZodRepositoryState;

  constructor(value: z.input<typeof ZodRepositoryState>) {
    super(value);
  }

  /** Whether `slug` is `<owner>/<repo>`. */
  static isSlug(slug: string): boolean {
    const parts = slug.split("/");
    return parts.length === 2 && parts.every((part) => PART.test(part));
  }

  /** The repository `<owner>/<repo>` names; throws for any other text. */
  static fromSlug(slug: string): Repository {
    const parts = slug.split("/");
    if (parts.length !== 2) throw new Error(`${JSON.stringify(slug)} is no <owner>/<repo>`);
    return new Repository({ owner: parts[0], name: parts[1] });
  }

  get slug(): string {
    return `${this.owner}/${this.name}`;
  }

  /** `owner/repo` for a URL path, each part URL-encoded. */
  get path(): string {
    return `${encodeURIComponent(this.owner)}/${encodeURIComponent(this.name)}`;
  }

  /** Whether both name the same repository; GitHub ignores the case of owner and name. */
  isSameAs(other: Repository): boolean {
    return this.slug.toLowerCase() === other.slug.toLowerCase();
  }
}
