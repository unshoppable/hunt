import * as z from "zod/mini";
import { ValueObject } from "../model/value-object.model.ts";

/** The marker the Claude review workflow puts at the end of its sticky comment. */
const VERDICT_MARKER = /<!--\s*claude-pr-review:verdict\s+(\{[\s\S]*?\})\s*-->/;
/** The JSON of the marker; `findings` counts all findings and defaults to the blocking ones, a broken count included. */
const ZodVerdictMarker = z.looseObject({
  headSha: z.string(),
  blocking: z.int().check(z.nonnegative()),
  findings: z.catch(z.optional(z.int().check(z.nonnegative())), undefined),
});

const ZodReviewVerdictState = z.object({
  headSha: z.string(),
  blocking: z.int().check(z.nonnegative()),
  findings: z.int().check(z.nonnegative()),
  /** The comment that carries the verdict, for the agent. */
  body: z.string(),
});

export interface ReviewVerdict extends z.infer<typeof ZodReviewVerdictState> {}

/** The Claude review's verdict on a head commit, `<!-- claude-pr-review:verdict {…} -->` at the end of its sticky comment. */
export class ReviewVerdict extends ValueObject<typeof ZodReviewVerdictState> {
  static readonly schema = ZodReviewVerdictState;

  constructor(value: z.input<typeof ZodReviewVerdictState>) {
    super(value);
  }

  /** The latest verdict among the comments of the pull request, oldest first, skipping broken markers; null without one. */
  static latestIn(comments: { body: string }[]): ReviewVerdict | null {
    for (let index = comments.length - 1; index >= 0; index--) {
      const body = comments[index].body;
      const match = VERDICT_MARKER.exec(body);
      if (!match) continue;
      const marker = ZodVerdictMarker.safeParse(parseJson(match[1]));
      if (!marker.success) continue;
      const { headSha, blocking, findings } = marker.data;
      return new ReviewVerdict({ headSha, blocking, findings: findings ?? blocking, body });
    }
    return null;
  }

  /** Whether the verdict judges the commit `headSha`. */
  isFor(headSha: string): boolean {
    return this.headSha === headSha;
  }

  get hasBlockingFindings(): boolean {
    return this.blocking > 0;
  }

  /** The review's comment without its HTML markers. */
  get text(): string {
    return stripMarkers(this.body);
  }
}

/** `text` without HTML comments, such as the review's markers. */
function stripMarkers(text: string): string {
  return text.replace(/<!--[\s\S]*?-->\s*/g, "").trim();
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
