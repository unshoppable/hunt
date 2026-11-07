import { defaultLogFilter, LOG_PAGE_SIZE } from "../git/GitPanel";
import type { Commit, GitScope } from "../git/git.types";
import { commands } from "../ipc/commands";
import { useSessionViewStore, type GitLogFilter } from "../sessions/inspector.store";
import type { SessionView } from "../sessions/session.types";
import { commitEntry, commitsStartingWith, describeLogFilter, logEntry, refsSummary } from "./git-commands.utils";
import type { GitAction } from "./tab-commands.utils";

/** How many of the newest commits of the filtered log `hunt-client git` lists. */
const STATE_LOG_LIMIT = 30;

/**
 * Runs `action` on the Git tab of `session` and shows that tab; without an action resolves to the tab's state, as
 * `hunt-client git` prints it. A new filter selects its newest commit and a new commit drops the selected file, as the tab does.
 */
export async function runGitCommand(session: SessionView, action: GitAction | undefined): Promise<unknown> {
  if (!session.hasLocalWorktree) throw new Error("the session has no local worktree");
  if (!action) return readGitState(session);
  const scope: GitScope = { kind: "session", id: session.id };
  const { views, updateView, setTab } = useSessionViewStore.getState();
  const view = views[session.id];
  const filter = view?.gitFilter ?? defaultLogFilter(session.branch);
  switch (action.name) {
    case "filter": {
      const gitFilter = { reference: action.reference ?? filter.reference, text: action.text ?? filter.text };
      if (gitFilter.reference === filter.reference && gitFilter.text === filter.text) break;
      const [newest] = await commands.gitLog(scope, { ...gitFilter, skip: 0, limit: 1 });
      updateView(session.id, { gitFilter, gitCommit: newest?.id ?? null, gitFile: null });
      break;
    }
    case "select": {
      const gitCommit = action.commit === null ? null : (await logCommit(scope, filter, action.commit)).id;
      if (gitCommit !== (view?.gitCommit ?? null)) {
        updateView(session.id, { gitCommit, gitFile: null });
      }
      break;
    }
    case "selectFile": {
      const commit = view?.gitCommit;
      if (!commit) throw new Error("no commit is selected; select one first");
      if (action.path) {
        const details = await commands.gitCommit(scope, commit);
        if (!details.files.some((file) => file.path === action.path)) throw new Error(`commit ${commit.slice(0, 8)} changed no file ${action.path}`);
      }
      updateView(session.id, { gitFile: action.path });
      break;
    }
  }
  setTab(session.id, "git");
}

/** The commit whose hash starts with `sha` in the first page of the log the tab loads for `filter`, which holds every commit it can select. */
async function logCommit(scope: GitScope, filter: GitLogFilter, sha: string): Promise<Commit> {
  const page = await commands.gitLog(scope, { ...filter, skip: 0, limit: LOG_PAGE_SIZE });
  const matches = commitsStartingWith(page, sha);
  if (matches.length > 1) throw new Error(`${sha} starts the hash of ${matches.length} commits; give more of it`);
  if (!matches[0]) throw new Error(`no commit ${sha} among the newest ${LOG_PAGE_SIZE} commits of ${describeLogFilter(filter)}; change the filter first`);
  return matches[0];
}

/**
 * The Git tab of `session`: the checked-out branch, the session's branch, the branches and tags, the log filter, the
 * newest commits of the filtered log, the selected commit with its files and the selected file of it.
 */
async function readGitState(session: SessionView) {
  const scope: GitScope = { kind: "session", id: session.id };
  const view = useSessionViewStore.getState().views[session.id];
  const filter = view?.gitFilter ?? defaultLogFilter(session.branch);
  const commit = view?.gitCommit ?? null;
  const [refs, log, details] = await Promise.all([
    commands.gitRefs(scope),
    commands.gitLog(scope, { ...filter, skip: 0, limit: STATE_LOG_LIMIT }),
    commit ? commands.gitCommit(scope, commit) : null,
  ]);
  return {
    head: refs.head,
    branch: session.branch,
    refs: refsSummary(refs),
    filter,
    log: log.map(logEntry),
    commit: details ? commitEntry(details) : null,
    file: (commit && view?.gitFile) || null,
  };
}
