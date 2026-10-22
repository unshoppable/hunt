import { create } from "zustand";
import { persist } from "zustand/middleware";
import responseStylePrompt from "../../prompts/response-style.system-prompt.md?raw";
import { isSessionMachineType } from "../../../../libs/domain/src/sessionMachineTypes.ts";
import type { DiagramType, ReviewLevel, VmSettings } from "../ipc/types";
import { normalizeKeymap, withBindings, type CommandId, type Keymap } from "./keymap";

/** The configurable panes of the window; every tab of the inspector has one. */
export type PaneKey = "sidebar" | "chat" | "changelist" | "diff" | "git" | "editor" | "architecture" | "pullRequest" | "preview" | "terminal";

export type PaneSettings = {
  /** Text size in px. */
  fontSize: number;
  /** Line height as a multiple of the font size. */
  lineHeight: number;
  /** Indentation per nesting level in px (sub chats in the sidebar, folders in the changelist and the Git tab). */
  indent: number;
  /** Background color as a six-digit hex color. */
  background: string;
  /** CSS `font-family` value, fallbacks included. */
  fontFamily: string;
};

export type NumericPaneSetting = Exclude<keyof PaneSettings, "background" | "fontFamily">;

export const UI_FONT_FAMILY = "ui-sans-serif, system-ui, -apple-system, sans-serif";
/** "Code Monospace V2" is the repaired build of the original (see tools/fonts/build_code_monospace_v2.py). */
export const CODE_FONT_FAMILY = '"Code Monospace V2", "Code Monospace", ui-monospace, SFMono-Regular, Menlo, Monaco, "JetBrains Mono", monospace';

/** Font stacks offered as suggestions next to the free-text font family field. */
export const FONT_FAMILY_PRESETS: { label: string; value: string }[] = [
  { label: "System", value: UI_FONT_FAMILY },
  { label: "Code Monospace", value: CODE_FONT_FAMILY },
  { label: "Inter", value: 'Inter, ui-sans-serif, system-ui, -apple-system, sans-serif' },
  { label: "SF Mono", value: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace' },
  { label: "JetBrains Mono", value: '"JetBrains Mono", ui-monospace, Menlo, monospace' },
  { label: "Menlo", value: "Menlo, Monaco, monospace" },
  { label: "Serif", value: "ui-serif, Georgia, Cambria, serif" },
];

/**
 * Backgrounds are WebStorm's colors (project panel #0b0c0d, editor #23272f) pre-compensated for a display using the
 * "Rec. ITU-R BT.709" profile: WebKit color-manages sRGB into that profile while WebStorm draws raw values, so these
 * sRGB values land on screen as WebStorm's.
 */
export const DEFAULT_PANES: Record<PaneKey, PaneSettings> = {
  sidebar: { fontSize: 14, lineHeight: 1.5, indent: 16, background: "#191a1c", fontFamily: UI_FONT_FAMILY },
  chat: { fontSize: 14, lineHeight: 1.8, indent: 0, background: "#21252d", fontFamily: UI_FONT_FAMILY },
  changelist: { fontSize: 12, lineHeight: 2, indent: 14, background: "#191a1c", fontFamily: UI_FONT_FAMILY },
  diff: { fontSize: 16, lineHeight: 2, indent: 0, background: "#33373f", fontFamily: CODE_FONT_FAMILY },
  git: { fontSize: 14, lineHeight: 1.8, indent: 14, background: "#191a1c", fontFamily: UI_FONT_FAMILY },
  editor: { fontSize: 16, lineHeight: 2, indent: 0, background: "#33373f", fontFamily: CODE_FONT_FAMILY },
  architecture: { fontSize: 12, lineHeight: 1.5, indent: 0, background: "#272c35", fontFamily: UI_FONT_FAMILY },
  pullRequest: { fontSize: 14, lineHeight: 1.6, indent: 0, background: "#272c35", fontFamily: UI_FONT_FAMILY },
  preview: { fontSize: 13, lineHeight: 1.5, indent: 0, background: "#272c35", fontFamily: UI_FONT_FAMILY },
  // Full-screen programs (tmux's borders and status line) need terminal rows close to the font size.
  terminal: { fontSize: 16, lineHeight: 1.2, indent: 0, background: "#33373f", fontFamily: CODE_FONT_FAMILY },
};

/** Text size of the Architecture tab's nodes at 100 % zoom; its diagrams open zoomed by the set font size over this one. */
export const DIAGRAM_FONT_SIZE = DEFAULT_PANES.architecture.fontSize;

export const PANE_RANGES: Record<NumericPaneSetting, { min: number; max: number; step: number }> = {
  fontSize: { min: 9, max: 32, step: 1 },
  lineHeight: { min: 1, max: 3, step: 0.1 },
  indent: { min: 0, max: 48, step: 2 },
};

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** How the changelist groups files: one flat list or a folder tree. */
export type ChangelistView = "flat" | "tree";

/** Whose line changes the diff viewer shows for a file several sessions changed: this session's or every session's. */
export type DiffLineScope = "own" | "all";

/** Which files the changelist of a session in a shared worktree lists: only its own changes or every change. */
export type ChangelistScope = "own" | "all";

/** Outer size of a floating popup or dialog in px; the popup remembers how the user resized it. */
export type PopupSize = { width: number; height: number };

/** The floating popups and dialogs whose size the user may drag; each remembers its last size (see ui/usePopupSize.ts). */
export type PopupKey = "usages" | "fileSearch" | "findInFiles" | "subChat" | "screenshots" | "fileFilter" | "change" | "pushTarget" | "image" | "review" | "shelve" | "deleteSession" | "staleRemote" | "renameBranch" | "push" | "reset" | "rename" | "renamePreview";

/**
 * Size each popup opens with until the user resizes it. A popup that is as tall as its content treats the height as
 * the most it may take (sub chat, file filter, change, and the form dialogs; see ui/useDialogSize.ts); the window
 * caps every size.
 */
/** Widths in px of the Git log's author and date columns; the subject takes the rest of the row. */
export type GitLogColumns = { author: number; date: number };

export const DEFAULT_GIT_LOG_COLUMNS: GitLogColumns = { author: 150, date: 104 };

export const DEFAULT_POPUP_SIZES: Record<PopupKey, PopupSize> = {
  usages: { width: 1040, height: 600 },
  fileSearch: { width: 960, height: 760 },
  findInFiles: { width: 1100, height: 800 },
  subChat: { width: 640, height: 760 },
  screenshots: { width: 760, height: 640 },
  fileFilter: { width: 320, height: 384 },
  change: { width: 720, height: 320 },
  pushTarget: { width: 460, height: 480 },
  image: { width: 960, height: 720 },
  review: { width: 520, height: 600 },
  shelve: { width: 420, height: 480 },
  deleteSession: { width: 420, height: 400 },
  staleRemote: { width: 460, height: 480 },
  renameBranch: { width: 460, height: 400 },
  reset: { width: 500, height: 520 },
  push: { width: 380, height: 280 },
  rename: { width: 560, height: 320 },
  renamePreview: { width: 1100, height: 760 },
};

/** Distance in px between where a popup opened by default and where the user last left it. */
export type PopupOffset = { x: number; y: number };

/** Which files the dependency graph hides besides the ones unchecked in its file filter. */
export type GraphFilter = {
  /** Files the agent rated below this review level are hidden; files without a rating stay. 1 hides nothing. */
  minReview: ReviewLevel;
  /** Globs over the worktree-relative path as typed, separated by commas or whitespace; matching files are hidden. */
  hiddenGlobs: string;
};

export const DEFAULT_GRAPH_FILTER: GraphFilter = { minReview: 1, hiddenGlobs: "" };

function roundedSize(size: PopupSize): PopupSize {
  return { width: Math.round(size.width), height: Math.round(size.height) };
}

function withDefaultPopupSizes(sizes: Partial<Record<PopupKey, PopupSize>> | undefined): Record<PopupKey, PopupSize> {
  const result = { ...DEFAULT_POPUP_SIZES };
  for (const key of Object.keys(DEFAULT_POPUP_SIZES) as PopupKey[]) {
    const stored = sizes?.[key];
    if (stored) {
      result[key] = stored;
    }
  }
  return result;
}

/**
 * Language of the agent output Hunt asks for without a user prompt (diagram labels, session summaries and
 * titles), as an English language name the prompts quote verbatim; free text, the presets are suggestions.
 */
export const DEFAULT_AI_LANGUAGE = "German";
export const AI_LANGUAGE_PRESETS = ["German", "English", "French", "Spanish", "Italian", "Dutch", "Portuguese"];

/**
 * Response-style instructions Hunt appends to the agent's system prompt in every session; the backend embeds
 * the same file (`src-tauri/src/preferences.rs`). Free text; an empty prompt switches the addition off.
 */
export const DEFAULT_SYSTEM_PROMPT = responseStylePrompt.trim();

/**
 * Model and effort the agent switches to while it writes the architecture diagram, as agent config values: a model
 * option such as `opus` or a full model ID, an effort level such as `high`. The chat's own choice applies again after.
 */
export type GraphAgent = { model: string; effort: string };
export const DEFAULT_GRAPH_AGENT: GraphAgent = { model: "claude-opus-5-5", effort: "high" };

/**
 * Where remote sessions run. The gateway, the VM of `project` labelled `hunt-role=gateway`, runs all the time; the
 * infrastructure repository configures it, the instance template of the session VMs and the gateway's poller
 * `hunt-swf`. Its API provisions each handed-off session's own VM `vm-hunt-s-<short>`, starts and deletes it, and the
 * gateway routes the session's preview URLs to it. `machineType`, one of `SESSION_MACHINE_TYPES` or empty for the
 * template's, applies to the session VMs the gateway creates from now on. Handoffs are offered once the project is
 * set. The private files a handoff copies along are those the repository's hunt.json names (`worktreeInclude`).
 */
export type RemoteSettings = {
  project: string;
  machineType: string;
};
export const DEFAULT_REMOTE: RemoteSettings = {
  project: "",
  machineType: "",
};

/** How Hunt reaches the gateway of `remote` and the machine type of new session VMs, or `null` while its project is missing. */
export function configuredVmSettings(remote: RemoteSettings): VmSettings | null {
  const project = remote.project.trim();
  if (!project) return null;
  return { project, machineType: remote.machineType || null };
}

/** `remote` with a trimmed project and without a machine type Hunt does not offer. */
export function normalizeRemote(remote: RemoteSettings): RemoteSettings {
  return { project: remote.project.trim(), machineType: isSessionMachineType(remote.machineType) ? remote.machineType : "" };
}

/** The kinds of guardrail that live in a folder of their own, set below. */
export type GuardrailDirKind = "rule" | "skill" | "agent" | "adr";

/** The kinds of guardrail the guardrails window manages: `CLAUDE.md` instruction files anywhere in the worktree plus the folder-based kinds. */
export type GuardrailKind = "instruction" | GuardrailDirKind;

/** Worktree-relative folders the guardrails window reads and writes each folder-based kind in, without a trailing slash. */
export type GuardrailDirs = Record<GuardrailDirKind, string>;

/** Where Claude Code reads project rules, skills and subagents from, and the usual folder for architectural decision records. */
export const DEFAULT_GUARDRAIL_DIRS: GuardrailDirs = { rule: ".claude/rules", skill: ".claude/skills", agent: ".claude/agents", adr: "docs/adr" };

/** `./docs/adr/` → `docs/adr`; null when nothing is left or the path is absolute or leaves the worktree. */
export function normalizeGuardrailDir(input: string): string | null {
  const trimmed = input.trim().replace(/\\/g, "/");
  const segments = trimmed.split("/").filter((segment) => segment && segment !== ".");
  if (!segments.length || trimmed.startsWith("/") || segments.includes("..")) return null;
  return segments.join("/");
}

/**
 * One file icon rule: files whose worktree-relative path matches `glob` (see diff/glob.ts) get the vendored icon
 * named `icon` (see diff/fileIcons.ts). Rules are tried in order; the first whose glob matches wins.
 */
export type IconRule = { glob: string; icon: string };

/** Folders that hold an Angular frontend, as a glob alternative; `web-frontend`, `apps/web`, `storefront-ui`. */
const FRONTEND_DIRS = "{frontend,web,*-ui,*-frontend,*-client,*-web}";
/** Folders that hold a NestJS backend, as a glob alternative; `backend`, `apps/api`, `grouper-api`. */
const BACKEND_DIRS = "{backend,server,api,*-api,*-backend,*-server}";

/**
 * One icon per file extension: Angular icons in frontend folders, NestJS icons in backend folders, the extensions
 * only one of the frameworks uses anywhere, then the building-block suffixes of a TypeScript code base with the
 * Hunt icons from tools/icons/custom; other files keep the icon their name gives them (see diff/fileIcons.ts).
 */
export const DEFAULT_ICON_RULES: IconRule[] = [
  { glob: `**/${FRONTEND_DIRS}/**/*.service.ts`, icon: "angular2service" },
  { glob: `**/${FRONTEND_DIRS}/**/*.guard.ts`, icon: "angular2guard" },
  { glob: `**/${FRONTEND_DIRS}/**/*.pipe.ts`, icon: "angular2pipe" },
  { glob: `**/${FRONTEND_DIRS}/**/*.module.ts`, icon: "angular2module" },
  { glob: `**/${BACKEND_DIRS}/**/*.service.ts`, icon: "nestservice" },
  { glob: `**/${BACKEND_DIRS}/**/*.guard.ts`, icon: "nestguard" },
  { glob: `**/${BACKEND_DIRS}/**/*.pipe.ts`, icon: "nestpipe" },
  { glob: `**/${BACKEND_DIRS}/**/*.module.ts`, icon: "nestmodule" },
  { glob: "*.component.ts", icon: "angular2component" },
  { glob: "*.directive.ts", icon: "angular2directive" },
  { glob: "*.controller.ts", icon: "nestcontroller" },
  { glob: "*.middleware.ts", icon: "nestmiddleware" },
  { glob: "*.decorator.ts", icon: "nestdecorator" },
  { glob: "*.gateway.ts", icon: "nestgateway" },
  { glob: "*.filter.ts", icon: "nestfilter" },
  { glob: "*.page.ts", icon: "page" },
  { glob: "*.{dialog,modal}.ts", icon: "dialog" },
  { glob: "*.{store,state,actions,reducer,effects,selectors}.ts", icon: "store" },
  { glob: "*.{routes,routing,router}.ts", icon: "routes" },
  { glob: "*.{service,api-service,form-service}.ts", icon: "service" },
  { glob: "*.{repository,repo}.ts", icon: "repository" },
  { glob: "*.{entity,entities}.ts", icon: "entity" },
  { glob: "*.embeddable.ts", icon: "embeddable" },
  { glob: "*.{value-object,vo}.ts", icon: "value-object" },
  { glob: "*.{aggregate,aggregate-root,domain}.ts", icon: "aggregate" },
  { glob: "*.{dto,dtos}.ts", icon: "dto" },
  { glob: "*.{request,requests}.ts", icon: "request" },
  { glob: "*.{response,responses}.ts", icon: "response" },
  { glob: "*.module.ts", icon: "module" },
  { glob: "*.{model,models}.ts", icon: "model" },
  { glob: "*.{resolver,resolvers}.ts", icon: "resolver" },
  { glob: "*.{guard,guards}.ts", icon: "guard" },
  { glob: "*.interceptor.ts", icon: "interceptor" },
  { glob: "*.{pipe,pipes}.ts", icon: "pipe" },
  { glob: "*.decorators.ts", icon: "decorator" },
  { glob: "*.{event,events}.ts", icon: "event" },
  { glob: "*.{exception,exceptions,error,errors}.ts", icon: "exception" },
  { glob: "*.{mapper,mappers}.ts", icon: "mapper" },
  { glob: "*.{provider,providers}.ts", icon: "provider" },
  { glob: "*.{validator,validators,validation}.ts", icon: "validator" },
  { glob: "*.{seeder,seed}.ts", icon: "seeder" },
  { glob: "*.{enum,enums}.ts", icon: "enum" },
  { glob: "*.{interface,interfaces,type,types}.ts", icon: "interface" },
  { glob: "*.{constant,constants}.ts", icon: "constants" },
  { glob: "*.{util,utils,utilities,helper,helpers}.ts", icon: "utils" },
  { glob: "*.{query,queries}.ts", icon: "queries" },
  { glob: "*.{gql,graphql}.ts", icon: "graphql" },
  { glob: "*.config.ts", icon: "tsconfig" },
  { glob: "*.{spec-sqlite,spec-postgresql}.ts", icon: "testtsfiles" },
];

/** Trims both fields; a rule may be incomplete while it is being typed (an empty glob matches nothing). */
function normalizeIconRule(rule: IconRule): IconRule {
  return { glob: rule.glob.trim(), icon: rule.icon.trim() };
}

export function isIconRulesDefault(rules: readonly IconRule[]): boolean {
  return rules.length === DEFAULT_ICON_RULES.length && rules.every((rule, index) => rule.glob === DEFAULT_ICON_RULES[index].glob && rule.icon === DEFAULT_ICON_RULES[index].icon);
}

/**
 * One folder icon rule: folders whose worktree-relative path matches `glob` (see diff/glob.ts) get the vendored
 * folder icon named `icon`, a closed `folder_*` icon whose open state is `<icon>_open` (see diff/fileIcons.ts). With
 * `includeSubfolders` every folder below a matching one gets the icon too. The first matching rule wins.
 */
export type FolderIconRule = { glob: string; icon: string; includeSubfolders: boolean };

/** Folders that hold a user interface take the icon Atom gives `frontend` and `client`; their subfolders keep their own. */
export const DEFAULT_FOLDER_ICON_RULES: FolderIconRule[] = [{ glob: "{ui,admin-ui}", icon: "folder_client", includeSubfolders: false }];

function normalizeFolderIconRule(rule: FolderIconRule): FolderIconRule {
  return { ...normalizeIconRule(rule), includeSubfolders: rule.includeSubfolders };
}

export function isFolderIconRulesDefault(rules: readonly FolderIconRule[]): boolean {
  return (
    rules.length === DEFAULT_FOLDER_ICON_RULES.length &&
    rules.every((rule, index) => {
      const fallback = DEFAULT_FOLDER_ICON_RULES[index];
      return rule.glob === fallback.glob && rule.icon === fallback.icon && rule.includeSubfolders === fallback.includeSubfolders;
    })
  );
}

type SettingsState = {
  panes: Record<PaneKey, PaneSettings>;
  changelistView: ChangelistView;
  /** Globs over the worktree-relative path as typed, separated by commas or whitespace; matching files leave the changelist. */
  changelistHiddenGlobs: string;
  diffLineScope: DiffLineScope;
  /** Sessions whose changelist lists every change, keyed by session id; every other session lists only its own. */
  changelistScopes: Record<string, ChangelistScope>;
  /** Changed files unchecked in the dependency graph's file filter, keyed by session id; every other file is shown. */
  graphExcludedFiles: Record<string, string[]>;
  /** Diagram type the Architecture tab shows, keyed by session id; a session without an entry shows the dependencies. */
  diagramTypes: Record<string, DiagramType>;
  popupSizes: Record<PopupKey, PopupSize>;
  gitLogColumns: GitLogColumns;
  /** Height in px the user dragged the chat's prompt box to; null sizes the box to its text. */
  promptHeight: number | null;
  /** Height in px the user dragged the sub chat popover's text area to; null sizes it to its text. */
  subChatPromptHeight: number | null;
  /** How far the guardrail chat's bottom right corner sits from its default place above the "Guardrail" button. */
  guardrailChatOffset: PopupOffset;
  graphFilter: GraphFilter;
  aiLanguage: string;
  /** System prompt addition for every agent session; see `DEFAULT_SYSTEM_PROMPT`. */
  systemPrompt: string;
  graphAgent: GraphAgent;
  guardrailDirs: GuardrailDirs;
  iconRules: IconRule[];
  folderIconRules: FolderIconRule[];
  /** Whether the chat shows the session summary box above the messages. */
  showSummary: boolean;
  /** Whether deleting a session asks for confirmation first; the dialog's "Don't ask again" turns it off. */
  confirmSessionDelete: boolean;
  remote: RemoteSettings;
  /** Keyboard shortcuts the user changed, per command (see keymap.ts); every other command keeps its defaults. */
  keymap: Keymap;
  setPaneSetting: <K extends keyof PaneSettings>(pane: PaneKey, key: K, value: PaneSettings[K]) => void;
  resetPane: (pane: PaneKey) => void;
  resetPanes: () => void;
  setChangelistView: (view: ChangelistView) => void;
  setChangelistHiddenGlobs: (globs: string) => void;
  setDiffLineScope: (scope: DiffLineScope) => void;
  setChangelistScope: (sessionId: string, scope: ChangelistScope) => void;
  setGraphExcludedFiles: (sessionId: string, paths: string[]) => void;
  setDiagramType: (sessionId: string, diagramType: DiagramType) => void;
  setPopupSize: (key: PopupKey, size: PopupSize) => void;
  setGitLogColumns: (columns: GitLogColumns) => void;
  setPromptHeight: (height: number | null) => void;
  setSubChatPromptHeight: (height: number | null) => void;
  setGuardrailChatOffset: (offset: PopupOffset) => void;
  setGraphFilter: (patch: Partial<GraphFilter>) => void;
  setAiLanguage: (language: string) => void;
  setSystemPrompt: (prompt: string) => void;
  setGraphAgent: (key: keyof GraphAgent, value: string) => void;
  setGuardrailDir: (kind: GuardrailDirKind, dir: string) => void;
  resetGuardrailDirs: () => void;
  setIconRules: (rules: IconRule[]) => void;
  resetIconRules: () => void;
  setFolderIconRules: (rules: FolderIconRule[]) => void;
  resetFolderIconRules: () => void;
  toggleSummary: () => void;
  setConfirmSessionDelete: (confirm: boolean) => void;
  setRemote: (patch: Partial<RemoteSettings>) => void;
  setKeyBindings: (id: CommandId, shortcuts: readonly string[]) => void;
  resetKeymap: () => void;
};

/** Shape persisted by version 0, which only knew one font size per pane. */
type LegacyState = { uiFontSize?: number; chatFontSize?: number; treeFontSize?: number; diffFontSize?: number };

/** Pane backgrounds that were the defaults in earlier versions; a stored match is lifted to the current default. */
const VERSION_1_BACKGROUNDS: Partial<Record<PaneKey, string>> = { sidebar: "#1b1e25", changelist: "#1b1e25", diff: "#272c35" };
const VERSION_2_BACKGROUNDS: Partial<Record<PaneKey, string>> = { sidebar: "#0b0c0d", changelist: "#0b0c0d", diff: "#23272f" };

/** Code font stack that was the default up to version 3; a stored match is lifted to the current default. */
const VERSION_3_CODE_FONT_FAMILY = '"Code Monospace", ui-monospace, SFMono-Regular, Menlo, Monaco, "JetBrains Mono", monospace';

/** Changelist line height that was the default up to version 4; a stored match is lifted to the current default. */
const VERSION_4_CHANGELIST_LINE_HEIGHT = 1.5;

/** Chat line height that was the default up to version 7; a stored match is lifted to the current default. */
const VERSION_7_CHAT_LINE_HEIGHT = 1.7;

/** What `persist` writes to storage: every user preference, each optional because older versions did not have it. */
export type PersistedState = {
  panes?: Partial<Record<PaneKey, Partial<PaneSettings>>>;
  changelistView?: ChangelistView;
  changelistHiddenGlobs?: string;
  diffLineScope?: DiffLineScope;
  changelistScopes?: Record<string, ChangelistScope>;
  graphExcludedFiles?: Record<string, string[]>;
  diagramTypes?: Record<string, DiagramType>;
  popupSizes?: Partial<Record<PopupKey, PopupSize>>;
  gitLogColumns?: Partial<GitLogColumns>;
  promptHeight?: number | null;
  subChatPromptHeight?: number | null;
  guardrailChatOffset?: PopupOffset;
  graphFilter?: GraphFilter;
  aiLanguage?: string;
  systemPrompt?: string;
  graphAgent?: Partial<GraphAgent>;
  guardrailDirs?: Partial<GuardrailDirs>;
  iconRules?: IconRule[];
  folderIconRules?: FolderIconRule[];
  showSummary?: boolean;
  confirmSessionDelete?: boolean;
  remote?: Partial<RemoteSettings>;
  keymap?: Keymap;
};

/** Rewrites backgrounds still set to a previous version's default so users who never picked a color follow the new one. */
function liftDefaultBackgrounds(panes: PersistedState["panes"], previous: Partial<Record<PaneKey, string>>): PersistedState["panes"] {
  if (!panes) return panes;
  const result = { ...panes };
  for (const [pane, background] of Object.entries(previous) as [PaneKey, string][]) {
    if (result[pane]?.background !== background) continue;
    result[pane] = { ...result[pane], background: DEFAULT_PANES[pane].background };
  }
  return result;
}

/** Rewrites the diff font still set to a previous version's default so users who never picked a font follow the new one. */
function liftDefaultCodeFont(panes: PersistedState["panes"]): PersistedState["panes"] {
  if (panes?.diff?.fontFamily !== VERSION_3_CODE_FONT_FAMILY) return panes;
  return { ...panes, diff: { ...panes.diff, fontFamily: CODE_FONT_FAMILY } };
}

/** Rewrites the changelist line height still set to a previous version's default so users who never changed it follow the new one. */
function liftDefaultChangelistLineHeight(panes: PersistedState["panes"]): PersistedState["panes"] {
  if (panes?.changelist?.lineHeight !== VERSION_4_CHANGELIST_LINE_HEIGHT) return panes;
  return { ...panes, changelist: { ...panes.changelist, lineHeight: DEFAULT_PANES.changelist.lineHeight } };
}

/** Rewrites the chat line height still set to a previous version's default so users who never changed it follow the new one. */
function liftDefaultChatLineHeight(panes: PersistedState["panes"]): PersistedState["panes"] {
  if (panes?.chat?.lineHeight !== VERSION_7_CHAT_LINE_HEIGHT) return panes;
  return { ...panes, chat: { ...panes.chat, lineHeight: DEFAULT_PANES.chat.lineHeight } };
}

function clampNumeric(key: NumericPaneSetting, value: number): number {
  const range = PANE_RANGES[key];
  const steps = Math.round((value - range.min) / range.step);
  return Math.min(range.max, Math.max(range.min, Number((range.min + steps * range.step).toFixed(2))));
}

function withDefaults(panes: Partial<Record<PaneKey, Partial<PaneSettings>>> | undefined): Record<PaneKey, PaneSettings> {
  const result = { ...DEFAULT_PANES };
  for (const pane of Object.keys(DEFAULT_PANES) as PaneKey[]) {
    const stored = Object.entries(panes?.[pane] ?? {}).filter(([, value]) => value !== undefined);
    result[pane] = { ...DEFAULT_PANES[pane], ...Object.fromEntries(stored) };
  }
  return result;
}

/** Current version of the persisted shape; `migrateSettings` brings older ones up to date. */
export const SETTINGS_VERSION = 15;

/** Shape persisted up to version 6, which kept one field per resizable popup. */
type Version6State = PersistedState & { usagesPopupSize?: PopupSize; fileSearchDialogSize?: PopupSize; subChatPopoverSize?: PopupSize };

/** Moves the per-popup size fields of versions 5 and 6 into `popupSizes`. */
function gatherPopupSizes(stored: Version6State): PersistedState {
  const { usagesPopupSize, fileSearchDialogSize, subChatPopoverSize, ...rest } = stored;
  const popupSizes: Partial<Record<PopupKey, PopupSize>> = { ...rest.popupSizes };
  if (usagesPopupSize) {
    popupSizes.usages = usagesPopupSize;
  }
  if (fileSearchDialogSize) {
    popupSizes.fileSearch = fileSearchDialogSize;
  }
  if (subChatPopoverSize) {
    popupSizes.subChat = subChatPopoverSize;
  }
  return { ...rest, popupSizes };
}

/** Catppuccin icon names the default icon rules used up to version 8, mapped to their Atom Material counterparts. */
const CATPPUCCIN_TO_ATOM_ICONS: Record<string, string> = {
  "angular-service": "angular2service",
  "angular-guard": "angular2guard",
  "angular-pipe": "angular2pipe",
  angular: "angular2module",
  "angular-component": "angular2component",
  "angular-directive": "angular2directive",
  "nest-service": "nestservice",
  "nest-guard": "nestguard",
  "nest-pipe": "nestpipe",
  nest: "nestmodule",
  "nest-controller": "nestcontroller",
  "nest-middleware": "nestmiddleware",
  "nest-decorator": "nestdecorator",
  "nest-gateway": "nestgateway",
  "nest-filter": "nestfilter",
  "typescript-config": "tsconfig",
  "typescript-test": "testtsfiles",
};

/** Points icon rules that name a Catppuccin icon of the old default rules at the Atom Material icon that replaced it. */
function renameCatppuccinIcons(stored: PersistedState): PersistedState {
  if (!stored.iconRules) return stored;
  return { ...stored, iconRules: stored.iconRules.map((rule) => ({ ...rule, icon: CATPPUCCIN_TO_ATOM_ICONS[rule.icon] ?? rule.icon })) };
}

/**
 * The remote fields a store of version 13 or older keeps; those versions also held what the infrastructure repository
 * configures and, up to 13, the file patterns the repository's hunt.json names now (`worktreeInclude`).
 */
const REMOTE_KEYS: string[] = ["project"] satisfies (keyof RemoteSettings)[];

/**
 * Drops the remote settings Hunt no longer keeps: up to version 9 the VM all sessions shared, up to version 11 the
 * instance template and preview domain, up to version 12 the gateway's zone, instance, the machine type and the
 * poller's repositories and session limit, up to version 13 the file patterns (`worktreeInclude` in hunt.json now).
 */
function withoutInfrastructureFields(stored: PersistedState): PersistedState {
  if (!stored.remote) return stored;
  return { ...stored, remote: Object.fromEntries(Object.entries(stored.remote).filter(([key]) => REMOTE_KEYS.includes(key))) };
}

/** The editor and the terminal followed the diff pane's font up to version 14; they start from its stored values. */
function seedFromDiffPane(stored: PersistedState): PersistedState {
  const diff = stored.panes?.diff;
  if (!diff) return stored;
  const { fontSize, lineHeight, fontFamily, background } = diff;
  const editor = Object.fromEntries(Object.entries({ fontSize, lineHeight, fontFamily }).filter(([, value]) => value !== undefined));
  const terminal = Object.fromEntries(Object.entries({ fontSize, fontFamily, background }).filter(([, value]) => value !== undefined));
  return { ...stored, panes: { ...stored.panes, editor: { ...editor, ...stored.panes?.editor }, terminal: { ...terminal, ...stored.panes?.terminal } } };
}

/**
 * Brings a persisted state of an earlier `version` to the current shape: version 0 only knew one font size per pane,
 * versions 1 to 4 and 7 had defaults that are lifted to the current ones where the user never changed them, versions
 * 5 and 6 kept the size of each resizable popup in its own field, versions up to 8 named Catppuccin icons in their icon
 * rules, versions up to 13 kept remote settings that the infrastructure repository or the repository's hunt.json
 * configures now, and up to version 14 the editor and the terminal used the diff pane's font. Fields a version did not have (`guardrailDirs`, `showSummary`, `iconRules`, `folderIconRules`,
 * `confirmSessionDelete`, `diffLineScope`, `changelistScopes`, `graphExcludedFiles`, …) are filled in from the defaults
 * by `mergeSettings`.
 */
export function migrateSettings(persisted: unknown, version: number): PersistedState {
  if (version >= 15) return persisted as PersistedState;
  return seedFromDiffPane(migrateToVersion14(persisted, version));
}

function migrateToVersion14(persisted: unknown, version: number): PersistedState {
  if (version >= 14) return persisted as PersistedState;
  if (version >= 9) return withoutInfrastructureFields(persisted as PersistedState);
  return withoutInfrastructureFields(renameCatppuccinIcons(migrateToVersion8(persisted, version)));
}

function migrateToVersion8(persisted: unknown, version: number): PersistedState {
  if (version >= 8) return persisted as PersistedState;
  if (version >= 7) {
    const stored = persisted as PersistedState;
    return { ...stored, panes: liftDefaultChatLineHeight(stored.panes) };
  }
  if (version >= 5) {
    const gathered = gatherPopupSizes(persisted as Version6State);
    return { ...gathered, panes: liftDefaultChatLineHeight(gathered.panes) };
  }
  if (version >= 1) {
    const stored = persisted as PersistedState;
    const previous = version === 1 ? VERSION_1_BACKGROUNDS : VERSION_2_BACKGROUNDS;
    const backgrounds = version < 3 ? liftDefaultBackgrounds(stored.panes, previous) : stored.panes;
    const fonts = version < 4 ? liftDefaultCodeFont(backgrounds) : backgrounds;
    return { ...stored, panes: liftDefaultChatLineHeight(liftDefaultChangelistLineHeight(fonts)) };
  }
  const legacy = persisted as LegacyState & { changelistView?: ChangelistView };
  return {
    changelistView: legacy.changelistView,
    panes: withDefaults({
      sidebar: { fontSize: legacy.uiFontSize },
      chat: { fontSize: legacy.chatFontSize },
      changelist: { fontSize: legacy.treeFontSize },
      diff: { fontSize: legacy.diffFontSize },
    }),
  };
}

/**
 * Layers the persisted state over `current` (the defaults with the actions). Panes, guardrail folders and popup sizes
 * gain entries over time, so stored ones are layered over the defaults per key instead of replacing them.
 */
export function mergeSettings<T extends Pick<SettingsState, "panes" | "graphAgent" | "guardrailDirs" | "popupSizes" | "gitLogColumns" | "remote">>(persisted: unknown, current: T): T {
  const stored = persisted as PersistedState | undefined;
  return {
    ...current,
    ...stored,
    panes: withDefaults(stored?.panes),
    graphAgent: { ...DEFAULT_GRAPH_AGENT, ...stored?.graphAgent },
    guardrailDirs: { ...DEFAULT_GUARDRAIL_DIRS, ...stored?.guardrailDirs },
    popupSizes: withDefaultPopupSizes(stored?.popupSizes),
    gitLogColumns: { ...DEFAULT_GIT_LOG_COLUMNS, ...stored?.gitLogColumns },
    remote: normalizeRemote({ ...DEFAULT_REMOTE, ...stored?.remote }),
    keymap: normalizeKeymap(stored?.keymap),
  };
}

/** User preferences that survive restarts (persisted in localStorage under `hunt-settings`). */
export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      panes: DEFAULT_PANES,
      changelistView: "tree",
      changelistHiddenGlobs: "",
      diffLineScope: "all",
      changelistScopes: {},
      graphExcludedFiles: {},
      diagramTypes: {},
      popupSizes: DEFAULT_POPUP_SIZES,
      gitLogColumns: DEFAULT_GIT_LOG_COLUMNS,
      promptHeight: null,
      subChatPromptHeight: null,
      guardrailChatOffset: { x: 0, y: 0 },
      graphFilter: DEFAULT_GRAPH_FILTER,
      aiLanguage: DEFAULT_AI_LANGUAGE,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      graphAgent: DEFAULT_GRAPH_AGENT,
      guardrailDirs: DEFAULT_GUARDRAIL_DIRS,
      iconRules: DEFAULT_ICON_RULES,
      folderIconRules: DEFAULT_FOLDER_ICON_RULES,
      showSummary: true,
      confirmSessionDelete: true,
      remote: DEFAULT_REMOTE,
      keymap: {},
      setPaneSetting: (pane, key, value) =>
        set((state) => {
          if (key === "background") {
            if (typeof value !== "string" || !HEX_COLOR.test(value)) return state;
            return { panes: { ...state.panes, [pane]: { ...state.panes[pane], background: value.toLowerCase() } } };
          }
          if (key === "fontFamily") {
            if (typeof value !== "string" || !value.trim()) return state;
            return { panes: { ...state.panes, [pane]: { ...state.panes[pane], fontFamily: value.trim() } } };
          }
          if (typeof value !== "number" || !Number.isFinite(value)) return state;
          return { panes: { ...state.panes, [pane]: { ...state.panes[pane], [key]: clampNumeric(key, value) } } };
        }),
      resetPane: (pane) => set((state) => ({ panes: { ...state.panes, [pane]: DEFAULT_PANES[pane] } })),
      resetPanes: () => set({ panes: DEFAULT_PANES }),
      setChangelistView: (changelistView) => set({ changelistView }),
      setChangelistHiddenGlobs: (globs) => set({ changelistHiddenGlobs: globs.trim() }),
      setDiffLineScope: (diffLineScope) => set({ diffLineScope }),
      setChangelistScope: (sessionId, scope) =>
        set((state) => {
          const { [sessionId]: _previous, ...rest } = state.changelistScopes;
          return { changelistScopes: scope === "all" ? { ...rest, [sessionId]: scope } : rest };
        }),
      setGraphExcludedFiles: (sessionId, paths) =>
        set((state) => {
          const { [sessionId]: _previous, ...rest } = state.graphExcludedFiles;
          return { graphExcludedFiles: paths.length ? { ...rest, [sessionId]: [...paths].sort() } : rest };
        }),
      setDiagramType: (sessionId, diagramType) =>
        set((state) => {
          const { [sessionId]: _previous, ...rest } = state.diagramTypes;
          return { diagramTypes: diagramType === "dependencies" ? rest : { ...rest, [sessionId]: diagramType } };
        }),
      setPopupSize: (key, size) => set((state) => ({ popupSizes: { ...state.popupSizes, [key]: roundedSize(size) } })),
      setGitLogColumns: (columns) => set({ gitLogColumns: { author: Math.round(columns.author), date: Math.round(columns.date) } }),
      setPromptHeight: (height) => set({ promptHeight: height === null ? null : Math.round(height) }),
      setSubChatPromptHeight: (height) => set({ subChatPromptHeight: height === null ? null : Math.round(height) }),
      setGuardrailChatOffset: (offset) => set({ guardrailChatOffset: { x: Math.round(offset.x), y: Math.round(offset.y) } }),
      setGraphFilter: (patch) =>
        set((state) => {
          const next = { ...state.graphFilter, ...patch };
          return { graphFilter: { ...next, hiddenGlobs: next.hiddenGlobs.trim() } };
        }),
      setAiLanguage: (language) => set((state) => (language.trim() ? { aiLanguage: language.trim() } : state)),
      setSystemPrompt: (prompt) => set({ systemPrompt: prompt.trim() }),
      setGraphAgent: (key, value) => set((state) => (value.trim() ? { graphAgent: { ...state.graphAgent, [key]: value.trim() } } : state)),
      setGuardrailDir: (kind, dir) =>
        set((state) => {
          const normalized = normalizeGuardrailDir(dir);
          return normalized ? { guardrailDirs: { ...state.guardrailDirs, [kind]: normalized } } : state;
        }),
      resetGuardrailDirs: () => set({ guardrailDirs: DEFAULT_GUARDRAIL_DIRS }),
      setIconRules: (rules) => set({ iconRules: rules.map(normalizeIconRule) }),
      resetIconRules: () => set({ iconRules: DEFAULT_ICON_RULES }),
      setFolderIconRules: (rules) => set({ folderIconRules: rules.map(normalizeFolderIconRule) }),
      resetFolderIconRules: () => set({ folderIconRules: DEFAULT_FOLDER_ICON_RULES }),
      toggleSummary: () => set((state) => ({ showSummary: !state.showSummary })),
      setConfirmSessionDelete: (confirmSessionDelete) => set({ confirmSessionDelete }),
      setRemote: (patch) => set((state) => ({ remote: normalizeRemote({ ...state.remote, ...patch }) })),
      setKeyBindings: (id, shortcuts) => set((state) => ({ keymap: withBindings(state.keymap, id, shortcuts) })),
      resetKeymap: () => set({ keymap: {} }),
    }),
    {
      name: "hunt-settings",
      version: SETTINGS_VERSION,
      partialize: (state) => ({
        panes: state.panes,
        changelistView: state.changelistView,
        changelistHiddenGlobs: state.changelistHiddenGlobs,
        diffLineScope: state.diffLineScope,
        changelistScopes: state.changelistScopes,
        graphExcludedFiles: state.graphExcludedFiles,
        diagramTypes: state.diagramTypes,
        popupSizes: state.popupSizes,
        gitLogColumns: state.gitLogColumns,
        promptHeight: state.promptHeight,
        subChatPromptHeight: state.subChatPromptHeight,
        guardrailChatOffset: state.guardrailChatOffset,
        graphFilter: state.graphFilter,
        aiLanguage: state.aiLanguage,
        systemPrompt: state.systemPrompt,
        graphAgent: state.graphAgent,
        guardrailDirs: state.guardrailDirs,
        iconRules: state.iconRules,
        folderIconRules: state.folderIconRules,
        showSummary: state.showSummary,
        confirmSessionDelete: state.confirmSessionDelete,
        remote: state.remote,
        keymap: state.keymap,
      }),
      migrate: migrateSettings,
      merge: mergeSettings,
    },
  ),
);
