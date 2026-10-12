import { create } from "zustand";
import { persist } from "zustand/middleware";
import responseStylePrompt from "../../prompts/response-style.md?raw";

/** The four configurable panes of the window. */
export type PaneKey = "sidebar" | "chat" | "changelist" | "diff";

export type PaneSettings = {
  /** Text size in px. */
  fontSize: number;
  /** Line height as a multiple of the font size. */
  lineHeight: number;
  /** Indentation per nesting level in px (sub chats in the sidebar, folders in the changelist). */
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
};

export const PANE_RANGES: Record<NumericPaneSetting, { min: number; max: number; step: number }> = {
  fontSize: { min: 9, max: 32, step: 1 },
  lineHeight: { min: 1, max: 3, step: 0.1 },
  indent: { min: 0, max: 48, step: 2 },
};

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** How the changelist groups files: one flat list or a folder tree. */
export type ChangelistView = "flat" | "tree";

/** Outer size of a floating popup or dialog in px; the popup remembers how the user resized it. */
export type PopupSize = { width: number; height: number };

/** The floating popups and dialogs whose size the user may drag; each remembers its last size (see ui/usePopupSize.ts). */
export type PopupKey = "usages" | "fileSearch" | "subChat" | "screenshots" | "pullRequests" | "fileFilter" | "change";

/**
 * Size each popup opens with until the user resizes it. A popup that is as tall as its content treats the height as
 * the most it may take (sub chat, pull requests, file filter, change); the window caps every size.
 */
export const DEFAULT_POPUP_SIZES: Record<PopupKey, PopupSize> = {
  usages: { width: 1040, height: 600 },
  fileSearch: { width: 960, height: 760 },
  subChat: { width: 640, height: 760 },
  screenshots: { width: 760, height: 640 },
  pullRequests: { width: 760, height: 560 },
  fileFilter: { width: 320, height: 384 },
  change: { width: 720, height: 320 },
};

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
  { glob: `**/${FRONTEND_DIRS}/**/*.service.ts`, icon: "angular-service" },
  { glob: `**/${FRONTEND_DIRS}/**/*.guard.ts`, icon: "angular-guard" },
  { glob: `**/${FRONTEND_DIRS}/**/*.pipe.ts`, icon: "angular-pipe" },
  { glob: `**/${FRONTEND_DIRS}/**/*.module.ts`, icon: "angular" },
  { glob: `**/${BACKEND_DIRS}/**/*.service.ts`, icon: "nest-service" },
  { glob: `**/${BACKEND_DIRS}/**/*.guard.ts`, icon: "nest-guard" },
  { glob: `**/${BACKEND_DIRS}/**/*.pipe.ts`, icon: "nest-pipe" },
  { glob: `**/${BACKEND_DIRS}/**/*.module.ts`, icon: "nest" },
  { glob: "*.component.ts", icon: "angular-component" },
  { glob: "*.directive.ts", icon: "angular-directive" },
  { glob: "*.controller.ts", icon: "nest-controller" },
  { glob: "*.middleware.ts", icon: "nest-middleware" },
  { glob: "*.decorator.ts", icon: "nest-decorator" },
  { glob: "*.gateway.ts", icon: "nest-gateway" },
  { glob: "*.filter.ts", icon: "nest-filter" },
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
  { glob: "*.config.ts", icon: "typescript-config" },
  { glob: "*.{spec-sqlite,spec-postgresql}.ts", icon: "typescript-test" },
];

/** Trims both fields; a rule may be incomplete while it is being typed (an empty glob matches nothing). */
function normalizeIconRule(rule: IconRule): IconRule {
  return { glob: rule.glob.trim(), icon: rule.icon.trim() };
}

export function isIconRulesDefault(rules: readonly IconRule[]): boolean {
  return rules.length === DEFAULT_ICON_RULES.length && rules.every((rule, index) => rule.glob === DEFAULT_ICON_RULES[index].glob && rule.icon === DEFAULT_ICON_RULES[index].icon);
}

type SettingsState = {
  panes: Record<PaneKey, PaneSettings>;
  changelistView: ChangelistView;
  popupSizes: Record<PopupKey, PopupSize>;
  aiLanguage: string;
  /** System prompt addition for every agent session; see `DEFAULT_SYSTEM_PROMPT`. */
  systemPrompt: string;
  guardrailDirs: GuardrailDirs;
  iconRules: IconRule[];
  /** Whether the chat shows the session summary box above the messages. */
  showSummary: boolean;
  /** Whether deleting a session asks for confirmation first; the dialog's "Don't ask again" turns it off. */
  confirmSessionDelete: boolean;
  setPaneSetting: <K extends keyof PaneSettings>(pane: PaneKey, key: K, value: PaneSettings[K]) => void;
  resetPane: (pane: PaneKey) => void;
  resetPanes: () => void;
  setChangelistView: (view: ChangelistView) => void;
  setPopupSize: (key: PopupKey, size: PopupSize) => void;
  setAiLanguage: (language: string) => void;
  setSystemPrompt: (prompt: string) => void;
  setGuardrailDir: (kind: GuardrailDirKind, dir: string) => void;
  resetGuardrailDirs: () => void;
  setIconRules: (rules: IconRule[]) => void;
  resetIconRules: () => void;
  toggleSummary: () => void;
  setConfirmSessionDelete: (confirm: boolean) => void;
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
  popupSizes?: Partial<Record<PopupKey, PopupSize>>;
  aiLanguage?: string;
  systemPrompt?: string;
  guardrailDirs?: Partial<GuardrailDirs>;
  iconRules?: IconRule[];
  showSummary?: boolean;
  confirmSessionDelete?: boolean;
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
export const SETTINGS_VERSION = 8;

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

/**
 * Brings a persisted state of an earlier `version` to the current shape: version 0 only knew one font size per pane,
 * versions 1 to 4 and 7 had defaults that are lifted to the current ones where the user never changed them, versions
 * 5 and 6 kept the size of each resizable popup in its own field. Fields a version did not have (`guardrailDirs`,
 * `showSummary`, `iconRules`, `confirmSessionDelete`, …) are filled in from the defaults by `mergeSettings`.
 */
export function migrateSettings(persisted: unknown, version: number): PersistedState {
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
export function mergeSettings<T extends Pick<SettingsState, "panes" | "guardrailDirs" | "popupSizes">>(persisted: unknown, current: T): T {
  const stored = persisted as PersistedState | undefined;
  return {
    ...current,
    ...stored,
    panes: withDefaults(stored?.panes),
    guardrailDirs: { ...DEFAULT_GUARDRAIL_DIRS, ...stored?.guardrailDirs },
    popupSizes: withDefaultPopupSizes(stored?.popupSizes),
  };
}

/** User preferences that survive restarts (persisted in localStorage under `hunt-settings`). */
export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      panes: DEFAULT_PANES,
      changelistView: "tree",
      popupSizes: DEFAULT_POPUP_SIZES,
      aiLanguage: DEFAULT_AI_LANGUAGE,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      guardrailDirs: DEFAULT_GUARDRAIL_DIRS,
      iconRules: DEFAULT_ICON_RULES,
      showSummary: true,
      confirmSessionDelete: true,
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
      setPopupSize: (key, size) => set((state) => ({ popupSizes: { ...state.popupSizes, [key]: roundedSize(size) } })),
      setAiLanguage: (language) => set((state) => (language.trim() ? { aiLanguage: language.trim() } : state)),
      setSystemPrompt: (prompt) => set({ systemPrompt: prompt.trim() }),
      setGuardrailDir: (kind, dir) =>
        set((state) => {
          const normalized = normalizeGuardrailDir(dir);
          return normalized ? { guardrailDirs: { ...state.guardrailDirs, [kind]: normalized } } : state;
        }),
      resetGuardrailDirs: () => set({ guardrailDirs: DEFAULT_GUARDRAIL_DIRS }),
      setIconRules: (rules) => set({ iconRules: rules.map(normalizeIconRule) }),
      resetIconRules: () => set({ iconRules: DEFAULT_ICON_RULES }),
      toggleSummary: () => set((state) => ({ showSummary: !state.showSummary })),
      setConfirmSessionDelete: (confirmSessionDelete) => set({ confirmSessionDelete }),
    }),
    {
      name: "hunt-settings",
      version: SETTINGS_VERSION,
      partialize: (state) => ({
        panes: state.panes,
        changelistView: state.changelistView,
        popupSizes: state.popupSizes,
        aiLanguage: state.aiLanguage,
        systemPrompt: state.systemPrompt,
        guardrailDirs: state.guardrailDirs,
        iconRules: state.iconRules,
        showSummary: state.showSummary,
        confirmSessionDelete: state.confirmSessionDelete,
      }),
      migrate: migrateSettings,
      merge: mergeSettings,
    },
  ),
);
