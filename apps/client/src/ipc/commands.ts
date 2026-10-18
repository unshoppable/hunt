import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { ChangedFileView, ChangeStat, ClaudeAccounts, DiagramType, DirEntry, FileDiff, FileVersion, GithubTokenStatus, GithubViewer, GraphStatus, PlanUsage, PreviewStatus, PullRequest, PullRequestDetails, PullRequestRef, PullRequestState, RemoteLink, RemoteSecretSummary, ReplyTarget, ReviewComment, ReviewEvent, ReviewThread, Screenshot, SelectionContext, SessionEnding, SessionNotification, SessionView, SessionVm, Shelf, TerminalTarget, TmuxWindow, VmSettings, Workspace } from "./types";

/** URL under which the webview loads the file at the absolute `path`. */
export function assetUrl(path: string): string {
  return convertFileSrc(path);
}

export const commands = {
  listSessions: () => invoke<SessionView[]>("list_sessions"),
  listBranches: (repoPath: string) => invoke<string[]>("list_branches", { repoPath }),
  /** The branch the repository's checkout is on; `HEAD` when it is detached. */
  currentBranch: (repoPath: string) => invoke<string>("current_branch", { repoPath }),
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
   * 0 (`FILE_SPAN`); it goes out with the next review. With `replyTo` it answers a thread or draft, and `path` and the
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
    workspace: Workspace,
  ) =>
    invoke<SessionView>("create_session", { id, repoPath, baseRef, title, pullRequest, diffBaseRef, pullRequestBranch, workspace }),
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
   * Opens a terminal with `cols` × `rows` cells showing `process` on the VM of the remote session `id`. The caller picks
   * `terminalId` and listens before it calls, since the output (`terminal:output`, then `terminal:exit`, both sent to
   * this window only) may arrive before the promise resolves. A VM that is off stays off.
   */
  openTerminal: (id: string, terminalId: string, process: TerminalTarget, cols: number, rows: number) =>
    invoke<void>("open_terminal", { id, terminalId, process, cols, rows }),
  /** Types `data`, base64 of the input bytes, into the terminal. */
  writeTerminal: (terminalId: string, data: string) => invoke<void>("write_terminal", { terminalId, data }),
  resizeTerminal: (terminalId: string, cols: number, rows: number) => invoke<void>("resize_terminal", { terminalId, cols, rows }),
  /** Ends the terminal; the process it shows keeps running. Closing a terminal that is not open does nothing. */
  closeTerminal: (terminalId: string) => invoke<void>("close_terminal", { terminalId }),
  /** The windows of the tmux session `app` on the VM of the remote session `id`; none while the VM is off. */
  terminalWindows: (id: string) => invoke<TmuxWindow[]>("terminal_windows", { id }),
  /** Starts a shell in a new tmux window on the VM of the remote session `id` and resolves to the window's ID. */
  openShellWindow: (id: string) => invoke<string>("open_shell_window", { id }),
  /** Ends the tmux window `windowId` on the VM of the remote session `id` and the processes in it. */
  closeTerminalWindow: (id: string, windowId: string) => invoke<void>("close_terminal_window", { id, windowId }),
  closeSession: (id: string, ending: SessionEnding) => invoke<void>("close_session", { id, ending }),
  /** Prepares the worktree's `node_modules` again after a failed attempt; progress arrives through `sessions:changed`. */
  prepareDependencies: (id: string) => invoke<void>("prepare_dependencies", { id }),
  /** Sends the text plus the image files at `images` (absolute paths) as one user turn. */
  sendPrompt: (id: string, text: string, images: string[]) => invoke<string>("send_prompt", { id, text, images }),
  sessionHistory: (id: string) => invoke<SessionNotification[]>("session_history", { id }),
  cancelPrompt: (id: string) => invoke<void>("cancel_prompt", { id }),
  setSessionMode: (id: string, modeId: string) => invoke<void>("set_session_mode", { id, modeId }),
  setSessionConfigOption: (id: string, configId: string, value: string) =>
    invoke<void>("set_session_config_option", { id, configId, value }),
  answerPermission: (requestId: string, optionId: string) => invoke<void>("answer_permission", { requestId, optionId }),
  listChangedFiles: (id: string) => invoke<ChangedFileView[]>("list_changed_files", { id }),
  /** Added and removed line counts of every uncommitted change, sorted by path. */
  changeStats: (id: string) => invoke<ChangeStat[]>("change_stats", { id }),
  readFileDiff: (id: string, path: string) => invoke<FileDiff>("read_file_diff", { id, path }),
  /** Versions of `path` in the edit log of the session's worktree, oldest first. */
  readFileHistory: (id: string, path: string) => invoke<FileVersion[]>("read_file_history", { id, path }),
  writeFile: (id: string, path: string, content: string) => invoke<void>("write_file", { id, path, content }),
  revertFile: (id: string, path: string) => invoke<void>("revert_file", { id, path }),
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
   * Pushes the session's commits to the branch it was created from on `origin` (`pushTarget` in `chat/remoteSession.ts`),
   * rebased onto it first when it moved on; the session's own branch never reaches `origin`.
   */
  pushBranch: (id: string) => invoke<void>("push_branch", { id }),
  /** Number of commits `pushBranch` would publish; 0 when they are on `origin` already. */
  unpushedCommitCount: (id: string) => invoke<number>("unpushed_commit_count", { id }),
  /** Language (English name, e.g. `German`) of the agent output Hunt asks for itself: diagram labels, summaries, titles. */
  setAiLanguage: (language: string) => invoke<void>("set_ai_language", { language }),
  /** System prompt addition for every agent session started afterwards; empty switches it off. */
  setSystemPrompt: (prompt: string) => invoke<void>("set_system_prompt", { prompt }),
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
  openChangedFilesDiffInWebstorm: (id: string) => invoke<void>("open_changed_files_diff_in_webstorm", { id }),
  /** Raw content of the session's diagram file of `diagramType`, `null` while there is none; validate with `parseGraph` or `parseShapeDiagram`. */
  readGraph: (id: string, diagramType: DiagramType) => invoke<unknown>("read_graph", { id, diagramType }),
  /** Writes the whole diagram file of `diagramType` after an edit in the Architecture tab; `content` comes from `serializeShapeDiagram`. */
  writeGraph: (id: string, diagramType: DiagramType, content: string) => invoke<void>("write_graph", { id, diagramType, content }),
  /** When the diagram of `diagramType` was generated and whether the worktree's sessions changed files since. */
  graphStatus: (id: string, diagramType: DiagramType) => invoke<GraphStatus>("graph_status", { id, diagramType }),
  /**
   * Sends the standard prompt of `diagramType` as a hidden turn, with `instructions` appended for this run, and resolves
   * with the stop reason once the agent finished.
   */
  refreshGraph: (id: string, diagramType: DiagramType, instructions: string, model: string, effort: string) =>
    invoke<string>("refresh_graph", { id, diagramType, instructions, model, effort }),
  /** Entries of a worktree directory (`path` relative, empty for the root): folders first, then files. */
  listDir: (id: string, path: string) => invoke<DirEntry[]>("list_dir", { id, path }),
  /** Every project file of the worktree (tracked and untracked, ignored excluded), sorted, for the file search. */
  listFiles: (id: string) => invoke<string[]>("list_files", { id }),
  /** Text content of a worktree file. */
  readFile: (id: string, path: string) => invoke<string>("read_file", { id, path }),
  /** Worktree files containing `word` as a whole word (tracked and untracked, never ignored). */
  searchWord: (id: string, word: string) => invoke<string[]>("search_word", { id, word }),
  /** Worktree paths the relative import specifiers of `from` point at; `null` where no file matches. */
  resolveImports: (id: string, from: string, specifiers: string[]) =>
    invoke<(string | null)[]>("resolve_imports", { id, from, specifiers }),
  /**
   * JSON-RPC request to the worktree's TypeScript language server (started on first use); resolves with the
   * result. `token` names the request for `lspCancel`.
   */
  lspRequest: (id: string, method: string, params: unknown, token?: string) =>
    invoke<unknown>("lsp_request", { id, method, params, token: token ?? null }),
  /** JSON-RPC notification to the worktree's language server; resolves once it is written. */
  lspNotify: (id: string, method: string, params: unknown) => invoke<void>("lsp_notify", { id, method, params }),
  /** Cancels the pending language server request sent with `token`; unknown tokens are ignored. */
  lspCancel: (id: string, token: string) => invoke<void>("lsp_cancel", { id, token }),
};
