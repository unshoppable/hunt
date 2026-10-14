import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAccountsSync, useSettingsSync } from "../app/bootstrap";
import { commands } from "../ipc/commands";
import type { GithubTokenStatus } from "../ipc/types";
import { listenTo } from "../ipc/events";
import { appVersion, checkForUpdate, installUpdate, relaunchApp, type Update } from "../ipc/updater";
import { FOLDER_ICON_NAMES, resolveFileIcon, resolveFolderIcon, useFileIconUrl, useFolderIconUrl } from "../diff/fileIcons";
import {
  AI_LANGUAGE_PRESETS,
  DEFAULT_AI_LANGUAGE,
  DEFAULT_GRAPH_AGENT,
  DEFAULT_GUARDRAIL_DIRS,
  DEFAULT_PANES,
  DEFAULT_REMOTE,
  DEFAULT_SYSTEM_PROMPT,
  FONT_FAMILY_PRESETS,
  PANE_RANGES,
  isFolderIconRulesDefault,
  isIconRulesDefault,
  useSettingsStore,
  type GuardrailDirs,
  type GuardrailDirKind,
  type FolderIconRule,
  type IconRule,
  type NumericPaneSetting,
  type PaneKey,
  type PaneSettings,
} from "../state/settings";
import { findSelectOption, listChoices } from "../chat/configOptions";
import { LOCAL_LOGIN, accountOptions, useAccountsStore } from "../state/accounts";
import { useAgentDefaultsStore } from "../state/agentDefaults";
import { HEADER_BAR } from "../ui/bars";
import { BUTTON_XS, GHOST_BUTTON_MD, ICON_BUTTON_SM, PRIMARY_BUTTON_MD, PRIMARY_BUTTON_XS, SECONDARY_BUTTON_XS } from "../ui/buttons";
import { confirmDestructive } from "../ui/confirm";
import { Dropdown, OptionMenu, optionId } from "../ui/Dropdown";
import { filterOptions, stepEnabled, type DropdownOption } from "../ui/floatingMenu";
import { PlusIcon, Spinner, TrashIcon } from "../ui/icons";
import { useSecondaryWindow } from "../ui/nativeWindow";
import { errorText, useLoad } from "../ui/useLoad";
import { IconPicker } from "./IconPicker";
import { type SettingsPage } from "./openSettingsWindow";
import { NO_PROGRESS, applyDownloadEvent, describeProgress, downloadFraction, type DownloadProgress } from "./updateProgress";
import { SESSION_MACHINE_TYPES } from "../../../../libs/domain/src/sessionMachineTypes.ts";

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
 * guardrails window keeps its files, which icon a file or folder gets, and whether a newer Hunt exists.
 */
const AGENT_PAGE = "agent";
const SESSIONS_PAGE = "sessions";
const REMOTE_PAGE = "remote";
const GUARDRAILS_PAGE = "guardrails";
const FILE_ICONS_PAGE = "fileIcons";
const FOLDER_ICONS_PAGE = "folderIcons";
const UPDATES_PAGE: SettingsPage = "updates";
type Page = PaneKey | typeof AGENT_PAGE | typeof SESSIONS_PAGE | typeof REMOTE_PAGE | typeof GUARDRAILS_PAGE | typeof FILE_ICONS_PAGE | typeof FOLDER_ICONS_PAGE | SettingsPage;

/** Whether the window was booted ahead of time (`?warm=1`) and stays hidden until the main window shows it. */
const isWarm = new URLSearchParams(window.location.search).has("warm");

/** The page another window asked for in the URL hash (see openSettingsWindow.ts), else the first one. */
function initialPage(): Page {
  return window.location.hash === `#${UPDATES_PAGE}` ? UPDATES_PAGE : NAV_GROUPS[0].pages[0].key;
}

/** The navigation sidebar: small group headings, one entry per page. */
const NAV_GROUPS: { title: string; pages: { key: Page; title: string }[] }[] = [
  {
    title: "General",
    pages: [
      { key: AGENT_PAGE, title: "Agent" },
      { key: SESSIONS_PAGE, title: "Sessions" },
      { key: REMOTE_PAGE, title: "Remote VM" },
      { key: GUARDRAILS_PAGE, title: "Guardrails" },
      { key: FILE_ICONS_PAGE, title: "File icons" },
      { key: FOLDER_ICONS_PAGE, title: "Folder icons" },
      { key: UPDATES_PAGE, title: "Updates" },
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
 * boots hidden, usually ahead of time, and shows once rendered or, when booted ahead, once the main window shows it; the
 * traffic light, Escape, ⌘W and "Done" only hide it so the next open is instant. Every window keeps its own
 * copy of the settings store, so changes made here reach the others through `useSettingsSync`.
 */
export function SettingsWindow() {
  const resetPanes = useSettingsStore((state) => state.resetPanes);
  const setAiLanguage = useSettingsStore((state) => state.setAiLanguage);
  const resetGuardrailDirs = useSettingsStore((state) => state.resetGuardrailDirs);
  const resetIconRules = useSettingsStore((state) => state.resetIconRules);
  const resetFolderIconRules = useSettingsStore((state) => state.resetFolderIconRules);
  const setConfirmSessionDelete = useSettingsStore((state) => state.setConfirmSessionDelete);
  const [activePage, setActivePage] = useState<Page>(initialPage);
  const [version, setVersion] = useState<string | null>(null);
  const activeSection = SECTIONS.find((section) => section.pane === activePage);
  const resetAll = () => {
    resetPanes();
    setAiLanguage(DEFAULT_AI_LANGUAGE);
    resetGuardrailDirs();
    resetIconRules();
    resetFolderIconRules();
    setConfirmSessionDelete(true);
  };

  useSettingsSync();
  useAccountsSync();
  useSecondaryWindow("settings", closeWindow, { isReady: !isWarm });
  useLoad(appVersion, { onValue: setVersion, onError: () => setVersion(null) }, []);

  useEffect(() => {
    const subscription = listenTo("settings:show-page", ({ page }) => setActivePage(page), { target: getCurrentWindow().label });
    return () => void subscription.then((unlisten) => unlisten());
  }, []);

  return (
    <div className="flex h-full flex-col bg-(--surface-chat)">
      {/* The macOS traffic lights sit in this row (see openSettingsWindow.ts), so it starts further right and drags the window. */}
      <div data-tauri-drag-region="" className={`${HEADER_BAR} gap-2 border-b border-(--line) pr-3 pl-23 text-sm`}>
        <span data-tauri-drag-region="" className="font-semibold tracking-wide text-neutral-300">Settings</span>
        {version ? (
          <span data-tauri-drag-region="" className="text-[12px] text-neutral-500 tabular-nums">
            {`v${version}`}
          </span>
        ) : null}
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
          ) : activePage === REMOTE_PAGE ? (
            <RemoteSection />
          ) : activePage === GUARDRAILS_PAGE ? (
            <GuardrailsSection />
          ) : activePage === FILE_ICONS_PAGE ? (
            <FileIconsSection />
          ) : activePage === FOLDER_ICONS_PAGE ? (
            <FolderIconsSection />
          ) : activePage === UPDATES_PAGE ? (
            <UpdatesSection />
          ) : (
            <AgentSection />
          )}
        </div>
      </div>

      <div className="flex justify-between border-t border-(--line) px-4 py-3">
        <button type="button" onClick={resetAll} className={GHOST_BUTTON_MD}>
          Reset all to defaults
        </button>
        <button type="button" onClick={() => void closeWindow()} className={PRIMARY_BUTTON_MD}>
          Done
        </button>
      </div>
    </div>
  );
}

/** Hides the window; a focused text field commits its value first (they save on blur). */
async function closeWindow(): Promise<void> {
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
  await getCurrentWindow().hide();
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
        <button type="button" onClick={onReset} className={`${BUTTON_XS} shrink-0 text-neutral-500 hover:bg-(--row-hover) hover:text-neutral-200`}>
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

/**
 * Settings for the agent: the Claude account it runs on, the language of Hunt's own requests, the system prompt
 * addition and the model and effort of the diagram turns.
 */
function AgentSection() {
  const aiLanguage = useSettingsStore((state) => state.aiLanguage);
  const setAiLanguage = useSettingsStore((state) => state.setAiLanguage);
  const systemPrompt = useSettingsStore((state) => state.systemPrompt);
  const setSystemPrompt = useSettingsStore((state) => state.setSystemPrompt);
  const graphAgent = useSettingsStore((state) => state.graphAgent);
  const setGraphAgent = useSettingsStore((state) => state.setGraphAgent);
  const knownOptions = useAgentDefaultsStore((state) => state.knownOptions);
  const isDefault =
    aiLanguage === DEFAULT_AI_LANGUAGE &&
    systemPrompt === DEFAULT_SYSTEM_PROMPT &&
    graphAgent.model === DEFAULT_GRAPH_AGENT.model &&
    graphAgent.effort === DEFAULT_GRAPH_AGENT.effort;
  const reset = () => {
    setAiLanguage(DEFAULT_AI_LANGUAGE);
    setSystemPrompt(DEFAULT_SYSTEM_PROMPT);
    setGraphAgent("model", DEFAULT_GRAPH_AGENT.model);
    setGraphAgent("effort", DEFAULT_GRAPH_AGENT.effort);
  };
  // The choices the agent offered last; the default model ID is not among them, since the agent lists it by alias.
  const choicesOf = (configId: string) => {
    const option = findSelectOption(knownOptions, configId);
    const choices = option ? listChoices(option).filter((choice) => choice.value !== "default") : [];
    return choices.map((choice) => ({ value: choice.value, label: choice.name }));
  };
  const modelPresets = [{ value: DEFAULT_GRAPH_AGENT.model }, ...choicesOf("model").filter((choice) => choice.value !== DEFAULT_GRAPH_AGENT.model)];

  return (
    <section>
      <PageHeader title="Agent" hint="Which account the agent runs on and what Hunt tells it on its own, without a prompt from you" isDefault={isDefault} onReset={reset} />
      <AccountRow />
      <div className="mt-5 flex flex-col gap-2">
        <TextRow
          label="Language"
          ariaLabel="Language of the agent output Hunt requests itself"
          value={aiLanguage}
          onChange={setAiLanguage}
          presets={AI_LANGUAGE_PRESETS.map((language) => ({ value: language }))}
        />
        <p className="text-[13px] leading-snug text-neutral-500">Applies to the labels and descriptions of the architecture diagram and to session summaries and titles. Your own prompts are answered in the language you write in.</p>
      </div>
      <div className="mt-5 flex flex-col gap-2">
        <div className="text-sm text-neutral-100">System prompt</div>
        <TextArea ariaLabel="System prompt addition for every agent session" value={systemPrompt} onChange={setSystemPrompt} />
        <p className="text-[13px] leading-snug text-neutral-500">Appended to Claude Code's own system prompt in every session started from now on, after the instructions of your CLAUDE.md files. Leave it empty to add nothing.</p>
      </div>
      <div className="mt-5 flex flex-col gap-2">
        <TextRow
          label="Diagram model"
          ariaLabel="Model the agent writes the architecture diagram with"
          value={graphAgent.model}
          onChange={(value) => setGraphAgent("model", value)}
          presets={modelPresets}
          isMonospace
        />
        <TextRow
          label="Diagram effort"
          ariaLabel="Effort the agent writes the architecture diagram with"
          value={graphAgent.effort}
          onChange={(value) => setGraphAgent("effort", value)}
          presets={choicesOf("effort")}
          isMonospace
        />
        <p className="text-[13px] leading-snug text-neutral-500">The session's agent switches to this model and effort while it updates the architecture diagram and goes back to the chat's choice afterwards. A model option such as <code>opus</code> follows Claude Code to newer versions; a full model ID such as <code>claude-opus-5-5</code> stays on that version.</p>
      </div>
    </section>
  );
}

const FORM_INPUT = "w-56 rounded border border-neutral-600 bg-(--surface-input) px-2 py-1 text-sm text-neutral-200 outline-none placeholder:text-neutral-600 focus:border-neutral-400";

/**
 * The Claude account every Claude Code process Hunt starts uses: the local login or an OAuth token per email. "+" asks
 * for an email; Hunt runs `claude setup-token`, opens its sign-in in a private browser window with the email filled in
 * and makes the new token the active account. The trash button removes the selected token account. The backend owns the list (see accounts.rs), so it is
 * not part of the settings store and "Reset" leaves it alone.
 */
function AccountRow() {
  const accounts = useAccountsStore((state) => state.accounts);
  const error = useAccountsStore((state) => state.error);
  const apply = useAccountsStore((state) => state.apply);
  const select = useAccountsStore((state) => state.select);
  const clearError = useAccountsStore((state) => state.clearError);
  const [isAdding, setIsAdding] = useState(false);
  const [email, setEmail] = useState("");
  const [isSigningIn, setIsSigningIn] = useState(false);
  const isCancellingRef = useRef(false);
  const active = accounts?.accounts.find((account) => account.id === accounts.activeId) ?? null;
  const options = accountOptions(accounts);

  function closeForm() {
    setIsAdding(false);
    setEmail("");
  }

  async function signIn() {
    if (!email.trim() || isSigningIn) return;
    isCancellingRef.current = false;
    setIsSigningIn(true);
    const isAdded = await apply(commands.signInAccount(email));
    setIsSigningIn(false);
    if (isCancellingRef.current) {
      clearError();
    }
    if (!isAdded) return;
    closeForm();
  }

  /** Stops a running sign-in and keeps the form open; otherwise closes the form. */
  function cancel() {
    if (!isSigningIn) {
      closeForm();
      return;
    }
    isCancellingRef.current = true;
    void apply(commands.cancelSignIn().then(commands.listAccounts));
  }

  async function remove() {
    if (!active) return;
    if (!(await confirmDestructive(`Remove the Claude account ${active.email} and delete its token from the keychain? Hunt uses the local login afterwards.`, "Remove"))) return;
    await apply(commands.removeAccount(active.id));
  }

  function onFormKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      void signIn();
    } else if (event.key === "Escape") {
      event.stopPropagation();
      cancel();
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1 text-sm text-neutral-100">Claude account</div>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => setIsAdding(true)} className={ICON_BUTTON_SM} aria-label="Add a Claude account" title="Add a Claude account">
            <PlusIcon />
          </button>
          <button type="button" onClick={() => void remove()} disabled={!active} className={`${ICON_BUTTON_SM} hover:text-red-300`} aria-label="Remove the selected Claude account" title="Remove the selected Claude account">
            <TrashIcon />
          </button>
        </div>
        <Dropdown
          title="Claude account of every Claude Code process Hunt starts"
          value={accounts?.activeId ?? LOCAL_LOGIN}
          options={options}
          onChange={(id) => void select(id)}
          disabled={!accounts}
          className={`${FORM_INPUT} flex items-center justify-between gap-1.5 text-left`}
        />
        {/* Keeps the field aligned with the unit column of NumberRow. */}
        <span className="w-6" />
      </div>
      {isAdding ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <label htmlFor="account-email" className="min-w-0 flex-1 pl-4 text-sm text-neutral-400">
              Email
            </label>
            <input id="account-email" type="email" value={email} spellCheck={false} autoFocus placeholder="name@example.com" disabled={isSigningIn} onChange={(event) => setEmail(event.target.value)} onKeyDown={onFormKeyDown} className={FORM_INPUT} />
            <span className="w-6" />
          </div>
          {/* Right edge in line with the fields above, which keep the unit column free. */}
          <div className="flex items-center justify-end gap-2 pr-9">
            {isSigningIn ? (
              <span className="flex min-w-0 items-center gap-2 text-[13px] text-neutral-400">
                <Spinner />
                Waiting for the sign-in in your browser…
              </span>
            ) : null}
            <button type="button" onClick={cancel} className={SECONDARY_BUTTON_XS}>
              Cancel
            </button>
            <button type="button" onClick={() => void signIn()} disabled={!email.trim() || isSigningIn} className={PRIMARY_BUTTON_XS}>
              Sign in with browser
            </button>
          </div>
          <p className="pl-4 text-[13px] leading-snug text-neutral-500">
            Hunt runs <code>claude setup-token</code> and opens claude.ai in a private window of Chrome, Brave, Edge or Firefox with the email filled in. Once you signed in, the token
            goes straight into the keychain. Signing in again with the same email renews its token.
          </p>
        </div>
      ) : null}
      {error ? <p className="text-[13px] leading-snug break-words text-red-300">{error}</p> : null}
      <p className="text-[13px] leading-snug text-neutral-500">
        Every Claude Code process Hunt starts from now on uses this account: agents, session summaries and the plan usage. Agents already running keep the account they started with. Hunt keeps
        the tokens in the macOS keychain.
      </p>
    </div>
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

/** The GitHub token remote sessions push and run `gh` with; Hunt keeps it in the keychain, never in the settings. */
function GithubTokenRow() {
  const [status, setStatus] = useState<GithubTokenStatus | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  useLoad(commands.githubTokenStatus, { onValue: setStatus, onError: (reason) => setError(errorText(reason)) }, []);

  async function run(action: Promise<GithubTokenStatus>): Promise<boolean> {
    setIsSaving(true);
    try {
      setStatus(await action);
      setError(null);
      return true;
    } catch (reason) {
      setError(errorText(reason));
      return false;
    } finally {
      setIsSaving(false);
    }
  }

  async function save() {
    if (!draft.trim() || isSaving) return;
    if (!(await run(commands.setGithubToken(draft)))) return;
    setDraft("");
  }

  async function remove() {
    if (!(await confirmDestructive("Delete the GitHub token from the keychain? Remote sessions handed off from now on cannot push.", "Delete"))) return;
    await run(commands.removeGithubToken());
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void save();
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <label htmlFor="github-token" className="min-w-0 flex-1 text-sm text-neutral-100">
          GitHub token
        </label>
        <button type="button" onClick={() => void remove()} disabled={!status?.saved || isSaving} className={`${ICON_BUTTON_SM} hover:text-red-300`} aria-label="Delete the GitHub token" title="Delete the GitHub token">
          <TrashIcon />
        </button>
        <input
          id="github-token"
          type="password"
          value={draft}
          spellCheck={false}
          autoComplete="off"
          placeholder={status?.saved ? `Saved, ends in ${status.hint ?? "…"}` : "Not set"}
          disabled={isSaving}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          className={`${FORM_INPUT} font-mono`}
        />
        <span className="w-6" />
      </div>
      {draft.trim() ? (
        <div className="flex items-center justify-end gap-2 pr-9">
          <button type="button" onClick={() => setDraft("")} className={SECONDARY_BUTTON_XS}>
            Cancel
          </button>
          <button type="button" onClick={() => void save()} disabled={isSaving} className={PRIMARY_BUTTON_XS}>
            Save
          </button>
        </div>
      ) : null}
      {error ? <p className="text-[13px] leading-snug break-words text-red-300">{error}</p> : null}
      <p className="text-[13px] leading-snug text-neutral-500">
        With a token, the agent of a remote session pushes to GitHub and runs gh as you. Use a fine-grained token limited to the repositories you hand off, with Contents and
        Pull requests read and write, Actions and Commit statuses read. Everyone with root on the VM can read it. Hunt keeps it in the macOS keychain; a session gets it at its
        handoff or /clear.
      </p>
    </div>
  );
}

/** The instance template's machine type first, then every machine type the gateway accepts for new session VMs. */
const MACHINE_TYPE_OPTIONS: DropdownOption[] = [
  { id: "", name: "Template default" },
  ...SESSION_MACHINE_TYPES.map((type) => ({
    id: type.name,
    name: type.name,
    description: `${type.cores} cores · ${type.memoryGb} GB · €${type.eurPerHour.toFixed(2)} per hour`,
  })),
];

/** Where remote sessions run, how their previews are reached, and the ignored files a handoff copies along (see src-tauri/src/remote). */
function RemoteSection() {
  const remote = useSettingsStore((state) => state.remote);
  const setRemote = useSettingsStore((state) => state.setRemote);
  const isDefault = JSON.stringify(remote) === JSON.stringify(DEFAULT_REMOTE);

  return (
    <section>
      <PageHeader title="Remote VM" hint="Where a session runs once you hand it off" isDefault={isDefault} onReset={() => setRemote(DEFAULT_REMOTE)} />
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <TextRow label="Google Cloud project" value={remote.project} onChange={(project) => setRemote({ project })} isMonospace />
          <p className="text-[13px] leading-snug text-neutral-500">
            Hunt finds the gateway, the VM of this project labelled hunt-role=gateway, with your gcloud login. It runs all the time and creates, starts
            and deletes a VM of its own for each session you hand off, vm-hunt-s-&lt;id&gt;, and routes the previews of its preview domain to them:
            https://&lt;id&gt;-&lt;port&gt;.&lt;domain&gt; behind your Google login, starting a VM that is off, and https://&lt;id&gt;-&lt;port&gt;-open.&lt;domain&gt;
            without it for the services the repository's hunt.json marks public, protected only by the app's own login. Hunt reaches the gateway and the session VMs
            over SSH through an IAP tunnel. The infrastructure repository configures the gateway, the session VMs' instance template and the gateway's
            poller for GitHub issues labelled swf. The chat header offers the handoff once the project is set.
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1 text-sm text-neutral-100">Machine type</div>
            <Dropdown
              title="Machine type of the session VMs the gateway creates"
              value={remote.machineType}
              options={MACHINE_TYPE_OPTIONS}
              onChange={(machineType) => setRemote({ machineType })}
              className={`${FORM_INPUT} flex items-center justify-between gap-1.5 text-left font-mono`}
            />
            {/* Keeps the field aligned with the unit column of NumberRow. */}
            <span className="w-6" />
          </div>
          <p className="text-[13px] leading-snug text-neutral-500">
            Applies to the session VMs the gateway creates from now on; a session keeps the VM it has. The template default is the machine type of the
            infrastructure's instance template. Prices are on-demand list prices per running hour; a session VM stops itself when idle.
          </p>
        </div>
        <GithubTokenRow />
        <div className="flex flex-col gap-1">
          <div className="text-sm text-neutral-100">Ignored files to copy</div>
          <TextArea ariaLabel="Ignored files to copy" value={remote.filePatterns.join("\n")} onChange={(text) => setRemote({ filePatterns: text.split("\n") })} />
          <p className="text-[13px] leading-snug text-neutral-500">
            One glob per line, relative to the worktree, such as **/.env.private. Git leaves ignored files out of the branch; these are copied to the VM as
            they are. Changes the agent makes to them stay on the VM.
          </p>
        </div>
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

/** Example folder the folder icon preview starts with; it hits the default user interface rule. */
const PREVIEW_FOLDER_EXAMPLE = "apps/admin-ui";

/**
 * Positional edits of an ordered rule list. Each starts from the store's current rules (`current`), not the rendered
 * ones: two fields of a row may commit before a re-render.
 */
function ruleListEdits<T extends object>(current: () => T[], set: (rules: T[]) => void) {
  return {
    update: (index: number, patch: Partial<T>) => set(current().map((rule, position) => (position === index ? { ...rule, ...patch } : rule))),
    remove: (index: number) => set(current().filter((_, position) => position !== index)),
    move: (index: number, offset: -1 | 1) => {
      const next = [...current()];
      const [rule] = next.splice(index, 1);
      next.splice(index + offset, 0, rule);
      set(next);
    },
    add: (rule: T) => set([...current(), rule]),
  };
}

/** Which icon a file gets: an ordered list of glob rules over the worktree-relative path, with a live preview. */
/** What one update check and the install that may follow are at: the phases follow each other in this order. */
type UpdateState =
  | { phase: "checking" }
  | { phase: "current" }
  | { phase: "available"; update: Update }
  | { phase: "downloading"; update: Update; progress: DownloadProgress }
  | { phase: "installed"; update: Update }
  | { phase: "error"; message: string };

/**
 * The running version and whether the release feed has a newer one; checks once when the page opens. An update is
 * downloaded and installed here and takes effect when Hunt restarts, from the button or the next launch.
 */
function UpdatesSection() {
  const [version, setVersion] = useState<string | null>(null);
  const [state, setState] = useState<UpdateState>({ phase: "checking" });
  const [checkCount, setCheckCount] = useState(0);

  useLoad(appVersion, { onValue: setVersion, onError: () => setVersion(null) }, []);
  useLoad(
    checkForUpdate,
    {
      onValue: (update) => setState(update ? { phase: "available", update } : { phase: "current" }),
      onError: (reason) => setState({ phase: "error", message: errorText(reason) }),
    },
    [checkCount],
  );

  const checkAgain = () => {
    setState({ phase: "checking" });
    setCheckCount((count) => count + 1);
  };
  const install = async (update: Update) => {
    setState({ phase: "downloading", update, progress: NO_PROGRESS });
    try {
      await installUpdate(update, (event) => {
        setState((current) => (current.phase === "downloading" ? { ...current, progress: applyDownloadEvent(current.progress, event) } : current));
      });
      setState({ phase: "installed", update });
    } catch (reason) {
      setState({ phase: "error", message: errorText(reason) });
    }
  };
  const relaunch = () => void relaunchApp().catch((reason: unknown) => setState({ phase: "error", message: errorText(reason) }));

  const status =
    state.phase === "checking" ? "Checking for updates…"
    : state.phase === "current" ? "Hunt is up to date."
    : state.phase === "available" ? `Hunt ${state.update.version} is available.`
    : state.phase === "downloading" ? `Downloading Hunt ${state.update.version}…`
    : state.phase === "installed" ? `Hunt ${state.update.version} is installed and starts with the next launch.`
    : "Could not check for updates.";
  const notes = state.phase === "available" || state.phase === "downloading" || state.phase === "installed" ? state.update.body?.trim() : undefined;

  return (
    <section>
      <PageHeader title="Updates" hint={version ? `Hunt ${version}` : "Hunt"} isDefault onReset={() => undefined} />
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1 text-sm text-neutral-100">{status}</div>
          {state.phase === "available" ? (
            <button type="button" onClick={() => void install(state.update)} className={`${PRIMARY_BUTTON_XS} shrink-0`}>
              Download and install
            </button>
          ) : state.phase === "installed" ? (
            <button type="button" onClick={relaunch} className={`${PRIMARY_BUTTON_XS} shrink-0`}>
              Restart now
            </button>
          ) : (
            <button type="button" onClick={checkAgain} disabled={state.phase === "checking" || state.phase === "downloading"} className={`${SECONDARY_BUTTON_XS} shrink-0`}>
              {state.phase === "error" ? "Try again" : "Check again"}
            </button>
          )}
        </div>
        {state.phase === "downloading" ? <DownloadProgressBar progress={state.progress} /> : null}
        {state.phase === "error" ? <p className="text-[13px] leading-snug break-words text-red-300">{state.message}</p> : null}
        {notes ? (
          <div className="rounded-md border border-(--line) bg-(--surface-inset) px-3 py-2">
            <h4 className="text-[12px] font-medium tracking-wide text-neutral-500 uppercase">What's new</h4>
            <p className="mt-1 text-[13px] leading-snug whitespace-pre-wrap text-neutral-300">{notes}</p>
          </div>
        ) : null}
        <p className="text-[13px] leading-snug text-neutral-500">Updates come from the GitHub releases of unshoppable/hunt. The download replaces the app in place; the new version runs once Hunt restarts.</p>
      </div>
    </section>
  );
}

/** Progress of an update download; pulses at full width while the total size is unknown. */
function DownloadProgressBar({ progress }: { progress: DownloadProgress }) {
  const fraction = downloadFraction(progress);
  return (
    <div className="flex flex-col gap-1">
      <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={fraction === null ? undefined : Math.round(fraction * 100)} className="h-1.5 overflow-hidden rounded-full bg-white/8">
        <div className={`h-full rounded-full bg-blue-500 transition-[width] ${fraction === null ? "w-full animate-pulse" : ""}`} style={fraction === null ? undefined : { width: `${fraction * 100}%` }} />
      </div>
      <span className="text-[12px] text-neutral-500">{describeProgress(progress)}</span>
    </div>
  );
}

function FileIconsSection() {
  const rules = useSettingsStore((state) => state.iconRules);
  const setIconRules = useSettingsStore((state) => state.setIconRules);
  const resetIconRules = useSettingsStore((state) => state.resetIconRules);
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const isShown = (rule: IconRule) => !needle || rule.glob.toLowerCase().includes(needle) || rule.icon.toLowerCase().includes(needle);

  const { update, remove, move, add } = ruleListEdits(() => useSettingsStore.getState().iconRules, setIconRules);

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
          className="w-full rounded border border-neutral-600 bg-(--surface-input) px-2 py-1 text-sm text-neutral-200 outline-none placeholder:text-neutral-600 focus:border-neutral-400"
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
          <button type="button" onClick={() => add({ glob: "", icon: "" })} className={SECONDARY_BUTTON_XS}>
            <PlusIcon />
            Add rule
          </button>
        </div>
        <IconPreviewRow rules={rules} />
      </div>
    </section>
  );
}

/**
 * Which icon a folder gets: an ordered list of glob rules over the worktree-relative folder path, each for the matching
 * folder alone or for every folder below it too, with a live preview.
 */
function FolderIconsSection() {
  const rules = useSettingsStore((state) => state.folderIconRules);
  const setFolderIconRules = useSettingsStore((state) => state.setFolderIconRules);
  const resetFolderIconRules = useSettingsStore((state) => state.resetFolderIconRules);
  const { update, remove, move, add } = ruleListEdits(() => useSettingsStore.getState().folderIconRules, setFolderIconRules);

  return (
    <section>
      <PageHeader title="Folder icons" hint="Which icon a folder gets, by glob over its path relative to the repository root" isDefault={isFolderIconRulesDefault(rules)} onReset={resetFolderIconRules} />
      <div className="flex flex-col gap-4">
        <p className="text-[13px] leading-snug text-neutral-500">
          Rules are tried top to bottom; the first whose glob matches wins, otherwise the folder name decides. A glob without a slash matches the folder name at any depth. With
          “Subfolders” every folder below a matching one gets the icon too; without it only the matching folder does.
        </p>
        <ul className="flex flex-col gap-1.5">
          {rules.map((rule, index) => (
            // Rows are positional: a rule has no identity of its own, and keying by index keeps the drafts with their row while typing.
            <IconRuleRow
              key={index}
              rule={rule}
              icons={FOLDER_ICON_NAMES}
              globExample="apps/admin-ui"
              onChange={(patch) => update(index, patch)}
              onRemove={() => remove(index)}
              onMoveUp={index > 0 ? () => move(index, -1) : undefined}
              onMoveDown={index < rules.length - 1 ? () => move(index, 1) : undefined}
            >
              <label className="flex shrink-0 items-center gap-1.5 text-[13px] text-neutral-300" title="Also give every folder below a matching one this icon">
                <input type="checkbox" checked={rule.includeSubfolders} onChange={(event) => update(index, { includeSubfolders: event.target.checked })} className="hunt-checkbox" />
                Subfolders
              </label>
            </IconRuleRow>
          ))}
        </ul>
        <div>
          <button type="button" onClick={() => add({ glob: "", icon: "", includeSubfolders: false })} className={SECONDARY_BUTTON_XS}>
            <PlusIcon />
            Add rule
          </button>
        </div>
        <FolderIconPreviewRow rules={rules} />
      </div>
    </section>
  );
}

/** One rule: its glob, the icon picker over `icons`, extra controls (`children`) and the buttons that order and delete it. */
function IconRuleRow({
  rule,
  icons,
  globExample = "apps/api/**",
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
  children,
}: {
  rule: IconRule;
  icons?: readonly string[];
  globExample?: string;
  onChange: (patch: Partial<IconRule>) => void;
  onRemove: () => void;
  onMoveUp: (() => void) | undefined;
  onMoveDown: (() => void) | undefined;
  children?: ReactNode;
}) {
  return (
    <li className="flex items-center gap-2">
      <DraftInput value={rule.glob} onCommit={(glob) => onChange({ glob })} placeholder={`Glob, e.g. ${globExample}`} ariaLabel="Glob" title={rule.glob} className="min-w-0 flex-1" />
      <IconPicker value={rule.icon} onChange={(icon) => onChange({ icon })} icons={icons} className="w-52" />
      {children}
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
        className="w-72 truncate rounded border border-neutral-600 bg-(--surface-input) px-2 py-1 font-mono text-sm text-neutral-200 outline-none focus:border-neutral-400"
        aria-label="Path to preview the icon of"
      />
      <div className="flex w-40 items-center gap-2 text-[13px] text-neutral-400">
        {trimmed ? <img src={fileIconUrl(trimmed)} alt="" className="size-4 shrink-0" /> : <span className="size-4 shrink-0" />}
        <span className="truncate font-mono">{trimmed ? resolveFileIcon(trimmed, rules) : ""}</span>
      </div>
    </div>
  );
}

/** Shows which icon a folder of the user's choosing gets under the current rules, closed, as they type. */
function FolderIconPreviewRow({ rules }: { rules: FolderIconRule[] }) {
  const folderIconUrl = useFolderIconUrl();
  const [path, setPath] = useState(PREVIEW_FOLDER_EXAMPLE);
  const trimmed = path.trim();

  return (
    <div className="flex items-center gap-3 border-t border-(--line) pt-4">
      <div className="min-w-0 flex-1 text-sm text-neutral-100">Preview</div>
      <input
        type="text"
        value={path}
        spellCheck={false}
        onChange={(event) => setPath(event.target.value)}
        placeholder="Folder to try, e.g. apps/admin-ui/src"
        className="w-72 truncate rounded border border-neutral-600 bg-(--surface-input) px-2 py-1 font-mono text-sm text-neutral-200 outline-none focus:border-neutral-400"
        aria-label="Folder to preview the icon of"
      />
      <div className="flex w-40 items-center gap-2 text-[13px] text-neutral-400">
        {trimmed ? <img src={folderIconUrl(trimmed)} alt="" className="size-4 shrink-0" /> : <span className="size-4 shrink-0" />}
        <span className="truncate font-mono">{trimmed ? resolveFolderIcon(trimmed, rules) : ""}</span>
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
      className={`truncate rounded border border-neutral-600 bg-(--surface-input) px-2 py-1 font-mono text-sm text-neutral-200 outline-none placeholder:font-sans placeholder:text-neutral-600 focus:border-neutral-400 ${className}`}
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
 * replaces the draft. `presets` are suggested below the field: all of them on a click or ↓, the matching ones while
 * typing; ↑/↓ highlight one, Enter or a click takes it.
 */
function TextRow({
  label,
  ariaLabel = label,
  value,
  onChange,
  presets,
  isMonospace = false,
  inputStyle,
  placeholder,
}: {
  label: string;
  ariaLabel?: string;
  value: string;
  onChange: (value: string) => void;
  presets?: { label?: string; value: string }[];
  isMonospace?: boolean;
  inputStyle?: CSSProperties;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState(value);
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const presetOptions = (presets ?? []).map((preset) => ({ id: preset.value, name: preset.label ?? preset.value, description: preset.label ? preset.value : null }));
  const suggestions = filterOptions(presetOptions, draft === value ? "" : draft);
  const showsSuggestions = isSuggesting && suggestions.length > 0;

  useEffect(() => setDraft(value), [value]);

  // Leaving the field unchanged stores nothing (a store write reaches every window).
  const commit = () => {
    if (draft.trim() !== value) {
      onChange(draft);
    }
    setDraft(value);
  };

  function suggest(index: number) {
    if (!presets) return;
    setActiveIndex(index);
    setIsSuggesting(true);
  }

  function pick(index: number) {
    const preset = suggestions[index];
    if (!preset) return;
    setIsSuggesting(false);
    setDraft(preset.id);
    if (preset.id !== value) {
      onChange(preset.id);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      if (showsSuggestions && activeIndex >= 0) {
        pick(activeIndex);
      } else {
        event.currentTarget.blur();
      }
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    if (showsSuggestions) {
      setActiveIndex(stepEnabled(suggestions, activeIndex, event.key === "ArrowDown" ? 1 : -1));
    } else {
      suggest(stepEnabled(suggestions, -1, 1));
    }
  }

  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1 text-sm text-neutral-100">{label}</div>
      <input
        ref={inputRef}
        type="text"
        role={presets ? "combobox" : undefined}
        aria-autocomplete={presets ? "list" : undefined}
        aria-expanded={presets ? showsSuggestions : undefined}
        aria-controls={showsSuggestions ? listId : undefined}
        aria-activedescendant={showsSuggestions && activeIndex >= 0 ? optionId(listId, activeIndex) : undefined}
        value={draft}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(event) => {
          setDraft(event.target.value);
          suggest(-1);
        }}
        onClick={() => suggest(-1)}
        onBlur={() => {
          setIsSuggesting(false);
          commit();
        }}
        onKeyDown={onKeyDown}
        style={inputStyle}
        className={`w-56 truncate rounded border border-neutral-600 bg-(--surface-input) px-2 py-1 text-sm text-neutral-200 outline-none focus:border-neutral-400 ${isMonospace ? "font-mono" : ""}`}
        aria-label={ariaLabel}
      />
      {showsSuggestions ? (
        <OptionMenu
          id={listId}
          label={ariaLabel}
          options={suggestions}
          selectedId={value}
          activeIndex={activeIndex}
          onActivate={setActiveIndex}
          onPick={pick}
          onClose={() => setIsSuggesting(false)}
          anchorRef={inputRef}
        />
      ) : null}
      {/* Keeps the field aligned with the unit column of NumberRow. */}
      <span className="w-6" />
    </div>
  );
}

/** Multi-line free text that commits when the field loses focus; ⌘↩ commits too. */
function TextArea({ ariaLabel, value, onChange }: { ariaLabel: string; value: string; onChange: (value: string) => void }) {
  const [draft, setDraft] = useState(value);

  useEffect(() => setDraft(value), [value]);

  // Leaving the field unchanged stores nothing (a store write reaches every window).
  const commit = () => {
    if (draft.trim() !== value) {
      onChange(draft);
    }
    setDraft(value);
  };

  return (
    <textarea
      value={draft}
      spellCheck={false}
      rows={14}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter" && event.metaKey) {
          event.currentTarget.blur();
        }
      }}
      className="min-h-40 w-full resize-y rounded border border-neutral-600 bg-(--surface-input) px-2 py-1.5 font-mono text-[13px] leading-snug text-neutral-200 outline-none focus:border-neutral-400"
      aria-label={ariaLabel}
    />
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
      <div className="flex items-center rounded border border-neutral-600 bg-(--surface-input)">
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
      <label className="flex items-center gap-2 rounded border border-neutral-600 bg-(--surface-input) px-2 py-1">
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
