/** Conventional commit types offered by the commit box, with the description its menu shows. */
export const COMMIT_TYPES = [
  { type: "feat", description: "A new feature" },
  { type: "fix", description: "A bug fix" },
  { type: "refactor", description: "Code change that neither fixes a bug nor adds a feature" },
  { type: "perf", description: "Performance improvement" },
  { type: "test", description: "Adds or corrects tests" },
  { type: "docs", description: "Documentation only" },
  { type: "style", description: "Formatting, no change in meaning" },
  { type: "build", description: "Build system or dependencies" },
  { type: "ci", description: "CI configuration and scripts" },
  { type: "chore", description: "Maintenance that touches no source or test" },
  { type: "revert", description: "Reverts an earlier commit" },
] as const;

export type CommitType = (typeof COMMIT_TYPES)[number]["type"];

/** A commit type chosen in the menu; `"none"` stands for a message without prefix. */
export type CommitTypeChoice = CommitType | "none";

/** The `type: ` prefix at the start of a message. */
const PREFIX = /^([a-z]+): ?/;

/** The conventional commit type `message` starts with; `"none"` when it has no known type prefix. */
export function commitTypeOf(message: string): CommitTypeChoice {
  const type = PREFIX.exec(message)?.[1];
  return COMMIT_TYPES.some((entry) => entry.type === type) ? (type as CommitType) : "none";
}

/** `message` with its `type: ` prefix replaced by `choice`'s, or removed for `"none"`. */
export function withCommitType(message: string, choice: CommitTypeChoice): string {
  const body = message.replace(PREFIX, "");
  return choice === "none" ? body : `${choice}: ${body}`;
}
