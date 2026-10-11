import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type {
  ChangeStat,
  ChangedFileView,
  DirEntry,
  FileDiff,
  GithubViewer,
  GraphStatus,
  PullRequest,
  PullRequestDetails,
  PullRequestRef,
  ReviewComment,
  ReviewEvent,
  Screenshot,
  SelectionContext,
  SessionNotification,
  SessionView,
  Shelf,
} from "./types";

/** URL under which the webview loads the file at the absolute `path`. */
export function assetUrl(path: string): string {
  return convertFileSrc(path);
}

export const commands = {
  listSessions: () => invoke<SessionView[]>("list_sessions"),
  listBranches: (repoPath: string) => invoke<string[]>("list_branches", { repoPath }),
  /** Open pull requests of the repository's GitHub remote, newest first; needs the `gh` CLI to be installed and logged in. */
  listPullRequests: (repoPath: string) => invoke<PullRequest[]>("list_pull_requests", { repoPath }),
  /** The GitHub account `gh` is logged in as for the repository's host; rejects when `gh` is missing or logged out. */
  githubViewer: (repoPath: string) => invoke<GithubViewer>("github_viewer", { repoPath }),
  /** Description and conversation of the pull request the session reviews; rejects when it reviews none. */
  viewPullRequest: (sessionId: string) => invoke<PullRequestDetails>("view_pull_request", { sessionId }),
  /** Submits a review of the pull request the session reviews; `body` is its summary comment. */
  submitPullRequestReview: (sessionId: string, event: ReviewEvent, body: string) =>
    invoke<void>("submit_pull_request_review", { id: sessionId, event, body }),
  /** Drafts a review comment on lines `startLine..line` of the new version of `path`; it goes out with the next review. */
  addReviewComment: (sessionId: string, path: string, startLine: number, line: number, body: string) =>
    invoke<ReviewComment>("add_review_comment", { id: sessionId, path, startLine, line, body }),
  updateReviewComment: (sessionId: string, commentId: string, body: string) => invoke<void>("update_review_comment", { id: sessionId, commentId, body }),
  deleteReviewComment: (sessionId: string, commentId: string) => invoke<void>("delete_review_comment", { id: sessionId, commentId }),
  /**
   * Creates the session `id` (a fresh UUID the caller picked) in a new worktree off `baseRef`. `pullRequest` marks it as
   * that pull request's review and `diffBaseRef` is then the pull request's target branch, whose merge base with
   * `baseRef` becomes the diff base.
   */
  createSession: (id: string, repoPath: string, baseRef: string, title: string, pullRequest: PullRequestRef | null, diffBaseRef: string | null) =>
    invoke<SessionView>("create_session", { id, repoPath, baseRef, title, pullRequest, diffBaseRef }),
  /** Starts the sub session `id` (a fresh UUID the caller picked) in the parent's worktree; a `selection` (sub chat from the diff) goes into the agent's context. */
  createSubSession: (id: string, parentId: string, title: string, selection: SelectionContext | null) =>
    invoke<SessionView>("create_sub_session", { id, parentId, title, selection }),
  openSession: (id: string) => invoke<SessionView>("open_session", { id }),
  closeSession: (id: string, removeWorktree: boolean) => invoke<void>("close_session", { id, removeWorktree }),
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
  /** Language (English name, e.g. `German`) of the agent output Hunt asks for itself: diagram labels, summaries, titles. */
  setAiLanguage: (language: string) => invoke<void>("set_ai_language", { language }),
  /** Every image in the macOS screenshot folder, newest first. */
  listScreenshots: () => invoke<Screenshot[]>("list_screenshots"),
  openWorktreeInWebstorm: (id: string) => invoke<void>("open_worktree_in_webstorm", { id }),
  /** Opens a worktree file in WebStorm with the caret on `line`:`column` (1-based). */
  openFileInWebstorm: (id: string, path: string, line: number, column: number) =>
    invoke<void>("open_file_in_webstorm", { id, path, line, column }),
  openChangedFilesDiffInWebstorm: (id: string) => invoke<void>("open_changed_files_diff_in_webstorm", { id }),
  /** Raw content of the session's `.hunt/graph.json`, `null` while there is none; validate with `parseGraph`. */
  readGraph: (id: string) => invoke<unknown>("read_graph", { id }),
  /** When the diagram was generated and whether the worktree's sessions changed files since. */
  graphStatus: (id: string) => invoke<GraphStatus>("graph_status", { id }),
  /** Sends the standard diagram prompt as a hidden turn and resolves with the stop reason once the agent finished. */
  refreshGraph: (id: string) => invoke<string>("refresh_graph", { id }),
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
