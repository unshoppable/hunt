import { useEffect, useRef, useState, type RefObject } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { commands } from "../ipc/commands";
import { useHuntStore, type AgentSetup, type PromptDraft, type SessionStart, type WorktreeTarget } from "../state/store";
import { commandsFor, useAgentDefaultsStore } from "../state/agentDefaults";
import { findSelectOption, listChoiceOptions, listModes } from "../chat/configOptions";
import { PromptInput, type ConfigSelect } from "../chat/PromptInput";
import type { PullRequest, Screenshot, Workspace } from "../ipc/types";
import { dirName, repoName } from "../ui/path";
import { errorText, useLoad } from "../ui/useLoad";
import { HEADER_BAR } from "../ui/bars";
import { SECONDARY_BUTTON_XS } from "../ui/buttons";
import { Dropdown } from "../ui/Dropdown";
import type { DropdownOption } from "../ui/floatingMenu";
import { BranchIcon, CheckIcon, ChevronDownIcon, GitHubIcon } from "../ui/icons";
import { useDismiss } from "../ui/useDismiss";
import { PullRequestPopover } from "./PullRequestPopover";
import { findPullRequestBranch } from "./pullRequests";
import { titleFromPrompt } from "./sessionLabels";

/** Where a session can work; "New environment" (issue #2) is announced but not built yet, hence disabled. */
const WORKSPACE_OPTIONS: DropdownOption[] = [
  { id: "worktree", name: "Worktree", description: "A fresh worktree off the base branch" },
  { id: "checkout", name: "Current checkout", description: "The repository's checkout as it is" },
  { id: "environment", name: "New environment", description: "Not available yet", isDisabled: true },
];

/** Trigger of a dropdown in the bar below the composer. */
const BAR_DROPDOWN = "flex h-8 min-w-0 items-center gap-1.5 rounded-md pl-2.5 pr-1.5 outline-none transition-colors hover:bg-(--row-hover) hover:text-neutral-200 disabled:opacity-50";

/** Agent config options offered in the toolbar, in display order. */
const TOOLBAR_CONFIG_IDS = ["model", "effort"];

/** Base branches tried in order when the repository offers them. */
const DEFAULT_BASE_REFS = ["master", "main"];

/** Mode a new session starts in unless the user picked another one; manual when the agent does not offer it. */
const DEFAULT_MODE = "auto";

/** Config values a new session starts with unless the user picked others; the agent's own value when it does not offer them. */
const DEFAULT_CONFIG_VALUES: Record<string, string> = { effort: "high" };

/** Where a new session works unless the user picked otherwise. */
const DEFAULT_WORKSPACE: Workspace = "worktree";

/**
 * Start view for a new session, shown in the chat pane instead of a dialog. The repository used last is preselected;
 * choosing a repository (folder dialog or the list of recent ones) creates the session right away, titled after the
 * repository until the first prompt names it, so the sidebar lists it and the diff, editor and graph panes work before
 * anything was asked. With the preselected repository the first prompt creates the session, which is listed and shown
 * at once, and is sent as soon as the agent runs with the chosen model, effort and mode. A top-level session gets a
 * worktree from the chosen base branch, or works in the repository's own checkout on its current branch; a sub session
 * (`parentId` set) runs in the parent's worktree. After a failed creation the view comes back with `initialError` and
 * the unsent `initialPrompt`.
 */
export function NewSessionView({
  parentId,
  initialError = null,
  initialPrompt = null,
}: {
  parentId: string | null;
  initialError?: string | null;
  initialPrompt?: PromptDraft | null;
}) {
  const parent = useHuntStore((state) => state.sessions.find((session) => session.id === parentId));
  /** Repository of the newest top-level session; preselected when no repository was remembered yet. */
  const latestRepoPath = useHuntStore((state) => state.sessions.find((session) => !session.parentId)?.repoPath ?? null);
  const createSession = useHuntStore((state) => state.createSession);
  const createSubSession = useHuntStore((state) => state.createSubSession);
  const setRightTab = useHuntStore((state) => state.setRightTab);
  const knownOptions = useAgentDefaultsStore((state) => state.knownOptions);
  const knownCommands = useAgentDefaultsStore((state) => state.knownCommands);
  const preferred = useAgentDefaultsStore((state) => state.preferred);
  const setPreferred = useAgentDefaultsStore((state) => state.setPreferred);
  const recentRepoPaths = useAgentDefaultsStore((state) => state.recentRepoPaths);
  const [repoPath, setRepoPath] = useState(() => (parentId ? "" : (recentRepoPaths[0] ?? latestRepoPath ?? "")));
  const [branches, setBranches] = useState<string[]>([]);
  const [baseRef, setBaseRef] = useState("");
  /** Branch the repository's checkout is on; a session in the checkout starts from it. */
  const [currentBranch, setCurrentBranch] = useState("");
  const workspace: Workspace = preferred.workspace === "checkout" ? "checkout" : DEFAULT_WORKSPACE;
  const isCheckout = workspace === "checkout";
  const [error, setError] = useState<string | null>(initialError);
  /** Set when the user chose a repository: the session starts as soon as the repository's branches are known. */
  const [startsWhenLoaded, setStartsWhenLoaded] = useState(false);
  const [showsPullRequests, setShowsPullRequests] = useState(false);
  /** Which repository menu is open: the one under the heading's repository name or the one in the target bar. */
  const [repoMenu, setRepoMenu] = useState<"heading" | "bar" | null>(null);
  const pullRequestButtonRef = useRef<HTMLButtonElement>(null);
  const headingRepoButtonRef = useRef<HTMLButtonElement>(null);
  const recentReposButtonRef = useRef<HTMLButtonElement>(null);

  // At launch the view is up before the stored sessions are listed: the newest session's repository is preselected once they are.
  useEffect(() => {
    if (repoPath || parentId || !latestRepoPath) return;
    setRepoPath(latestRepoPath);
  }, [repoPath, parentId, latestRepoPath]);
  useEffect(() => {
    if (repoPath) return;
    setBranches([]);
    setBaseRef("");
    setCurrentBranch("");
  }, [repoPath]);
  useLoad(
    () => Promise.all([commands.listBranches(repoPath), commands.currentBranch(repoPath)]),
    {
      onValue: ([names, current]) => {
        setBranches(names);
        setCurrentBranch(current);
        setError(null);
        const next = names.includes(baseRef) ? baseRef : (DEFAULT_BASE_REFS.find((name) => names.includes(name)) ?? names[0] ?? "");
        setBaseRef(next);
        if (!startsWhenLoaded) return;
        setStartsWhenLoaded(false);
        const ref = isCheckout ? current : next;
        if (ref) {
          startSession(null, plainTarget(ref), null);
        } else {
          setError(`${repoName(repoPath)} has no branches to start from.`);
        }
      },
      onError: (reason) => {
        setBranches([]);
        setBaseRef("");
        setCurrentBranch("");
        setStartsWhenLoaded(false);
        setError(errorText(reason));
      },
    },
    [repoPath],
    { isEnabled: !!repoPath },
  );

  /** The branch the new session starts from: the chosen base branch, or the checkout's own for a session in the checkout. */
  const startRef = isCheckout ? currentBranch : baseRef;

  /** Where a session that reviews no pull request works: in the chosen workspace of the repository, off `ref`. */
  function plainTarget(ref: string): WorktreeTarget {
    return { repoPath, baseRef: ref, workspace, pullRequest: null, diffBaseRef: null, pullRequestBranch: null };
  }

  /** Makes `path` the repository and starts a session in it as soon as its branch is known. */
  function selectRepository(path: string) {
    setRepoMenu(null);
    if (path === repoPath && startRef) {
      startSession(null, plainTarget(startRef), null);
      return;
    }
    setRepoPath(path);
    setStartsWhenLoaded(true);
  }

  async function pickRepository() {
    setRepoMenu(null);
    const selected = await open({ directory: true, multiple: false, title: "Select git repository", defaultPath: repoPath || undefined });
    if (typeof selected === "string") {
      selectRepository(selected);
    }
  }

  /**
   * Starts the review session of a pull request right away, without a prompt: a worktree on the pull request's own
   * branch (a local branch of that name, created from its copy on a remote when missing), titled after the pull
   * request and marked as its review, with the diff pane showing the pull request's changes against its target branch.
   * Both branches must have been fetched into the repository.
   */
  function selectPullRequest(selected: PullRequest) {
    setShowsPullRequests(false);
    const branch = findPullRequestBranch(branches, selected.headRefName);
    const targetBranch = findPullRequestBranch(branches, selected.baseRefName);
    if (!branch || !targetBranch) {
      setError(`Branch "${branch ? selected.baseRefName : selected.headRefName}" of #${selected.number} is not in the repository yet; fetch it first.`);
      return;
    }
    setBaseRef(branch);
    setError(null);
    const target: WorktreeTarget = {
      repoPath,
      baseRef: branch,
      workspace: "worktree",
      pullRequest: { number: selected.number, url: selected.url },
      diffBaseRef: targetBranch,
      pullRequestBranch: selected.headRefName,
    };
    startSession(`#${selected.number} ${selected.title}`, target, null);
    setRightTab("diff");
  }

  const hasTarget = Boolean(parent || (repoPath && startRef));
  const projectName = parent ? repoName(parent.repoPath) : repoPath ? repoName(repoPath) : null;
  const configSelects: ConfigSelect[] = TOOLBAR_CONFIG_IDS.flatMap((id) => {
    const option = findSelectOption(knownOptions, id);
    if (!option) return [];
    const choices = listChoiceOptions(option);
    const value = [preferred[id], DEFAULT_CONFIG_VALUES[id]].find((candidate) => candidate && choices.some((choice) => choice.id === candidate)) ?? option.currentValue;
    return [{ id, name: option.name, value, choices }];
  });
  const modes = listModes(knownOptions);
  const slashCommands = commandsFor(knownCommands, parent ? parent.repoPath : repoPath);
  const modeId = [preferred.mode, DEFAULT_MODE, "default"].find((id) => id && modes.some((mode) => mode.id === id)) ?? "default";
  /** The agent settings picked in the toolbar, applied to the new session before its first prompt. */
  const setup: AgentSetup = { configValues: Object.fromEntries(configSelects.map((select) => [select.id, select.value])), modeId };

  /**
   * Creates the session with the picked agent settings and `prompt`: a sub session under `parent`, else a top-level
   * one in the workspace of `target`. A `null` title names the session after its repository until its first prompt
   * names it. The store lists and shows the session at once and, should the creation fail, brings this view back
   * with the error and the prompt.
   */
  function startSession(title: string | null, target: WorktreeTarget, prompt: PromptDraft | null) {
    const start: SessionStart = { setup, prompt };
    const created = parent ? createSubSession(parent.id, title, null, start, true) : createSession(target, title, start);
    created.catch(() => undefined);
  }

  function start(text: string, images: Screenshot[]) {
    if (!hasTarget) return;
    startSession(titleFromPrompt(text) || "Screenshot", plainTarget(startRef), { text, images });
  }

  if (parentId && !parent) return null;

  const targetBar = parent ? null : (
    <div className="mx-4 -mt-2 flex items-center justify-between gap-3 rounded-b-2xl border border-t-0 border-(--line) bg-(--surface-inset)/60 px-3 pb-2 pt-4 text-sm text-neutral-400">
      {/* Split button like the PR review one: the name opens the folder dialog, the chevron lists recently used repositories. */}
      <div className="relative flex h-8 min-w-0 items-stretch rounded-md">
        <button
          type="button"
          onClick={() => void pickRepository()}
          title={repoPath ? `${repoPath} · choosing a repository starts a session in it` : "Choose a repository; the session starts right away"}
          className="flex min-w-0 items-center gap-1.5 rounded-l-md pl-2.5 pr-2 transition-colors hover:bg-(--row-hover) hover:text-neutral-200"
        >
          <FolderIcon />
          <span className="truncate">{repoPath ? repoName(repoPath) : "Choose repository"}</span>
        </button>
        <button
          ref={recentReposButtonRef}
          type="button"
          onClick={() => setRepoMenu((current) => (current === "bar" ? null : "bar"))}
          title="Recently used repositories"
          aria-label="Recently used repositories"
          aria-haspopup="menu"
          aria-expanded={repoMenu === "bar"}
          className="flex items-center rounded-r-md border-l border-white/10 px-2 transition-colors hover:bg-(--row-hover) hover:text-neutral-200"
        >
          <ChevronDownIcon />
        </button>
        {repoMenu === "bar" ? (
          <RepositoryMenu
            anchorRef={recentReposButtonRef}
            repoPath={repoPath}
            recentRepoPaths={recentRepoPaths}
            onSelect={selectRepository}
            onPick={() => void pickRepository()}
            onClose={() => setRepoMenu(null)}
            className="top-full left-0"
          />
        ) : null}
      </div>
      <div className="flex min-w-0 items-center gap-3">
        <Dropdown
          title="Where the session works: a fresh worktree off the base branch, or the repository's checkout as it is"
          value={workspace}
          options={WORKSPACE_OPTIONS}
          onChange={(id) => setPreferred("workspace", id)}
          icon={<WorkspaceIcon />}
          className={`${BAR_DROPDOWN} shrink-0`}
        />
        <Dropdown
          title={isCheckout ? "Branch the checkout is on; the session works on it as it is" : "Base branch the worktree is created from"}
          value={startRef}
          options={isCheckout ? [] : branches.map((name) => ({ id: name, name }))}
          onChange={setBaseRef}
          disabled={isCheckout || !branches.length}
          placeholder={isCheckout ? "Current branch" : repoPath ? "No branches" : "Base branch"}
          icon={<BranchIcon className="size-4 shrink-0" />}
          className={`${BAR_DROPDOWN} max-w-72`}
        />
      </div>
    </div>
  );

  return (
    <div className="chat @container flex h-full min-h-0 flex-col bg-(--chat-bg)">
      <header data-tauri-drag-region="" className={`${HEADER_BAR} gap-2 border-b border-(--line) px-4 text-sm`}>
        <span data-tauri-drag-region="" className="truncate text-neutral-400">{projectName ?? "No repository"}</span>
        <span data-tauri-drag-region="" className="text-neutral-600">/</span>
        <span data-tauri-drag-region="" className="truncate font-semibold">{parent ? `New sub session of ${parent.title}` : "New session"}</span>
        {!parent ? (
          <span className="relative ml-auto">
            <button
              ref={pullRequestButtonRef}
              type="button"
              disabled={!repoPath}
              onClick={() => setShowsPullRequests((current) => !current)}
              className={`${SECONDARY_BUTTON_XS} pr-0`}
              title={repoPath ? "Start a review session of an open pull request of this repository" : "Choose a repository first"}
              aria-haspopup="dialog"
              aria-expanded={showsPullRequests}
            >
              <GitHubIcon className="size-4" />
              PR review
              {/* Split-button look like GitHub's: a divider and a chevron announce the list that opens. */}
              <span className="ml-1.5 flex h-full items-center border-l border-white/10 px-2 text-neutral-400">
                <ChevronDownIcon />
              </span>
            </button>
            {showsPullRequests ? (
              <PullRequestPopover repoPath={repoPath} anchorRef={pullRequestButtonRef} onSelect={selectPullRequest} onClose={() => setShowsPullRequests(false)} />
            ) : null}
          </span>
        ) : null}
      </header>
      <div className="flex min-h-0 flex-1 flex-col justify-center overflow-y-auto py-8">
        <div className="chat-column px-5 text-center">
          <h1 className="text-3xl font-medium tracking-tight text-neutral-100">
            What should we build
            {parent ? (
              <>
                {" in "}
                <span title={parent.worktreePath} className="underline decoration-neutral-500 decoration-dotted underline-offset-6">
                  {parent.title}
                </span>
              </>
            ) : repoPath ? (
              <>
                {" in "}
                <span className="relative inline-block">
                  <button
                    ref={headingRepoButtonRef}
                    type="button"
                    onClick={() => setRepoMenu((current) => (current === "heading" ? null : "heading"))}
                    title={repoPath}
                    aria-haspopup="menu"
                    aria-expanded={repoMenu === "heading"}
                    className="group inline-flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 py-0.5 pr-2 pl-3 transition-colors hover:border-white/20 hover:bg-white/10 aria-expanded:border-white/20 aria-expanded:bg-white/10"
                  >
                    {repoName(repoPath)}
                    <span className="text-neutral-400 transition-transform group-aria-expanded:rotate-180 [&>svg]:size-5">
                      <ChevronDownIcon />
                    </span>
                  </button>
                  {repoMenu === "heading" ? (
                    <RepositoryMenu
                      anchorRef={headingRepoButtonRef}
                      repoPath={repoPath}
                      recentRepoPaths={recentRepoPaths}
                      onSelect={selectRepository}
                      onPick={() => void pickRepository()}
                      onClose={() => setRepoMenu(null)}
                      className="top-full left-1/2 -translate-x-1/2 text-left font-normal tracking-normal"
                    />
                  ) : null}
                </span>
              </>
            ) : null}
            ?
          </h1>
          {!parent && !repoPath ? (
            <p className="mt-3 text-base">
              <button type="button" onClick={() => void pickRepository()} className="text-neutral-300 underline underline-offset-4 hover:text-white">
                Choose a repository to start
              </button>
            </p>
          ) : null}
        </div>
        <div className="mt-6">
          <PromptInput
            isBusy={false}
            isBlocked={false}
            modeId={modeId}
            modes={modes}
            configSelects={configSelects}
            commands={slashCommands}
            onSend={start}
            onCycleMode={() => {}}
            onModeChange={(value) => setPreferred("mode", value)}
            onConfigChange={setPreferred}
            extension={targetBar}
            placeholder="Describe what to build or change"
            initialDraft={initialPrompt}
            hint={
              startsWhenLoaded
                ? "Starting the session…"
                : !hasTarget
                  ? "Choose a repository to start the session right away"
                  : "enter starts the session · shift+enter adds a line · choosing a repository starts one there right away"
            }
          />
          {error ? (
            <div className="chat-column px-5">
              <p className="mt-3 rounded-lg border border-red-400/40 bg-red-400/10 px-3 py-2 text-sm text-red-300 break-words">{error}</p>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Menu anchored below `anchorRef` listing the recently used repositories, with the folder dialog as last entry; choosing
 * a repository starts a session in it. `className` places the menu relative to its positioned parent.
 */
function RepositoryMenu({
  anchorRef,
  repoPath,
  recentRepoPaths,
  onSelect,
  onPick,
  onClose,
  className,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  repoPath: string;
  recentRepoPaths: string[];
  onSelect: (path: string) => void;
  onPick: () => void;
  onClose: () => void;
  className: string;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  useDismiss(menuRef, onClose, { anchorRefs: [anchorRef] });

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="Repositories"
      className={`absolute z-50 mt-1.5 w-72 max-w-[calc(100cqw-2rem)] rounded-xl border border-neutral-600 bg-(--surface-chat) p-1 text-sm text-neutral-400 shadow-2xl shadow-black/50 ${className}`}
    >
      {recentRepoPaths.map((path) => (
        <button
          key={path}
          type="button"
          role="menuitem"
          onClick={() => onSelect(path)}
          title={`Start a session in ${path}`}
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-(--row-hover) hover:text-neutral-200"
        >
          <FolderIcon />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-neutral-200">{repoName(path)}</span>
            <span className="truncate text-[12px] text-neutral-500">{dirName(path)}</span>
          </span>
          {path === repoPath ? <CheckIcon className="size-3.5 shrink-0 text-neutral-400" /> : null}
        </button>
      ))}
      {recentRepoPaths.length ? <div className="mx-1 my-1 border-t border-(--line)" /> : null}
      <button
        type="button"
        role="menuitem"
        onClick={onPick}
        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-(--row-hover) hover:text-neutral-200"
      >
        <FolderIcon />
        Choose another repository…
      </button>
    </div>
  );
}

/** Two stacked panes: where the session's files live. */
function WorkspaceIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="13" height="13" rx="2" />
      <path d="M8 21h11a2 2 0 0 0 2-2V8" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}
