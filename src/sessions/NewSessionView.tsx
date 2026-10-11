import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { commands } from "../ipc/commands";
import { useHuntStore, type AgentSetup, type PromptDraft, type SessionStart, type WorktreeTarget } from "../state/store";
import { commandsFor, useAgentDefaultsStore } from "../state/agentDefaults";
import { findSelectOption, listChoices, listModes } from "../chat/configOptions";
import { PromptInput, type ConfigSelect } from "../chat/PromptInput";
import type { PullRequest, Screenshot } from "../ipc/types";
import { repoName } from "../ui/path";
import { errorText, useLoad } from "../ui/useLoad";
import { HEADER_BAR } from "../ui/bars";
import { SECONDARY_BUTTON_SM } from "../ui/buttons";
import { GitHubIcon } from "../ui/icons";
import { PullRequestPopover } from "./PullRequestPopover";
import { findPullRequestBranch } from "./pullRequests";
import { titleFromPrompt } from "./sessionLabels";

const LAST_REPO_KEY = "hunt.lastRepoPath";

/** Agent config options offered in the toolbar, in display order. */
const TOOLBAR_CONFIG_IDS = ["model", "effort"];

/** Base branches tried in order when the repository offers them. */
const DEFAULT_BASE_REFS = ["master", "main"];

/** Mode a new session starts in unless the user picked another one; manual when the agent does not offer it. */
const DEFAULT_MODE = "auto";

/**
 * Start view for a new session, shown in the chat pane instead of a dialog: the first prompt creates the session,
 * which is listed and shown at once, and is sent as soon as the agent runs with the chosen model, effort and mode.
 * A top-level session gets a worktree from the chosen base branch; a sub session (`parentId` set) runs in the parent's
 * worktree. After a failed creation the view comes back with `initialError` and the unsent `initialPrompt`.
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
  const createSession = useHuntStore((state) => state.createSession);
  const createSubSession = useHuntStore((state) => state.createSubSession);
  const setRightTab = useHuntStore((state) => state.setRightTab);
  const knownOptions = useAgentDefaultsStore((state) => state.knownOptions);
  const knownCommands = useAgentDefaultsStore((state) => state.knownCommands);
  const preferred = useAgentDefaultsStore((state) => state.preferred);
  const setPreferred = useAgentDefaultsStore((state) => state.setPreferred);
  const [repoPath, setRepoPath] = useState(() => (parentId ? "" : (localStorage.getItem(LAST_REPO_KEY) ?? "")));
  const [branches, setBranches] = useState<string[]>([]);
  const [baseRef, setBaseRef] = useState("");
  const [error, setError] = useState<string | null>(initialError);
  const [showsPullRequests, setShowsPullRequests] = useState(false);
  const pullRequestButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (repoPath) return;
    setBranches([]);
    setBaseRef("");
  }, [repoPath]);
  useLoad(
    () => commands.listBranches(repoPath),
    {
      onValue: (names) => {
        setBranches(names);
        setError(null);
        setBaseRef((current) => (names.includes(current) ? current : (DEFAULT_BASE_REFS.find((name) => names.includes(name)) ?? names[0] ?? "")));
      },
      onError: (reason) => {
        setBranches([]);
        setBaseRef("");
        setError(errorText(reason));
      },
    },
    [repoPath],
    { isEnabled: !!repoPath },
  );

  async function pickRepository() {
    const selected = await open({ directory: true, multiple: false, title: "Select git repository" });
    if (typeof selected === "string") {
      setRepoPath(selected);
    }
  }

  /**
   * Starts the review session of a pull request right away, without a prompt: a worktree on the pull request's branch,
   * titled after the pull request and marked as its review, with the diff pane showing the pull request's changes
   * against its target branch. Both branches must have been fetched into the repository.
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
    const target: WorktreeTarget = { repoPath, baseRef: branch, pullRequest: { number: selected.number, url: selected.url }, diffBaseRef: targetBranch };
    startSession(`#${selected.number} ${selected.title}`, target, null);
    setRightTab("diff");
  }

  const hasTarget = Boolean(parent || (repoPath && baseRef));
  const projectName = parent ? repoName(parent.repoPath) : repoPath ? repoName(repoPath) : null;
  const configSelects: ConfigSelect[] = TOOLBAR_CONFIG_IDS.flatMap((id) => {
    const option = findSelectOption(knownOptions, id);
    if (!option) return [];
    const choices = listChoices(option).map((choice) => ({ id: choice.value, name: choice.name }));
    const value = preferred[id] && choices.some((choice) => choice.id === preferred[id]) ? preferred[id] : option.currentValue;
    return [{ id, name: option.name, value, choices }];
  });
  const modes = listModes(knownOptions);
  const slashCommands = commandsFor(knownCommands, parent ? parent.repoPath : repoPath);
  const modeId = [preferred.mode, DEFAULT_MODE, "default"].find((id) => id && modes.some((mode) => mode.id === id)) ?? "default";
  /** The agent settings picked in the toolbar, applied to the new session before its first prompt. */
  const setup: AgentSetup = { configValues: Object.fromEntries(configSelects.map((select) => [select.id, select.value])), modeId };

  /**
   * Creates the session with the picked agent settings and `prompt`: a sub session under `parent`, else a top-level
   * one in a worktree of `target`. The store lists and shows the session at once and, should the creation fail,
   * brings this view back with the error and the prompt.
   */
  function startSession(title: string, target: WorktreeTarget, prompt: PromptDraft | null) {
    const start: SessionStart = { setup, prompt };
    const created = parent ? createSubSession(parent.id, title, null, start, true) : createSession(target, title, start);
    created.catch(() => undefined);
  }

  function start(text: string, images: Screenshot[]) {
    if (!hasTarget) return;
    if (!parent) {
      localStorage.setItem(LAST_REPO_KEY, repoPath);
    }
    startSession(titleFromPrompt(text) || "Screenshot", { repoPath, baseRef, pullRequest: null, diffBaseRef: null }, { text, images });
  }

  if (parentId && !parent) return null;

  const targetBar = parent ? null : (
    <div className="mx-4 -mt-2 flex items-center justify-between gap-3 rounded-b-2xl border border-t-0 border-(--line) bg-(--surface-inset)/60 px-3 pb-2 pt-4 text-sm text-neutral-400">
      <button
        type="button"
        onClick={() => void pickRepository()}
        title={repoPath || "Choose a repository"}
        className="flex h-8 min-w-0 items-center gap-1.5 rounded-md px-2.5 transition-colors hover:bg-(--row-hover) hover:text-neutral-200"
      >
        <FolderIcon />
        <span className="truncate">{repoPath ? repoName(repoPath) : "Choose repository"}</span>
      </button>
      <label
        title="Base branch the worktree is created from"
        className="relative flex h-8 items-center gap-1.5 rounded-md pl-2.5 transition-colors hover:bg-(--row-hover) hover:text-neutral-200 has-disabled:opacity-50"
      >
        <BranchIcon />
        <select
          value={baseRef}
          disabled={!branches.length}
          onChange={(event) => setBaseRef(event.target.value)}
          className="max-w-64 appearance-none truncate bg-transparent pr-6 outline-none"
        >
          {!branches.length ? <option value="">{repoPath ? "No branches" : "Base branch"}</option> : null}
          {branches.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <svg viewBox="0 0 16 16" className="pointer-events-none absolute right-1.5 size-3 text-neutral-500" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m4 6 4 4 4-4" />
        </svg>
      </label>
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
              className={`${SECONDARY_BUTTON_SM} pr-0`}
              title={repoPath ? "Start a review session of an open pull request of this repository" : "Choose a repository first"}
              aria-haspopup="dialog"
              aria-expanded={showsPullRequests}
            >
              <GitHubIcon className="size-4" />
              PR review
              {/* Split-button look like GitHub's: a divider and a chevron announce the list that opens. */}
              <span className="ml-1.5 flex h-full items-center border-l border-white/10 px-2 text-neutral-400">
                <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="m4 6 4 4 4-4" />
                </svg>
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
                <button
                  type="button"
                  onClick={() => void pickRepository()}
                  title={repoPath}
                  className="underline decoration-neutral-500 decoration-dotted underline-offset-6 hover:decoration-neutral-300"
                >
                  {repoName(repoPath)}
                </button>
              </>
            ) : null}
            ?
          </h1>
          <p className="mt-3 text-base text-neutral-500">
            {parent ? (
              <>Runs in the worktree of “{parent.title}” on {parent.branch}</>
            ) : repoPath ? (
              <button type="button" onClick={() => void pickRepository()} className="hover:text-neutral-300">
                or choose another repository
              </button>
            ) : (
              <button type="button" onClick={() => void pickRepository()} className="text-neutral-300 underline underline-offset-4 hover:text-white">
                Choose a repository to start
              </button>
            )}
          </p>
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
            onCancel={() => {}}
            onCycleMode={() => {}}
            onModeChange={(value) => setPreferred("mode", value)}
            onConfigChange={setPreferred}
            extension={targetBar}
            placeholder="Describe what to build or change"
            initialDraft={initialPrompt}
            hint={!hasTarget ? "Choose a repository and base branch first" : "enter starts the session · shift+enter adds a line"}
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

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

function BranchIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="6" cy="5" r="2" />
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="8" r="2" />
      <path d="M6 7v10M18 10a6 6 0 0 1-6 6H6" />
    </svg>
  );
}
