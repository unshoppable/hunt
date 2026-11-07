import * as z from "zod/mini";
import type { DiagramType } from "../common/diagram/diagram.types";
import { FLAG_RULE, ZodAbsolutePath, ZodAbsolutePaths, ZodNames, ZodPositiveInteger, ZodText } from "./control-command.rules";

/**
 * The actions `hunt-client <tab> <verb>` sends for each inspector tab, as `{ name: "<tab>", action }`; without an action
 * the command reads the tab's state. Paths are absolute, except a commit's file in the Git tab, which is
 * repository-relative as the commit names it. Every action sets view state or runs a harmless action; nothing here
 * commits, pushes, reverts, shelves, deletes or posts to GitHub.
 */

/** Every diagram type by id; the mapped type makes the compiler insist on each `DiagramType`. */
const DIAGRAM_TYPE_IDS: { [Type in DiagramType]: Type } = {
  dependencies: "dependencies",
  "c4-context": "c4-context",
  "c4-container": "c4-container",
  states: "states",
  erd: "erd",
  process: "process",
  freeform: "freeform",
};

const ACTION_RULE = "must be a JSON object with a name";
const DIAGRAM_TYPE_RULE = `must be one of ${Object.values(DIAGRAM_TYPE_IDS).join(", ")}`;
const REVIEW_RULE = "must be an integer from 1 to 4";
const CHANGE_LIST_TAB_RULE = "must be one of changelist, shelf, review";
const CHANGELIST_SCOPE_RULE = "must be one of own, downstream, all";
const LINE_SCOPE_RULE = "must be one of own, all";
const VIEW_RULE = "must be one of flat, tree";
const MODE_RULE = "must be one of split, unified";
const NAME_RULE = "must be a non-empty string";

const ZodName = z.string(NAME_RULE).check(z.minLength(1, NAME_RULE));
const ZodReviewLevel = z.int(REVIEW_RULE).check(z.gte(1, REVIEW_RULE), z.lte(4, REVIEW_RULE));

/** Architecture tab: the diagram type, a repository diagram file (null for the generated ones), the ERD's hidden tables, the dependency graph's excluded files and filter, generating the shown diagram. */
export const ZodGraphAction = z.discriminatedUnion(
  "name",
  [
    z.strictObject({ name: z.literal("type"), type: z.enum(DIAGRAM_TYPE_IDS, DIAGRAM_TYPE_RULE) }),
    z.strictObject({ name: z.literal("file"), path: z.nullable(ZodAbsolutePath) }),
    z.strictObject({ name: z.literal("tables"), hide: ZodNames }),
    z.strictObject({ name: z.literal("changedTables") }),
    z.strictObject({ name: z.literal("files"), exclude: ZodAbsolutePaths }),
    z.strictObject({ name: z.literal("filter"), minReview: z.optional(ZodReviewLevel), hiddenGlobs: z.optional(ZodText) }),
    z.strictObject({ name: z.literal("generate"), instructions: z.optional(ZodText) }),
  ],
  ACTION_RULE,
);

/** Diff tab: the selected file, the changelist's tab, scope, hidden globs and view, the line scope, the layout, collapsing unchanged lines and the checked files. */
export const ZodDiffAction = z.discriminatedUnion(
  "name",
  [
    z.strictObject({ name: z.literal("select"), path: z.nullable(ZodAbsolutePath) }),
    z.strictObject({ name: z.literal("subtab"), tab: z.enum(["changelist", "shelf", "review"], CHANGE_LIST_TAB_RULE) }),
    z.strictObject({ name: z.literal("scope"), scope: z.enum(["own", "downstream", "all"], CHANGELIST_SCOPE_RULE) }),
    z.strictObject({ name: z.literal("globs"), globs: ZodText }),
    z.strictObject({ name: z.literal("view"), view: z.enum(["flat", "tree"], VIEW_RULE) }),
    z.strictObject({ name: z.literal("lines"), scope: z.enum(["own", "all"], LINE_SCOPE_RULE) }),
    z.strictObject({ name: z.literal("mode"), mode: z.enum(["split", "unified"], MODE_RULE) }),
    z.strictObject({ name: z.literal("collapse"), collapsed: z.boolean(FLAG_RULE) }),
    z.strictObject({ name: z.literal("check"), paths: ZodAbsolutePaths }),
  ],
  ACTION_RULE,
);

/** Git tab: the log filter, the selected commit and the selected file of that commit (repository-relative). */
export const ZodGitAction = z.discriminatedUnion(
  "name",
  [
    z.strictObject({ name: z.literal("filter"), reference: z.optional(ZodText), text: z.optional(ZodText) }),
    z.strictObject({ name: z.literal("select"), commit: z.nullable(ZodName) }),
    z.strictObject({ name: z.literal("selectFile"), path: z.nullable(ZodName) }),
  ],
  ACTION_RULE,
);

/** Editor tab: closing one tab or all, activating an open file, going back and forward, revealing a file or folder in the project tree (the active file without a path). */
export const ZodEditorAction = z.discriminatedUnion(
  "name",
  [
    z.strictObject({ name: z.literal("close"), path: ZodAbsolutePath }),
    z.strictObject({ name: z.literal("closeAll") }),
    z.strictObject({ name: z.literal("activate"), path: ZodAbsolutePath }),
    z.strictObject({ name: z.literal("back") }),
    z.strictObject({ name: z.literal("forward") }),
    z.strictObject({ name: z.literal("reveal"), path: z.optional(ZodAbsolutePath) }),
  ],
  ACTION_RULE,
);

/** Desktop tab: reconnecting its stream. */
export const ZodDesktopAction = z.discriminatedUnion("name", [z.strictObject({ name: z.literal("reconnect") })], ACTION_RULE);

/** Checks tab: stopping one running check or all, selecting the check it shows (null for its own choice). */
export const ZodChecksAction = z.discriminatedUnion(
  "name",
  [
    z.strictObject({ name: z.literal("stop"), check: z.optional(ZodName) }),
    z.strictObject({ name: z.literal("select"), check: z.nullable(ZodName) }),
  ],
  ACTION_RULE,
);

/** Terminal tab: activating a tab by its key, opening a shell (in a folder, running a package script), running a window's command again. */
export const ZodTerminalAction = z.discriminatedUnion(
  "name",
  [
    z.strictObject({ name: z.literal("select"), key: ZodName }),
    z.strictObject({ name: z.literal("new"), directory: z.optional(ZodAbsolutePath), script: z.optional(ZodName) }),
    z.strictObject({ name: z.literal("rerun"), key: ZodName }),
  ],
  ACTION_RULE,
);

/** Factory tab: the run it shows (null for its own choice), reloading the pipeline. */
export const ZodFactoryAction = z.discriminatedUnion(
  "name",
  [z.strictObject({ name: z.literal("select"), run: z.nullable(ZodPositiveInteger) }), z.strictObject({ name: z.literal("refresh") })],
  ACTION_RULE,
);

export type GraphAction = z.infer<typeof ZodGraphAction>;
export type DiffAction = z.infer<typeof ZodDiffAction>;
export type GitAction = z.infer<typeof ZodGitAction>;
export type EditorAction = z.infer<typeof ZodEditorAction>;
export type DesktopAction = z.infer<typeof ZodDesktopAction>;
export type ChecksAction = z.infer<typeof ZodChecksAction>;
export type TerminalAction = z.infer<typeof ZodTerminalAction>;
export type FactoryAction = z.infer<typeof ZodFactoryAction>;
