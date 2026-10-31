import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { ClaudeAccounts } from "../accounts/accounts.types";
import type { PlanUsage } from "../accounts/plan-usage.types";
import type { Screenshot } from "../chat/chat.types";
import type { GuardrailDeclineReason } from "../chat/guardrail/guardrail-suggestion.types";
import type { ChecksStatus } from "../checks/checks.types";
import type { DiagramType } from "../common/diagram/diagram.types";
import type { DesktopEndpoint } from "../desktop/desktop.types";
import type { ChangeStat, ChangedFileView, Comparison, FileDiff, FileVersion, Shelf } from "../diff/diff.types";
import type { SelectionContext } from "../editor/selection-context.types";
import type { Commit, CommitDetails, GitScope, LogQuery, RefList, ResetMode } from "../git/git.types";
import type { GraphStatus } from "../graph/graph.types";
import type { SwfStepSkill } from "../guardrails/guardrail.types";
import type { LintRules } from "../guardrails/lint-rules.types";
import type { DocumentContentChange, DocumentEditAck, DocumentState } from "../ide/documents/documents.types";
import type { PrettierOutput } from "../ide/ide.types";
import type { LanguageServerKind } from "../ide/lsp/lsp.types";
import type { DirEntry } from "../ide/project-tree/project-tree.types";
import type { FileLine, ReplaceResult, TextQuery, TextSearchResult } from "../ide/search/find-in-files.types";
import type { PreviewStatus } from "../preview/preview.types";
import type { GithubViewer, PullRequestDetails, ReplyTarget, ReviewComment, ReviewEvent, ReviewThread } from "../review/review.types";
import type { PullRequest, PullRequestState } from "../sessions/pull-requests.types";
import type { RemoteLink, SessionVm } from "../sessions/remote/remote-session.types";
import type { PullRequestRef, SessionEnding, SessionView, Workspace } from "../sessions/session.types";
import type { CliInstall, GithubTokenStatus, RemoteSecretSummary, VmSettings } from "../settings/settings.types";
import type { Machine, TerminalTarget, TmuxWindow } from "../terminal/terminal.types";

/** URL under which the webview loads the file at the absolute `path`. */
export function assetUrl(path: string): string {
  return convertFileSrc(path);
}

export const commands = {
  listSessions: () => invoke<SessionView[]>("list_sessions"),
  /** A page of the commit log of the scope, newest first in date order. */
  gitLog: (scope: GitScope, query: LogQuery) => invoke<Commit[]>("git_log", { scope, query }),
  /** Every branch and tag of the scope, its checked-out branch and the commits no remote has. */
  gitRefs: (scope: GitScope) => invoke<RefList>("git_refs", { scope }),
  /** Message, committer, changed files and containing branches of the commit. */
  gitCommit: (scope: GitScope, commit: string) => invoke<CommitDetails>("git_commit", { scope, commit }),
  /** The change of `path` in the commit against its first parent; `oldPath` is where a renamed file was before. */
  gitCommitFileDiff: (scope: GitScope, commit: string, path: string, oldPath: string | null) =>
    invoke<FileDiff>("git_commit_file_diff", { scope, commit, path, oldPath }),
  /** Checks a branch out in the repository's own checkout; a remote one (`origin/<name>`) as the local branch of its name. */
  gitCheckout: (repoPath: string, branch: string, isRemote: boolean) => invoke<void>("git_checkout", { repoPath, branch, isRemote }),
  /** Rebases the checked-out branch onto the branch or remote branch `onto`; a conflict aborts and names the files. */
  gitRebase: (scope: GitScope, onto: string) => invoke<void>("git_rebase", { scope, onto }),
  /** Merges the branch or remote branch `from` into the checked-out branch; a conflict aborts and names the files. */
  gitMerge: (scope: GitScope, from: string) => invoke<void>("git_merge", { scope, from }),
  /** Resets the checked-out branch to the commit in `mode`, on a session's VM too; `keep` fails when an uncommitted change is in the way. */
  gitReset: (scope: GitScope, commit: string, mode: ResetMode) => invoke<void>("git_reset", { scope, commit, mode }),
  /** Rebases the session's branch onto the branch its push lands on, fetched first. */
  gitUpdateBranch: (sessionId: string) => invoke<void>("git_update_branch", { id: sessionId }),
  /** Fast-forwards another local branch to its upstream, fetched first; `false` when the upstream has no commits it lacks. */
  gitPullBranch: (scope: GitScope, branch: string) => invoke<boolean>("git_pull_branch", { scope, branch }),
  /** Resets another local branch to its upstream, fetched first; the commits the upstream lacks are lost. */
  gitForcePullBranch: (scope: GitScope, branch: string) => invoke<void>("git_force_pull_branch", { scope, branch }),
  /** Pushes a local branch other than the session's to the branch of the same name on `origin`. */
  gitPushLocalBranch: (scope: GitScope, branch: string) => invoke<void>("git_push_local_branch", { scope, branch }),
  /** Force pushes a local branch other than the session's to `origin`; the commits `origin` has that it lacks are dropped, unless `origin` moved since the last fetch. */
  gitForcePushLocalBranch: (scope: GitScope, branch: string) => invoke<void>("git_force_push_local_branch", { scope, branch }),
  /** Renames a local branch; the sessions on it follow, a remote one refuses. */
  gitRenameBranch: (scope: GitScope, branch: string, newName: string) => invoke<void>("git_rename_branch", { scope, branch, newName }),
  /** Makes `target` on `origin` the branch a push of the session lands on, here and on the session's VM; a poller session refuses. */
  /** `create` makes a branch origin lacks there first, at the commit of the branch pushed to so far. */
  setPushTarget: (sessionId: string, target: string, create = false) => invoke<void>("set_push_target", { id: sessionId, target, create }),
  /** Deletes a local branch; without `force`, git refuses one whose commits its upstream (or HEAD) lacks with "not fully merged". */
  gitDeleteBranch: (scope: GitScope, branch: string, force: boolean) => invoke<void>("git_delete_branch", { scope, branch, force }),
  /** Deletes the branch `branch` on `origin`. */
  gitDeleteRemoteBranch: (scope: GitScope, branch: string) => invoke<void>("git_delete_remote_branch", { scope, branch }),
  /** Fetches the branch `branch` of `origin`; `false` when `origin` has no such branch. */
  gitFetchBranch: (scope: GitScope, branch: string) => invoke<boolean>("git_fetch_branch", { scope, branch }),
  /** Fetches every branch of `origin` and drops the remote-tracking refs of the branches `origin` no longer has. */
  gitFetchOrigin: (scope: GitScope) => invoke<void>("git_fetch_origin", { scope }),
  listBranches: (repoPath: string) => invoke<string[]>("list_branches", { repoPath }),
  /** The branch the repository's checkout is on; `HEAD` when it is detached. */
  currentBranch: (repoPath: string) => invoke<string>("current_branch", { repoPath }),
  /** Fetches the branch `branch` of the repository's `origin`; `false` when `origin` has no such branch. */
  fetchRepoBranch: (repoPath: string, branch: string) => invoke<boolean>("fetch_repo_branch", { repoPath, branch }),
  /** Open pull requests of the repository's GitHub remote, newest first; needs the `gh` CLI to be installed and logged in. */
  listPullRequests: (repoPath: string) => invoke<PullRequest[]>("list_pull_requests", { repoPath }),
  /** Title of the issue or pull request `number` of the GitHub repository `owner`/`name`, as `gh` sees it from `repoPath`. */
  issueTitle: (repoPath: string, owner: string, name: string, number: number) => invoke<string>("issue_title", { repoPath, owner, name, number }),
  /** The GitHub account `gh` is logged in as for the repository's host; rejects when `gh` is missing or logged out. */
  githubViewer: (repoPath: string) => invoke<GithubViewer>("github_viewer", { repoPath }),
  /** Description and conversation of the pull request the session reviews; rejects when it reviews none. */
  viewPullRequest: (sessionId: string) => invoke<PullRequestDetails>("view_pull_request", { sessionId }),
  /** State and draft flag of the pull request the session reviews; rejects when it reviews none. */
  pullRequestState: (sessionId: string) => invoke<PullRequestState>("pull_request_state", { sessionId }),
  /** Review threads of the pull request the session reviews, with their replies; rejects when it reviews none. */
  listReviewThreads: (sessionId: string) => invoke<ReviewThread[]>("list_review_threads", { sessionId }),
  /** Submits a review of the pull request the session reviews; `body` is its summary comment. */
  submitPullRequestReview: (sessionId: string, event: ReviewEvent, body: string) =>
    invoke<void>("submit_pull_request_review", { id: sessionId, event, body }),
  /**
   * Drafts a review comment on lines `startLine..line` of the new version of `path`, or on the whole file when both are
   * 0 (`LineSpan.FILE`); it goes out with the next review. With `replyTo` it answers a thread or draft, and `path` and the
   * lines are those of what it answers.
   */
  addReviewComment: (sessionId: string, path: string, startLine: number, line: number, body: string, replyTo: ReplyTarget | null = null) =>
    invoke<ReviewComment>("add_review_comment", { id: sessionId, path, startLine, line, body, replyTo }),
  updateReviewComment: (sessionId: string, commentId: string, body: string) => invoke<void>("update_review_comment", { id: sessionId, commentId, body }),
  /** Discards a draft and the drafted replies to it. */
  deleteReviewComment: (sessionId: string, commentId: string) => invoke<void>("delete_review_comment", { id: sessionId, commentId }),
  /** Posts a reply to a review thread of the session's pull request right away, outside of a review. */
  replyToReviewThread: (sessionId: string, threadId: string, body: string) => invoke<void>("reply_to_review_thread", { id: sessionId, threadId, body }),
  /** Marks a review thread of the session's pull request as resolved, or as unresolved again. */
  resolveReviewThread: (sessionId: string, threadId: string, isResolved: boolean) =>
    invoke<void>("resolve_review_thread", { id: sessionId, threadId, isResolved }),
  /**
   * Creates the session `id` (a fresh UUID the caller picked) in a new worktree off `baseRef`. `pullRequest` marks it as
   * that pull request's review and `diffBaseRef` is then the pull request's target branch, whose merge base with
   * `baseRef` becomes the diff base; the worktree then works on the pull request's own branch `pullRequestBranch`,
   * which `baseRef` names locally or on a remote.
   */
  createSession: (
    id: string,
    repoPath: string,
    baseRef: string,
    title: string,
    pullRequest: PullRequestRef | null,
    diffBaseRef: string | null,
    pullRequestBranch: string | null,
    newBranch: string | null,
    workspace: Workspace,
  ) =>
    invoke<SessionView>("create_session", { id, repoPath, baseRef, title, pullRequest, diffBaseRef, pullRequestBranch, newBranch, workspace }),
  /** Starts the sub session `id` (a fresh UUID the caller picked) in the parent's worktree; a `selection` (sub chat from the diff) goes into the agent's context. */
  createSubSession: (id: string, parentId: string, title: string, selection: SelectionContext | null) =>
    invoke<SessionView>("create_sub_session", { id, parentId, title, selection }),
  /** Gives the session a new title; a session created without a prompt is named after its first one. */
  renameSession: (id: string, title: string) => invoke<SessionView>("rename_session", { id, title }),
  openSession: (id: string) => invoke<SessionView>("open_session", { id }),
  clearSession: (id: string) => invoke<SessionView>("clear_session", { id }),
  /**
   * Moves the session to a VM of its own, which the gateway of `settings` provisions when the session has none yet; the
   * private files the worktree's hunt.json names go along.
   */
  /** Brings up the VM a handoff of the session moves to while its agent still works locally; the session stays as it is. */
  prepareHandOff: (id: string, settings: VmSettings) => invoke<void>("prepare_hand_off", { id, settings }),
  handOffSession: (id: string, settings: VmSettings) => invoke<SessionView>("hand_off_session", { id, settings }),
  retrieveSession: (id: string) => invoke<SessionView>("retrieve_session", { id }),
  /**
   * Continues the remote session, which cannot reach its VM, on this Mac with the files as last synced; what its agent
   * did on the VM since is saved as `refs/hunt/<id>/abandoned` once the VM can be reached, then the VM is deleted.
   */
  continueLocally: (id: string) => invoke<SessionView>("continue_locally", { id }),
  /** Whether the local worktree of the remote session `id` (for a sub chat its parent's) may change; `null` for a local session. */
  remoteLink: (id: string) => invoke<RemoteLink | null>("remote_link", { id }),
  /** Keeps the idle remote session for now; Hunt asks again whether to retrieve or delete it three days later. */
  snoozeRemoteCleanup: (id: string) => invoke<void>("snooze_remote_cleanup", { id }),
  /** What listens on the remote session's VM and whether its main port answers; a VM that is off reports nothing and stays off. */
  previewStatus: (id: string) => invoke<PreviewStatus>("preview_status", { id }),
  /**
   * Opens a forward from this Mac to the remote desktop of the session's VM, or reuses the one that answers, and resolves
   * with its base URL; a VM that is off is an error and stays off.
   */
  desktopOpen: (id: string) => invoke<DesktopEndpoint>("desktop_open", { id }),
  /**
   * Opens the Chrome of the local session `id` with a copy of its repository's browser profile, or brings the running one
   * to the front; the annotations of its review widget arrive as `review:annotation`.
   */
  browserOpen: (id: string) => invoke<void>("browser_open", { id }),
  /**
   * Adopts the sessions of `ids` the gateway of `settings` lists that no local session knows, each in the local checkout
   * of its repository among `repoPaths` and the stored sessions' repositories, and brings the agent state of the remote
   * sessions this Mac has up to date; resolves with the IDs of the new sessions.
   */
  adoptSessionVms: (settings: VmSettings, repoPaths: string[], ids: string[]) => invoke<string[]>("adopt_session_vms", { settings, repoPaths, ids }),
  /** The session VMs the gateway of the remote settings lists, running or not, for the start view's list of remote sessions. */
  listSessionVms: () => invoke<SessionVm[]>("list_session_vms"),
  /**
   * The remote settings, or null while they are incomplete; the main window pushes them at its start and on every
   * change, and commands on stored remote sessions reach the gateway they name.
   */
  setRemoteSettings: (settings: VmSettings | null) => invoke<void>("set_remote_settings", { settings }),
  /**
   * Opens a terminal with `cols` × `rows` cells showing `process` of the session `id`: a service or tmux window on its
   * VM, or a window of the family's tmux server on this Mac. The caller picks `terminalId` and listens before it calls,
   * since the output (`terminal:output`, then `terminal:exit`, both sent to this window only) may arrive before the
   * promise resolves. A VM that is off stays off.
   */
  openTerminal: (id: string, terminalId: string, process: TerminalTarget, cols: number, rows: number) =>
    invoke<void>("open_terminal", { id, terminalId, process, cols, rows }),
  /** Types `data`, base64 of the input bytes, into the terminal. */
  writeTerminal: (terminalId: string, data: string) => invoke<void>("write_terminal", { terminalId, data }),
  resizeTerminal: (terminalId: string, cols: number, rows: number) => invoke<void>("resize_terminal", { terminalId, cols, rows }),
  /** Ends the terminal; the process it shows keeps running. Closing a terminal that is not open does nothing. */
  closeTerminal: (terminalId: string) => invoke<void>("close_terminal", { terminalId }),
  /**
   * The windows of the tmux session `app` of the session `id` on `machine`: none while the VM is off, and none on this
   * Mac while a remote session has no local worktree yet.
   */
  terminalWindows: (id: string, machine: Machine) => invoke<TmuxWindow[]>("terminal_windows", { id, machine }),
  /**
   * Starts a shell in a new tmux window of the session `id` and resolves to the window's ID: on the VM of a remote
   * session, in the family's tmux server on this Mac for a local one. With `script` the window runs that package.json
   * script of the worktree folder `directory`; a window that already runs it is reused and, when the script ended, runs
   * it again.
   */
  openShellWindow: (id: string, directory = "", script: string | null = null) => invoke<string>("open_shell_window", { id, directory, script }),
  /** Runs the package.json script of the ended script window `windowId` of the session `id` on `machine` again. */
  rerunTerminalWindow: (id: string, machine: Machine, windowId: string) => invoke<void>("rerun_terminal_window", { id, machine, windowId }),
  /** Ends the tmux window `windowId` of the session `id` on `machine` and the processes in it. */
  closeTerminalWindow: (id: string, machine: Machine, windowId: string) => invoke<void>("close_terminal_window", { id, machine, windowId }),
  /** The checks of the worktree's hunt.json with their last runs. */
  checksStatus: (id: string) => invoke<ChecksStatus>("checks_status", { id }),
  /** Runs the check `name` in its tmux window, locally or on the session's running VM; `checks:changed` reports the run. */
  runCheck: (id: string, name: string) => invoke<void>("run_check", { id, name }),
  /** Runs every check at once, except those that run already; a check that cannot start fails with the error. */
  runAllChecks: (id: string) => invoke<void>("run_all_checks", { id }),
  /** Stops the check `name`; its window stays with the output so far. */
  cancelCheck: (id: string, name: string) => invoke<void>("cancel_check", { id, name }),
  /** Stops every running check of the session. */
  cancelAllChecks: (id: string) => invoke<void>("cancel_all_checks", { id }),
  /** The output of the last run of the check `name` as plain text, or why it could not start; `null` before its first run. */
  checkOutput: (id: string, name: string) => invoke<string | null>("check_output", { id, name }),
  closeSession: (id: string, ending: SessionEnding) => invoke<void>("close_session", { id, ending }),
  /** Prepares the worktree's `node_modules` again after a failed attempt; progress arrives through `sessions:changed`. */
  prepareDependencies: (id: string) => invoke<void>("prepare_dependencies", { id }),
  /** Sends the text plus the image files at `images` (absolute paths) as one user turn. */
  /** Sends one user turn; `messageId` is the id of the chat item showing it, which `acp:message-times` names its time by. */
  sendPrompt: (id: string, text: string, images: string[], messageId: string) => invoke<string>("send_prompt", { id, text, images, messageId }),
  sessionHistory: (id: string) => invoke<SessionNotification[]>("session_history", { id }),
  cancelPrompt: (id: string) => invoke<void>("cancel_prompt", { id }),
  setSessionMode: (id: string, modeId: string) => invoke<void>("set_session_mode", { id, modeId }),
  setSessionConfigOption: (id: string, configId: string, value: string) =>
    invoke<void>("set_session_config_option", { id, configId, value }),
  answerPermission: (requestId: string, optionId: string) => invoke<void>("answer_permission", { requestId, optionId }),
  /** Answers the `control:command` `requestId` (see control/control-commands.hook.ts): `null` once it ran, else why it did not. */
  answerControlCommand: (requestId: string, error: string | null) => invoke<void>("answer_control_command", { requestId, error }),
  listChangedFiles: (id: string, comparison: Comparison = "diffBase") => invoke<ChangedFileView[]>("list_changed_files", { id, comparison }),
  /** Added and removed line counts of every uncommitted change, sorted by path. */
  changeStats: (id: string) => invoke<ChangeStat[]>("change_stats", { id }),
  readFileDiff: (id: string, path: string, comparison: Comparison = "diffBase") => invoke<FileDiff>("read_file_diff", { id, path, comparison }),
  /** Versions of `path` in the edit log of the session's worktree, oldest first. */
  readFileHistory: (id: string, path: string) => invoke<FileVersion[]>("read_file_history", { id, path }),
  writeFile: (id: string, path: string, content: string) => invoke<void>("write_file", { id, path, content }),
  /**
   * Writes the skills of the swf steps `skills` from Hunt's templates into the session's worktree, leaving existing skill
   * files alone, and adds the entry `swf.skills.<step>` of the worktree's hunt.json for each with `addEntry` whose entry
   * is missing; resolves with the worktree-relative paths it wrote, `hunt.json` among them when it changed, which count
   * as the session's own changes. Fails, writing nothing, for an unknown step, a bad name or a hunt.json without an `swf` object.
   */
  createSwfSkills: (sessionId: string, skills: SwfStepSkill[]) => invoke<string[]>("create_swf_skills", { id: sessionId, skills }),
  /** Restores `path` to its content at the base of `comparison`, or deletes it when it did not exist there. */
  revertFile: (id: string, path: string, comparison: Comparison = "diffBase") => invoke<void>("revert_file", { id, path, comparison }),
  /** Deletes a worktree file, or a folder with everything in it. */
  deletePath: (id: string, path: string) => invoke<void>("delete_path", { id, path }),
  /** Moves a worktree file to a path nothing exists at yet, creating its folders. */
  movePath: (id: string, from: string, to: string) => invoke<void>("move_path", { id, from, to }),
  shelveFiles: (id: string, paths: string[], name: string) => invoke<void>("shelve_files", { id, paths, name }),
  listShelves: (id: string) => invoke<Shelf[]>("list_shelves", { id }),
  /** Restores a shelf into the worktree; `keep` leaves the shelf in place instead of removing it. */
  unshelve: (id: string, reference: string, keep: boolean) => invoke<void>("unshelve", { id, reference, keep }),
  dropShelf: (id: string, reference: string) => invoke<void>("drop_shelf", { id, reference }),
  /** Commits exactly `paths` with `message` on the session's current branch; other staged changes stay out. */
  commitFiles: (id: string, paths: string[], message: string) => invoke<void>("commit_files", { id, paths, message }),
  /**
   * Pushes the session's commits to the branch it was created from on `origin` (`pushTarget` in `sessions/remote/remote-session.utils.ts`),
   * rebased onto it first when it moved on; the session's own branch never reaches `origin`.
   */
  pushBranch: (id: string) => invoke<void>("push_branch", { id }),
  /** Number of commits `pushBranch` would publish; 0 when they are on `origin` already. */
  unpushedCommitCount: (id: string) => invoke<number>("unpushed_commit_count", { id }),
  /** Language (English name, e.g. `German`) of the agent output Hunt asks for itself: diagram labels, summaries, titles. */
  setAiLanguage: (language: string) => invoke<void>("set_ai_language", { language }),
  /** System prompt addition for every agent session started afterwards; empty switches it off. */
  setSystemPrompt: (prompt: string) => invoke<void>("set_system_prompt", { prompt }),
  /** Whether `~/.local/bin/hunt` links to the `hunt-cli` beside the app binary and whether that folder is on the PATH. */
  cliInstallStatus: () => invoke<CliInstall>("cli_install_status"),
  /** Links `~/.local/bin/hunt` to the `hunt-cli` beside the app binary, replacing an earlier symlink; rejects for a file or folder there. */
  installCli: () => invoke<CliInstall>("install_cli"),
  /** Appends the declined guardrail suggestion to `.claude/declined-guardrails.jsonl` of the session's worktree, which its CLAUDE.md points agents at. */
  declineGuardrail: (sessionId: string, kind: string, summary: string, reason: GuardrailDeclineReason) =>
    invoke<void>("decline_guardrail", { id: sessionId, kind, summary, reason }),
  /** The claude.ai plan limits of the signed-in account; spawns a short-lived Claude Code process (~1 s). */
  getPlanUsage: () => invoke<PlanUsage>("get_plan_usage"),
  /** The Claude accounts and the one every Claude Code process starts with. */
  listAccounts: () => invoke<ClaudeAccounts>("list_accounts"),
  /**
   * Runs `claude setup-token`, opens its sign-in in a private browser window with `email` filled in and makes the token
   * the active account; signing in again renews the token. Rejects when the sign-in fails, times out or `cancelSignIn`
   * stops it.
   */
  signInAccount: (email: string) => invoke<ClaudeAccounts>("sign_in_account", { email }),
  cancelSignIn: () => invoke<void>("cancel_sign_in"),
  /** Removes the account and its token; removing the active one switches to the local login. */
  removeAccount: (id: string) => invoke<ClaudeAccounts>("remove_account", { id }),
  /** The account every Claude Code process started from now on uses; null selects the local login. */
  setActiveAccount: (id: string | null) => invoke<ClaudeAccounts>("set_active_account", { id }),
  /** Whether a GitHub token for remote sessions is in the keychain, with its last four characters. */
  githubTokenStatus: () => invoke<GithubTokenStatus>("github_token_status"),
  /** Stores the GitHub token remote sessions push and run `gh` with, replacing an earlier one. */
  setGithubToken: (token: string) => invoke<GithubTokenStatus>("set_github_token", { token }),
  removeGithubToken: () => invoke<GithubTokenStatus>("remove_github_token"),
  /** The remote secrets the gateway puts on every session VM, sorted by name; rejects while the gateway is unreachable. */
  listRemoteSecrets: (settings: VmSettings) => invoke<RemoteSecretSummary[]>("list_remote_secrets", { settings }),
  /** Creates the remote secret `name` or replaces its value. */
  setRemoteSecret: (settings: VmSettings, name: string, value: string) => invoke<void>("set_remote_secret", { settings, name, value }),
  /** Deletes the remote secret `name`; resolves to whether it existed. */
  deleteRemoteSecret: (settings: VmSettings, name: string) => invoke<boolean>("delete_remote_secret", { settings, name }),
  /** Every image in the macOS screenshot folder, newest first. */
  listScreenshots: () => invoke<Screenshot[]>("list_screenshots"),
  /** The image files among `paths` (e.g. files dropped into the chat) as attachments; other files are left out. */
  imageFiles: (paths: string[]) => invoke<Screenshot[]>("image_files", { paths }),
  openWorktreeInWebstorm: (id: string) => invoke<void>("open_worktree_in_webstorm", { id }),
  /** Opens a worktree file in WebStorm with the caret on `line`:`column` (1-based). */
  openFileInWebstorm: (id: string, path: string, line: number, column: number) =>
    invoke<void>("open_file_in_webstorm", { id, path, line, column }),
  openChangedFilesDiffInWebstorm: (id: string, comparison: Comparison = "diffBase") =>
    invoke<void>("open_changed_files_diff_in_webstorm", { id, comparison }),
  /** Opens a shell in the session's worktree: a new WezTerm tab when WezTerm is installed, else a Terminal.app window. */
  openWorktreeInTerminal: (id: string) => invoke<void>("open_worktree_in_terminal", { id }),
  /** Raw content of the session's diagram file of `diagramType`, `null` while there is none; validate with `parseGraph` or `parseShapeDiagram`. */
  readGraph: (id: string, diagramType: DiagramType) => invoke<unknown>("read_graph", { id, diagramType }),
  /** Writes the whole diagram file of `diagramType` after an edit in the Architecture tab; `content` comes from `serializeShapeDiagram`. */
  writeGraph: (id: string, diagramType: DiagramType, content: string) => invoke<void>("write_graph", { id, diagramType, content }),
  /** When the diagram of `diagramType` was generated and whether the worktree's sessions changed files since. */
  graphStatus: (id: string, diagramType: DiagramType) => invoke<GraphStatus>("graph_status", { id, diagramType }),
  /**
   * Generates the diagram of `diagramType` with its standard prompt and `instructions` appended for this run in a
   * background agent on `model` with `effort`, apart from the session's chat agent; resolves once the agent finished.
   */
  refreshGraph: (id: string, diagramType: DiagramType, instructions: string, model: string, effort: string) =>
    invoke<void>("refresh_graph", { id, diagramType, instructions, model, effort }),
  /** Entries of a worktree directory (`path` relative, empty for the root): folders first, then files. */
  listDir: (id: string, path: string) => invoke<DirEntry[]>("list_dir", { id, path }),
  /** Every project file of the worktree (tracked and untracked, ignored excluded), sorted, for the file search. */
  listFiles: (id: string) => invoke<string[]>("list_files", { id }),
  /** Worktree-relative paths below `dir` that a commit of the checked-out history deleted, sorted. */
  listDeletedFiles: (id: string, dir: string) => invoke<string[]>("list_deleted_files", { id, dir }),
  /** Text content of a worktree file. */
  readFile: (id: string, path: string) => invoke<string>("read_file", { id, path }),
  /** `text` as the Prettier the worktree installs (with its config and plugins) formats the worktree file `path`. */
  formatWithPrettier: (id: string, path: string, text: string) => invoke<PrettierOutput>("format_with_prettier", { id, path, text }),
  /** The ESLint rules every `eslint.config.*` of the worktree sets, as the ESLint the worktree installs reads them. */
  readLintRules: (id: string) => invoke<LintRules>("read_lint_rules", { id }),
  /** Worktree files containing `word` as a whole word (tracked and untracked, never ignored). */
  searchWord: (id: string, word: string) => invoke<string[]>("search_word", { id, word }),
  /**
   * Lines of worktree files matching `query` (tracked and untracked, never ignored or binary); empty once a search of
   * the same worktree issued after this one is in progress.
   */
  findInFiles: (id: string, query: TextQuery) =>
    invoke<TextSearchResult>("find_in_files", { id, query, issuedAt: performance.timeOrigin + performance.now() }),
  /**
   * Replaces the matches of `query` with its `replacement`: those on `lines`, or without them every match in the files
   * the mask takes. Files open in an editor change there and stay unsaved if they were.
   */
  replaceInFiles: (id: string, query: TextQuery, lines?: FileLine[]) => invoke<ReplaceResult>("replace_in_files", { id, query, lines: lines ?? null }),
  /** Worktree paths the relative import specifiers of `from` point at; `null` where no file matches. */
  resolveImports: (id: string, from: string, specifiers: string[]) =>
    invoke<(string | null)[]>("resolve_imports", { id, from, specifiers }),
  /**
   * JSON-RPC request to the worktree's `server` (started on first use); resolves with the result. `token` names the
   * request for `lspCancel`. The Angular server rejects in worktrees without `@angular/language-service`.
   */
  lspRequest: (id: string, method: string, params: unknown, token?: string, server: LanguageServerKind = "typescript") =>
    invoke<unknown>("lsp_request", { id, method, params, token: token ?? null, server }),
  /** Cancels the pending request sent to `server` with `token`; unknown tokens are ignored. */
  lspCancel: (id: string, token: string, server: LanguageServerKind = "typescript") => invoke<void>("lsp_cancel", { id, token, server }),
  /**
   * Loads `path` into this window: the shared document with the unsaved edits of other windows, read from disk when no
   * window holds it yet. Calling it again re-reads the shared state.
   */
  documentOpen: (id: string, path: string, languageId: string) => invoke<DocumentState>("document_open", { id, path, languageId }),
  /** Applies this window's `changes` made against `baseVersion`; null when the document moved on since. */
  documentEdit: (id: string, path: string, baseVersion: number, changes: DocumentContentChange[]) =>
    invoke<DocumentEditAck | null>("document_edit", { id, path, baseVersion, changes }),
  /** Writes the shared text to disk; resolves with whether edits made meanwhile keep it dirty. */
  documentSave: (id: string, path: string) => invoke<boolean>("document_save", { id, path }),
  /** Takes the content on disk over for every one of `paths` without unsaved edits. */
  documentReload: (id: string, paths: string[]) => invoke<void>("document_reload", { id, paths }),
  documentRevert: (id: string, path: string) => invoke<void>("document_revert", { id, path }),
  /** Records that the file on disk holds `text` now; resolves with whether the document is still dirty. */
  documentMarkSaved: (id: string, path: string, text: string) => invoke<boolean>("document_mark_saved", { id, path, text }),
  /** Drops this window's hold on `path`; the last window closes the document. */
  documentClose: (id: string, path: string) => invoke<void>("document_close", { id, path }),
  /** The paths of the session's worktree whose shared documents hold unsaved edits, sorted. */
  dirtyDocuments: (id: string) => invoke<string[]>("dirty_documents", { id }),
};
