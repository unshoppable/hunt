/** The branch of a poller session (`swf/poller.service.ts`), named after its issue in the `<type>/<scope>/<name>` form. */
import { BranchName } from "../../../../libs/domain/src/session/branch-name.value-object.ts";
import type { Issue } from "./github.client.ts";

const SLUG_MAX_LENGTH = 40;
/** The scope of every session branch: `<type>/general/<name>`. */
const BRANCH_SCOPE = "general";
/** The issue label (in any case) that makes a session branch a `fix/` branch. */
const BUG_LABEL = "bug";

/** `title` as lowercase ASCII words joined by `-`, at most 40 characters. */
export function slugify(title: string): string {
  const words = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return words.slice(0, SLUG_MAX_LENGTH).replace(/-+$/, "");
}

/**
 * The branch of the session for `issue`: `fix/general/<number>-<slug of the title>` for an issue labelled `bug`,
 * `feat/general/…` for any other, the `<type>/<scope>/<name>` form repositories check branch names against.
 */
export function branchName(issue: Issue): BranchName {
  const type = issue.labels.some((label) => label.toLowerCase() === BUG_LABEL) ? "fix" : "feat";
  const slug = slugify(issue.title);
  return BranchName.of(`${type}/${BRANCH_SCOPE}/${slug ? `${issue.number}-${slug}` : issue.number}`);
}
