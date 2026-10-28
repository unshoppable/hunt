import * as z from "zod/mini";
import { isInsideFolder } from "../common/path/path.utils";
import type { RightTab } from "../sessions/inspector.store";
import { hasInspectorTab } from "../sessions/inspector.utils";
import type { SessionView } from "../sessions/session.types";

/** Every inspector tab by name; the mapped type makes the compiler insist on each `RightTab`, so a new tab is a valid command at once. */
const RIGHT_TABS: { [Tab in RightTab]: Tab } = {
  diff: "diff",
  git: "git",
  editor: "editor",
  graph: "graph",
  pullRequest: "pullRequest",
  preview: "preview",
  desktop: "desktop",
  checks: "checks",
  terminal: "terminal",
};

/** An empty, `.` or `..` segment of an absolute path, or a trailing slash. */
const UNNORMALIZED_SEGMENT = /\/(?:\.{1,2})?(?:\/|$)/;

const COMMAND_RULE = "must be a JSON object with a name";
const PATH_RULE = "must be an absolute path without empty, . or .. segments";
const POSITION_RULE = "must be a positive integer";
const WINDOW_RULE = "must be true or false";
const TAB_RULE = `must be one of ${Object.values(RIGHT_TABS).join(", ")}`;
const PAGE_RULE = 'must be "updates"';
const MISSING_TAB_RULE = "preview and desktop need a session on a VM, pullRequest a pull request review";
const NO_LOCAL_WORKTREE = "the session has no local worktree";

function isNormalizedAbsolutePath(path: string): boolean {
  return path.startsWith("/") && !UNNORMALIZED_SEGMENT.test(path);
}

/** A file or folder; `hunt-client` resolves every path against the agent's working directory. */
const ZodAbsolutePath = z.string(PATH_RULE).check(z.refine(isNormalizedAbsolutePath, PATH_RULE));
/** A 1-based line or column. */
const ZodPosition = z.optional(z.int(POSITION_RULE).check(z.positive(POSITION_RULE)));

const ZodControlCommand = z.discriminatedUnion(
  "name",
  [
    z.strictObject({ name: z.literal("show") }),
    z.strictObject({ name: z.literal("tab"), tab: z.enum(RIGHT_TABS, TAB_RULE) }),
    z.strictObject({ name: z.literal("openFile"), path: ZodAbsolutePath, line: ZodPosition, column: ZodPosition, window: z.optional(z.boolean(WINDOW_RULE)) }),
    z.strictObject({ name: z.literal("openDiff"), path: ZodAbsolutePath }),
    z.strictObject({ name: z.literal("openSettings"), page: z.optional(z.literal("updates", PAGE_RULE)) }),
    z.strictObject({ name: z.literal("openGuardrails") }),
    z.strictObject({ name: z.literal("openBrowser") }),
  ],
  COMMAND_RULE,
);

/**
 * What a `hunt-client` call asks of the UI for its session: `show` it in the main window and bring that to the front,
 * switch its inspector to `tab`, open a file in its Editor tab (or with `window` in its editor window), open the diff
 * of a file, the settings, its guardrails or its Chrome. Paths are absolute.
 */
export type ControlCommand = z.infer<typeof ZodControlCommand>;

/** `value` as a control command; throws an Error naming its first problem when it is none. */
export function parseControlCommand(value: unknown): ControlCommand {
  const result = ZodControlCommand.safeParse(value);
  if (result.success) return result.data;
  throw new Error(`invalid command: ${describeIssue(result.error.issues[0])}`);
}

/** `issue` in words; zod/mini words every issue "Invalid input", so the rules above carry their own and the structural issues are worded here. */
function describeIssue(issue: z.core.$ZodIssue): string {
  const field = issue.path.length ? issue.path.join(".") : "the command";
  if (issue.code === "unrecognized_keys") return `${field} has unknown fields: ${issue.keys.join(", ")}`;
  if (issue.code === "invalid_union" && "options" in issue && issue.options) return `${field} must be one of ${issue.options.join(", ")}`;
  return `${field} ${issue.message}`;
}

/**
 * Throws an Error with the reason when `session` cannot run `command`: a tab its inspector lacks, a file, diff or
 * guardrails command without a local worktree, a browser on a VM. `worktreeFilePath` checks a file's path.
 */
export function ensureRunnable(command: ControlCommand, session: SessionView): void {
  switch (command.name) {
    case "tab": {
      const conditions = { isOnVm: Boolean(session.remote?.vm.instance), isReviewingPullRequest: Boolean(session.pullRequest) };
      if (!hasInspectorTab(command.tab, conditions)) throw new Error(`the session has no ${command.tab} tab: ${MISSING_TAB_RULE}`);
      return;
    }
    case "openFile":
    case "openDiff":
    case "openGuardrails":
      if (!session.hasLocalWorktree) throw new Error(NO_LOCAL_WORKTREE);
      return;
    case "openBrowser":
      if (session.remote) throw new Error("the session runs on a VM, whose browser shows in its Desktop tab");
      return;
  }
}

/** The absolute `path` relative to the worktree at `worktreePath`, the form the editor and the diff window take; throws when it lies outside. */
export function worktreeFilePath(path: string, worktreePath: string): string {
  if (!worktreePath || !isInsideFolder(path, worktreePath)) throw new Error(`${path} lies outside the session's worktree ${worktreePath}`);
  return path.slice(worktreePath.length + 1);
}
