import * as z from "zod/mini";
import { isInsideFolder } from "../common/path/path.utils";
import type { RightTab } from "../sessions/inspector.store";
import { hasInspectorTab } from "../sessions/inspector.utils";
import type { SessionView } from "../sessions/session.types";
import { FLAG_RULE, ZodAbsolutePath, ZodPositiveInteger } from "./control-command.rules";
import { ZodChecksAction, ZodDesktopAction, ZodDiffAction, ZodEditorAction, ZodFactoryAction, ZodGitAction, ZodGraphAction, ZodTerminalAction } from "./tab-commands.utils";

/** Every inspector tab by name; the mapped type makes the compiler insist on each `RightTab`, so a new tab is a valid command at once. */
const RIGHT_TABS: { [Tab in RightTab]: Tab } = {
  diff: "diff",
  git: "git",
  editor: "editor",
  graph: "graph",
  pullRequest: "pullRequest",
  desktop: "desktop",
  checks: "checks",
  terminal: "terminal",
  factory: "factory",
};

const COMMAND_RULE = "must be a JSON object with a name";
const TAB_RULE = `must be one of ${Object.values(RIGHT_TABS).join(", ")}`;
const PAGE_RULE = 'must be "updates"';
const CHECK_RULE = "must be the name of a check";
const SERVICE_RULE = "must be the name of a service";
const MISSING_TAB_RULE = "desktop needs a session on a VM, pullRequest a pull request review, factory a session of the swf poller";
const NO_LOCAL_WORKTREE = "the session has no local worktree";

/** A 1-based line or column. */
const ZodPosition = z.optional(ZodPositiveInteger);

const ZodControlCommand = z.discriminatedUnion(
  "name",
  [
    z.strictObject({ name: z.literal("show") }),
    z.strictObject({ name: z.literal("tab"), tab: z.enum(RIGHT_TABS, TAB_RULE) }),
    z.strictObject({ name: z.literal("openFile"), path: ZodAbsolutePath, line: ZodPosition, column: ZodPosition, window: z.optional(z.boolean(FLAG_RULE)) }),
    z.strictObject({ name: z.literal("openDiff"), path: ZodAbsolutePath }),
    z.strictObject({ name: z.literal("openSettings"), page: z.optional(z.literal("updates", PAGE_RULE)) }),
    z.strictObject({ name: z.literal("openGuardrails") }),
    z.strictObject({ name: z.literal("openBrowser") }),
    z.strictObject({ name: z.literal("checks"), action: z.optional(ZodChecksAction) }),
    z.strictObject({ name: z.literal("runChecks"), check: z.optional(z.string(CHECK_RULE)) }),
    z.strictObject({ name: z.literal("services") }),
    z.strictObject({ name: z.literal("startServices"), service: z.optional(z.string(SERVICE_RULE)) }),
    z.strictObject({ name: z.literal("stopService"), service: z.string(SERVICE_RULE) }),
    z.strictObject({ name: z.literal("state") }),
    z.strictObject({ name: z.literal("graph"), action: z.optional(ZodGraphAction) }),
    z.strictObject({ name: z.literal("diff"), action: z.optional(ZodDiffAction) }),
    z.strictObject({ name: z.literal("git"), action: z.optional(ZodGitAction) }),
    z.strictObject({ name: z.literal("editor"), action: z.optional(ZodEditorAction) }),
    z.strictObject({ name: z.literal("pullRequest") }),
    z.strictObject({ name: z.literal("desktop"), action: z.optional(ZodDesktopAction) }),
    z.strictObject({ name: z.literal("terminal"), action: z.optional(ZodTerminalAction) }),
    z.strictObject({ name: z.literal("factory"), action: z.optional(ZodFactoryAction) }),
  ],
  COMMAND_RULE,
);

/**
 * What a `hunt-client` call asks of the UI for its session: `show` it in the main window and bring that to the front,
 * switch its inspector to `tab`, open a file in its Editor tab (or with `window` in its editor window), open the diff
 * of a file, the settings, its guardrails or its Chrome, report its checks, or run one check or all of them as the
 * Checks tab does, report the services of its hunt.json, start one or all of them or stop one as its Terminal tab does,
 * read the state of the tab its inspector shows (`state`), or read or set the state of one tab (`graph`, `diff`, `git`,
 * `editor`, `pullRequest`, `desktop`, `checks`, `terminal`, `factory`; the actions are in tab-commands.utils.ts).
 * Paths are absolute.
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

/** Whether the inspector of `session` has the tab `tab`. */
export function sessionHasTab(session: SessionView, tab: RightTab): boolean {
  return hasInspectorTab(tab, { isOnVm: Boolean(session.remote?.vm.instance), isReviewingPullRequest: Boolean(session.pullRequest), isFactory: session.mode === "swf" });
}

/** Throws an Error with the reason when the inspector of `session` lacks the tab `tab`. */
function ensureTab(session: SessionView, tab: RightTab): void {
  if (!sessionHasTab(session, tab)) throw new Error(`the session has no ${tab} tab: ${MISSING_TAB_RULE}`);
}

/**
 * Throws an Error with the reason when `session` cannot run `command`: a tab its inspector lacks, a file, diff or
 * guardrails command without a local worktree, a browser or a service command on a VM. `worktreeFilePath` checks a file's path.
 */
export function ensureRunnable(command: ControlCommand, session: SessionView): void {
  switch (command.name) {
    case "tab":
      ensureTab(session, command.tab);
      return;
    case "pullRequest":
    case "desktop":
    case "factory":
      ensureTab(session, command.name);
      return;
    case "openFile":
    case "openDiff":
    case "openGuardrails":
      if (!session.hasLocalWorktree) throw new Error(NO_LOCAL_WORKTREE);
      return;
    case "openBrowser":
      if (session.remote) throw new Error("the session runs on a VM, whose browser shows in its Desktop tab");
      return;
    case "services":
    case "startServices":
    case "stopService":
      if (session.remote) throw new Error("the session runs on a VM, which starts its services itself");
      return;
  }
}

/** The absolute `path` relative to the worktree at `worktreePath`, the form the editor and the diff window take; throws when it lies outside. */
export function worktreeFilePath(path: string, worktreePath: string): string {
  if (!worktreePath || !isInsideFolder(path, worktreePath)) throw new Error(`${path} lies outside the session's worktree ${worktreePath}`);
  return path.slice(worktreePath.length + 1);
}
