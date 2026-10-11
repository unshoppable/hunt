import { useEffect, useId, useState, type CSSProperties } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useSettingsSync } from "../app/bootstrap";
import { resolveFileIcon, useFileIconUrl } from "../diff/fileIcons";
import {
  AI_LANGUAGE_PRESETS,
  DEFAULT_AI_LANGUAGE,
  DEFAULT_GUARDRAIL_DIRS,
  DEFAULT_PANES,
  FONT_FAMILY_PRESETS,
  PANE_RANGES,
  isIconRulesDefault,
  useSettingsStore,
  type GuardrailDirs,
  type GuardrailDirKind,
  type IconRule,
  type NumericPaneSetting,
  type PaneKey,
  type PaneSettings,
} from "../state/settings";
import { HEADER_BAR } from "../ui/bars";
import { BUTTON_SM, GHOST_BUTTON, ICON_BUTTON_SM, PRIMARY_BUTTON, SECONDARY_BUTTON_SM } from "../ui/buttons";
import { PlusIcon, TrashIcon } from "../ui/icons";
import { useSecondaryWindow } from "../ui/nativeWindow";
import { IconPicker } from "./IconPicker";

type Section = { pane: PaneKey; title: string; hint: string; fields: (keyof PaneSettings)[] };

/** One page per pane; indentation only exists where rows nest. */
const SECTIONS: Section[] = [
  { pane: "sidebar", title: "Session sidebar", hint: "Session list and sub chats", fields: ["fontFamily", "fontSize", "lineHeight", "indent", "background"] },
  { pane: "chat", title: "Chat", hint: "Messages, tool calls and the prompt", fields: ["fontFamily", "fontSize", "lineHeight", "background"] },
  { pane: "changelist", title: "Changelist", hint: "Changed files and shelves", fields: ["fontFamily", "fontSize", "lineHeight", "indent", "background"] },
  { pane: "diff", title: "Diff pane", hint: "Diff viewer and inline diffs in the chat", fields: ["fontFamily", "fontSize", "lineHeight", "background"] },
];

/**
 * The pages that are not a pane: what Hunt asks the agent for on its own, how sessions are deleted, where the
 * guardrails window keeps its files, and which icon a file gets.
 */
const AGENT_PAGE = "agent";
const SESSIONS_PAGE = "sessions";
const GUARDRAILS_PAGE = "guardrails";
const FILE_ICONS_PAGE = "fileIcons";
type Page = PaneKey | typeof AGENT_PAGE | typeof SESSIONS_PAGE | typeof GUARDRAILS_PAGE | typeof FILE_ICONS_PAGE;

/** The navigation sidebar: small group headings, one entry per page. */
const NAV_GROUPS: { title: string; pages: { key: Page; title: string }[] }[] = [
  {
    title: "General",
    pages: [
      { key: AGENT_PAGE, title: "Agent" },
      { key: SESSIONS_PAGE, title: "Sessions" },
      { key: GUARDRAILS_PAGE, title: "Guardrails" },
      { key: FILE_ICONS_PAGE, title: "File icons" },
    ],
  },
  { title: "Panes", pages: SECTIONS.map((section) => ({ key: section.pane, title: section.title })) },
];

/** One folder field per folder-based guardrail kind, in the order of the guardrails window's tabs. */
const GUARDRAIL_DIR_FIELDS: { kind: GuardrailDirKind; label: string; hint: string }[] = [
  { kind: "rule", label: "Rules folder", hint: "Claude Code loads rules from .claude/rules; files elsewhere are not read on their own." },
  { kind: "skill", label: "Skills folder", hint: "Claude Code loads skills from .claude/skills/<name>/SKILL.md; files elsewhere are not read on their own." },
  { kind: "agent", label: "Agents folder", hint: "Claude Code loads subagents from .claude/agents/*.md; files elsewhere are not read on their own." },
  { kind: "adr", label: "ADR folder", hint: "Architectural decision records, numbered NNNN-title.md." },
];

const FIELD_LABELS: Record<keyof PaneSettings, { label: string; unit: string }> = {
  fontSize: { label: "Font size", unit: "px" },
  lineHeight: { label: "Line height", unit: "×" },
  indent: { label: "Indent", unit: "px" },
  background: { label: "Background", unit: "" },
  fontFamily: { label: "Font family", unit: "" },
};

/**
 * The settings as a window of their own (see openSettingsWindow.ts), opened from the sidebar's gear button or ⌘,. It
 * boots hidden and shows once rendered; the traffic light, Escape, ⌘W and "Done" close it. Every window keeps its own
 * copy of the settings store, so changes made here reach the others through `useSettingsSync`.
 */
export function SettingsWindow() {
  const resetPanes = useSettingsStore((state) => state.resetPanes);
  const setAiLanguage = useSettingsStore((state) => state.setAiLanguage);
  const resetGuardrailDirs = useSettingsStore((state) => state.resetGuardrailDirs);
  const resetIconRules = useSettingsStore((state) => state.resetIconRules);
  const setConfirmSessionDelete = useSettingsStore((state) => state.setConfirmSessionDelete);
  const [activePage, setActivePage] = useState<Page>(NAV_GROUPS[0].pages[0].key);
  const activeSection = SECTIONS.find((section) => section.pane === activePage);
  const resetAll = () => {
    resetPanes();
    setAiLanguage(DEFAULT_AI_LANGUAGE);
    resetGuardrailDirs();
    resetIconRules();
    setConfirmSessionDelete(true);
  };

  useSettingsSync();
  useSecondaryWindow("settings", closeWindow);

  return (
    <div className="flex h-full flex-col bg-(--surface-chat)">
      {/* The macOS traffic lights sit in this row (see openSettingsWindow.ts), so it starts further right and drags the window. */}
      <div data-tauri-drag-region="" className={`${HEADER_BAR} border-b border-(--line) pr-3 pl-23 text-sm`}>
        <span data-tauri-drag-region="" className="font-semibold tracking-wide text-neutral-300">Settings</span>
      </div>
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Settings pages" className="flex w-48 shrink-0 flex-col gap-4 overflow-y-auto border-r border-(--line) bg-(--surface-inset) p-3">
          {NAV_GROUPS.map((group) => (
            <div key={group.title} className="flex flex-col gap-0.5">
              <h3 className="px-2 pb-1 text-[12px] font-medium tracking-wide text-neutral-500 uppercase">{group.title}</h3>
              {group.pages.map((page) => (
                <NavItem key={page.key} title={page.title} active={page.key === activePage} onSelect={() => setActivePage(page.key)} />
              ))}
            </div>
          ))}
        </nav>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {activeSection ? (
            <PaneSection key={activeSection.pane} {...activeSection} />
          ) : activePage === SESSIONS_PAGE ? (
            <SessionsSection />
          ) : activePage === GUARDRAILS_PAGE ? (
            <GuardrailsSection />
          ) : activePage === FILE_ICONS_PAGE ? (
            <FileIconsSection />
          ) : (
            <AgentSection />
          )}
        </div>
      </div>

      <div className="flex justify-between border-t border-(--line) px-4 py-3">
        <button type="button" onClick={resetAll} className={GHOST_BUTTON}>
          Reset all to defaults
        </button>
        <button type="button" onClick={() => void closeWindow()} className={PRIMARY_BUTTON}>
          Done
        </button>
      </div>
    </div>
  );
}

/** Closes the window; a focused text field commits its value first (they save on blur). */
async function closeWindow(): Promise<void> {
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
  await getCurrentWindow().destroy();
}

/** A sidebar entry selecting one settings page. */
function NavItem({ title, active, onSelect }: { title: string; active: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={onSelect}
      className={`truncate rounded-md px-2 py-1.5 text-left text-sm ${
        active ? "bg-(--row-active) text-neutral-100" : "text-neutral-400 hover:bg-(--row-hover) hover:text-neutral-200"
      }`}
    >
      {title}
    </button>
  );
}

function isPaneDefault(pane: PaneKey, settings: PaneSettings): boolean {
  const fields = SECTIONS.find((section) => section.pane === pane)?.fields ?? [];
  return fields.every((field) => settings[field] === DEFAULT_PANES[pane][field]);
}

function isGuardrailDirsDefault(dirs: GuardrailDirs): boolean {
  return GUARDRAIL_DIR_FIELDS.every(({ kind }) => dirs[kind] === DEFAULT_GUARDRAIL_DIRS[kind]);
}

/** Page heading with the hint below and a reset button once a value differs from the defaults. */
function PageHeader({ title, hint, isDefault, onReset }: { title: string; hint: string; isDefault: boolean; onReset: () => void }) {
  return (
    <div className="mb-4 flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <h3 className="text-base font-semibold text-neutral-100">{title}</h3>
        <p className="mt-0.5 text-[13px] text-neutral-500">{hint}</p>
      </div>
      {isDefault ? null : (
        <button type="button" onClick={onReset} className={`${BUTTON_SM} shrink-0 text-neutral-500 hover:bg-(--row-hover) hover:text-neutral-200`}>
          Reset
        </button>
      )}
    </div>
  );
}

function PaneSection({ pane, title, hint, fields }: Section) {
  const settings = useSettingsStore((state) => state.panes[pane]);
  const resetPane = useSettingsStore((state) => state.resetPane);

  return (
    <section>
      <PageHeader title={title} hint={hint} isDefault={isPaneDefault(pane, settings)} onReset={() => resetPane(pane)} />
      <div className="flex flex-col gap-2">
        {fields.map((field) => {
          if (field === "background") return <ColorRow key={field} pane={pane} />;
          if (field === "fontFamily") return <FontFamilyRow key={field} pane={pane} />;
          return <NumberRow key={field} pane={pane} field={field} />;
        })}
      </div>
    </section>
  );
}

/** Settings for what Hunt asks the agent on its own, without a prompt from the user. */
function AgentSection() {
  const aiLanguage = useSettingsStore((state) => state.aiLanguage);
  const setAiLanguage = useSettingsStore((state) => state.setAiLanguage);
  const isDefault = aiLanguage === DEFAULT_AI_LANGUAGE;

  return (
    <section>
      <PageHeader title="Agent" hint="Output Hunt requests itself, without a prompt from you" isDefault={isDefault} onReset={() => setAiLanguage(DEFAULT_AI_LANGUAGE)} />
      <div className="flex flex-col gap-2">
        <TextRow
          label="Language"
          ariaLabel="Language of the agent output Hunt requests itself"
          value={aiLanguage}
          onChange={setAiLanguage}
          presets={AI_LANGUAGE_PRESETS.map((language) => ({ value: language }))}
        />
        <p className="text-[13px] leading-snug text-neutral-500">Applies to the labels and descriptions of the architecture diagram and to session summaries and titles. Your own prompts are answered in the language you write in.</p>
      </div>
    </section>
  );
}

/** How the session sidebar deletes sessions; the delete dialog's "Don't ask again" lands here. */
function SessionsSection() {
  const confirmSessionDelete = useSettingsStore((state) => state.confirmSessionDelete);
  const setConfirmSessionDelete = useSettingsStore((state) => state.setConfirmSessionDelete);

  return (
    <section>
      <PageHeader title="Sessions" hint="Session sidebar behavior" isDefault={confirmSessionDelete} onReset={() => setConfirmSessionDelete(true)} />
      <div className="flex flex-col gap-2">
        <label className="flex items-center gap-2 text-sm text-neutral-100">
          <input type="checkbox" checked={confirmSessionDelete} onChange={(event) => setConfirmSessionDelete(event.target.checked)} className="hunt-checkbox" />
          Ask before deleting a session
        </label>
        <p className="text-[13px] leading-snug text-neutral-500">Deleting a session also removes its sub sessions and its worktree. Without the question, the delete button and ⌘W act at once.</p>
      </div>
    </section>
  );
}

/** Where the guardrails window reads and writes rules, skills and ADRs, as folders relative to the session's worktree. */
function GuardrailsSection() {
  const dirs = useSettingsStore((state) => state.guardrailDirs);
  const setGuardrailDir = useSettingsStore((state) => state.setGuardrailDir);
  const resetGuardrailDirs = useSettingsStore((state) => state.resetGuardrailDirs);

  return (
    <section>
      <PageHeader title="Guardrails" hint="Folders of the guardrails window, relative to the repository root" isDefault={isGuardrailDirsDefault(dirs)} onReset={resetGuardrailDirs} />
      <div className="flex flex-col gap-4">
        {GUARDRAIL_DIR_FIELDS.map(({ kind, label, hint }) => (
          <div key={kind} className="flex flex-col gap-1">
            <TextRow label={label} value={dirs[kind]} onChange={(dir) => setGuardrailDir(kind, dir)} isMonospace />
            <p className="text-[13px] leading-snug text-neutral-500">{hint}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Example path the preview starts with; it hits the default NestJS service rule. */
const PREVIEW_PATH_EXAMPLE = "apps/api/src/user/user.service.ts";

/** Which icon a file gets: an ordered list of glob rules over the worktree-relative path, with a live preview. */
function FileIconsSection() {
  const rules = useSettingsStore((state) => state.iconRules);
  const setIconRules = useSettingsStore((state) => state.setIconRules);
  const resetIconRules = useSettingsStore((state) => state.resetIconRules);
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const isShown = (rule: IconRule) => !needle || rule.glob.toLowerCase().includes(needle) || rule.icon.toLowerCase().includes(needle);

  // Edits start from the store's current rules, not the rendered ones: two fields of a row may commit before a re-render.
  const current = () => useSettingsStore.getState().iconRules;
  const update = (index: number, patch: Partial<IconRule>) => setIconRules(current().map((rule, position) => (position === index ? { ...rule, ...patch } : rule)));
  const remove = (index: number) => setIconRules(current().filter((_, position) => position !== index));
  const move = (index: number, offset: -1 | 1) => {
    const next = [...current()];
    const [rule] = next.splice(index, 1);
    next.splice(index + offset, 0, rule);
    setIconRules(next);
  };

  return (
    <section>
      <PageHeader title="File icons" hint="Which icon a file gets, by glob over its path relative to the repository root" isDefault={isIconRulesDefault(rules)} onReset={resetIconRules} />
      <div className="flex flex-col gap-4">
        <p className="text-[13px] leading-snug text-neutral-500">
          Rules are tried top to bottom; the first whose glob matches wins, otherwise the file name decides. A glob without a slash matches the file name in any folder, <code>**</code> spans folders and{" "}
          <code>{"{a,b}"}</code> lists alternatives.
        </p>
        <input
          type="text"
          value={filter}
          spellCheck={false}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={`Filter ${rules.length} rules by glob or icon`}
          aria-label="Filter rules"
          className="w-full rounded border border-neutral-600 bg-(--surface-inset) px-2 py-1 text-sm text-neutral-200 outline-none placeholder:text-neutral-600 focus:border-neutral-400"
        />
        <ul className="flex flex-col gap-1.5">
          {rules.map((rule, index) =>
            // Rows are positional: a rule has no identity of its own, and keying by index keeps the drafts with their row while typing.
            isShown(rule) ? (
              <IconRuleRow
                key={index}
                rule={rule}
                onChange={(patch) => update(index, patch)}
                onRemove={() => remove(index)}
                onMoveUp={index > 0 ? () => move(index, -1) : undefined}
                onMoveDown={index < rules.length - 1 ? () => move(index, 1) : undefined}
              />
            ) : null,
          )}
        </ul>
        <div>
          <button type="button" onClick={() => setIconRules([...current(), { glob: "", icon: "" }])} className={SECONDARY_BUTTON_SM}>
            <PlusIcon />
            Add rule
          </button>
        </div>
        <IconPreviewRow rules={rules} />
      </div>
    </section>
  );
}

/** One rule: its glob, the icon picker and the buttons that order and delete it. */
function IconRuleRow({
  rule,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
}: {
  rule: IconRule;
  onChange: (patch: Partial<IconRule>) => void;
  onRemove: () => void;
  onMoveUp: (() => void) | undefined;
  onMoveDown: (() => void) | undefined;
}) {
  return (
    <li className="flex items-center gap-2">
      <DraftInput value={rule.glob} onCommit={(glob) => onChange({ glob })} placeholder="Glob, e.g. apps/api/**" ariaLabel="Glob" title={rule.glob} className="min-w-0 flex-1" />
      <IconPicker value={rule.icon} onChange={(icon) => onChange({ icon })} className="w-52" />
      <button type="button" onClick={onMoveUp} disabled={!onMoveUp} className={ICON_BUTTON_SM} aria-label="Move rule up">
        <ArrowIcon direction="up" />
      </button>
      <button type="button" onClick={onMoveDown} disabled={!onMoveDown} className={ICON_BUTTON_SM} aria-label="Move rule down">
        <ArrowIcon direction="down" />
      </button>
      <button type="button" onClick={onRemove} className={`${ICON_BUTTON_SM} hover:text-red-300`} aria-label="Delete rule">
        <TrashIcon />
      </button>
    </li>
  );
}

/** Shows which icon a path of the user's choosing gets under the current rules, as they type. */
function IconPreviewRow({ rules }: { rules: IconRule[] }) {
  const fileIconUrl = useFileIconUrl();
  const [path, setPath] = useState(PREVIEW_PATH_EXAMPLE);
  const trimmed = path.trim();

  return (
    <div className="flex items-center gap-3 border-t border-(--line) pt-4">
      <div className="min-w-0 flex-1 text-sm text-neutral-100">Preview</div>
      <input
        type="text"
        value={path}
        spellCheck={false}
        onChange={(event) => setPath(event.target.value)}
        placeholder="Path to try, e.g. apps/api/src/main.ts"
        className="w-72 truncate rounded border border-neutral-600 bg-(--surface-inset) px-2 py-1 font-mono text-sm text-neutral-200 outline-none focus:border-neutral-400"
        aria-label="Path to preview the icon of"
      />
      <div className="flex w-40 items-center gap-2 text-[13px] text-neutral-400">
        {trimmed ? <img src={fileIconUrl(trimmed)} alt="" className="size-4 shrink-0" /> : <span className="size-4 shrink-0" />}
        <span className="truncate font-mono">{trimmed ? resolveFileIcon(trimmed, rules) : ""}</span>
      </div>
    </div>
  );
}

/** Free text that commits when the field is left; a store change from outside (reset, reorder) replaces the draft. */
function DraftInput({
  value,
  onCommit,
  placeholder,
  ariaLabel,
  title,
  className = "",
}: {
  value: string;
  onCommit: (value: string) => void;
  placeholder: string;
  ariaLabel: string;
  title?: string;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);

  useEffect(() => setDraft(value), [value]);

  return (
    <input
      type="text"
      value={draft}
      spellCheck={false}
      placeholder={placeholder}
      title={title}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft.trim() !== value) {
          onCommit(draft);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        }
      }}
      className={`truncate rounded border border-neutral-600 bg-(--surface-inset) px-2 py-1 font-mono text-sm text-neutral-200 outline-none placeholder:font-sans placeholder:text-neutral-600 focus:border-neutral-400 ${className}`}
      aria-label={ariaLabel}
    />
  );
}

function ArrowIcon({ direction }: { direction: "up" | "down" }) {
  return (
    <svg viewBox="0 0 16 16" className={`size-3.5 ${direction === "down" ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
    </svg>
  );
}

/**
 * Row with a free-text field that commits when it is left (Enter leaves it). The store decides what to keep, so the
 * field shows the stored value afterwards: a rejected value (empty, or an absolute or `..` path for a folder) snaps
 * back, a normalized one (trimmed, `./` stripped) takes its stored form. A store change from outside (reset, preset)
 * replaces the draft. `presets` fill a datalist of suggestions.
 */
function TextRow({
  label,
  ariaLabel = label,
  value,
  onChange,
  presets,
  isMonospace = false,
  inputStyle,
}: {
  label: string;
  ariaLabel?: string;
  value: string;
  onChange: (value: string) => void;
  presets?: { label?: string; value: string }[];
  isMonospace?: boolean;
  inputStyle?: CSSProperties;
}) {
  const [draft, setDraft] = useState(value);
  const listId = useId();

  useEffect(() => setDraft(value), [value]);

  // Leaving the field unchanged stores nothing (a store write reaches every window).
  const commit = () => {
    if (draft.trim() !== value) {
      onChange(draft);
    }
    setDraft(value);
  };

  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1 text-sm text-neutral-100">{label}</div>
      <input
        type="text"
        list={presets ? listId : undefined}
        value={draft}
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.currentTarget.blur();
          }
        }}
        style={inputStyle}
        className={`w-56 truncate rounded border border-neutral-600 bg-(--surface-inset) px-2 py-1 text-sm text-neutral-200 outline-none focus:border-neutral-400 ${isMonospace ? "font-mono" : ""}`}
        aria-label={ariaLabel}
      />
      {presets ? (
        <datalist id={listId}>
          {presets.map((preset) => (
            <option key={preset.value} value={preset.value}>
              {preset.label}
            </option>
          ))}
        </datalist>
      ) : null}
      {/* Keeps the field aligned with the unit column of NumberRow. */}
      <span className="w-6" />
    </div>
  );
}

function NumberRow({ pane, field }: { pane: PaneKey; field: NumericPaneSetting }) {
  const value = useSettingsStore((state) => state.panes[pane][field]);
  const setPaneSetting = useSettingsStore((state) => state.setPaneSetting);
  const range = PANE_RANGES[field];
  const { label, unit } = FIELD_LABELS[field];
  const isDefault = value === DEFAULT_PANES[pane][field];
  const decimals = range.step < 1 ? 1 : 0;

  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1 text-sm text-neutral-100">{label}</div>
      <div className="flex items-center rounded border border-neutral-600 bg-(--surface-inset)">
        <StepButton label="−" onClick={() => setPaneSetting(pane, field, value - range.step)} disabled={value <= range.min} />
        <input
          type="number"
          min={range.min}
          max={range.max}
          step={range.step}
          value={value.toFixed(decimals)}
          onChange={(event) => setPaneSetting(pane, field, Number(event.target.value))}
          className="w-14 bg-transparent py-1 text-center text-sm tabular-nums outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
        />
        <StepButton label="+" onClick={() => setPaneSetting(pane, field, value + range.step)} disabled={value >= range.max} />
      </div>
      <span className={`w-6 text-right text-[13px] ${isDefault ? "text-neutral-600" : "text-neutral-400"}`}>{unit}</span>
    </div>
  );
}

function ColorRow({ pane }: { pane: PaneKey }) {
  const value = useSettingsStore((state) => state.panes[pane].background);
  const setPaneSetting = useSettingsStore((state) => state.setPaneSetting);
  const isDefault = value === DEFAULT_PANES[pane].background;

  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1 text-sm text-neutral-100">{FIELD_LABELS.background.label}</div>
      <label className="flex items-center gap-2 rounded border border-neutral-600 bg-(--surface-inset) px-2 py-1">
        <input
          type="color"
          value={value}
          onChange={(event) => setPaneSetting(pane, "background", event.target.value)}
          className="size-5 cursor-pointer rounded border border-neutral-600 bg-transparent p-0 [&::-webkit-color-swatch]:rounded [&::-webkit-color-swatch]:border-none [&::-webkit-color-swatch-wrapper]:p-0"
          aria-label="Pick background color"
        />
        <span className="w-16 font-mono text-sm tabular-nums text-neutral-300">{value}</span>
      </label>
      <span className={`w-6 text-right text-[13px] ${isDefault ? "text-neutral-600" : "text-neutral-400"}`} />
    </div>
  );
}

/** Font stack of a pane, suggested from `FONT_FAMILY_PRESETS` and previewed in the field itself. */
function FontFamilyRow({ pane }: { pane: PaneKey }) {
  const value = useSettingsStore((state) => state.panes[pane].fontFamily);
  const setPaneSetting = useSettingsStore((state) => state.setPaneSetting);
  return (
    <TextRow
      label={FIELD_LABELS.fontFamily.label}
      ariaLabel="Font family"
      value={value}
      onChange={(family) => setPaneSetting(pane, "fontFamily", family)}
      presets={FONT_FAMILY_PRESETS}
      inputStyle={{ fontFamily: value }}
    />
  );
}

function StepButton({ label, onClick, disabled }: { label: string; onClick: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-7 w-7 items-center justify-center text-sm text-neutral-300 transition-colors hover:bg-(--row-hover) hover:text-white disabled:pointer-events-none disabled:opacity-30"
    >
      {label}
    </button>
  );
}
