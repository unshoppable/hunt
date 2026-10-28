/**
 * The live file sync that `sync-helper.main.ts` runs on a session VM: it watches (with non-recursive `fs.watch`) the
 * worktree and every folder Git does not ignore, reports the files that change there and applies the client's writes,
 * links and deletions (`sync-protocol.types.ts`). It ignores `.git` and `.hunt` except for Git's ignore rules
 * (`.git/info/exclude`, the global excludes file) and HEAD (`.git/HEAD`, `.git/logs/HEAD`).
 */
import { readdirSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname, join } from "node:path";
import { messageOf } from "../../../../libs/domain/src/shared/errors.utils.ts";
import { EchoFilter } from "./echo-filter.domain.ts";
import { fileStateOf, inspect, readLinkTarget, readRegularFile } from "./file-state.utils.ts";
import { INLINE_DATA_MAX_BYTES, type AckEntry, type ApplyRequest, type FileReport, type HelperMessage } from "./sync-protocol.types.ts";
import { changeMessages, parseRequest } from "./sync-protocol.utils.ts";
import { childOf, foldersOf, isAtOrBelow, isIgnoreFile, isSkipped } from "./worktree-paths.utils.ts";
import { applyDelete, applyLink, applyWrite, excludesFileOf, gitDirOf, gitPathOf, ignoredAmong, listFiles } from "./worktree.utils.ts";

/** How long changes are collected before they are reported together. */
const BATCH_MS = 20;
/** More changed paths than this in one batch make the client sync by listing instead. */
const MAX_BATCH_PATHS = 10_000;
/** More inline content than this in one batch make the client sync by listing instead. */
const MAX_BATCH_DATA_BYTES = 64 * 1024 * 1024;
/** The inline content of one `changes` message, which holds at least one file. */
const MESSAGE_DATA_BYTES = 4 * 1024 * 1024;

/** What a change in one of Git's own folders means. */
type GitFileRole = "rules" | "head";

export interface HelperOutput {
  send(message: HelperMessage): void;
  /** Whether the client fell behind reading what was sent; the helper's `onCaughtUp` is called once it caught up. */
  isBehind(): boolean;
}

interface FolderWatch {
  watcher: FSWatcher;
  /** The watched folder's inode, which tells a folder replaced under the same name. */
  inode: bigint;
}

export class SyncHelper {
  private readonly root: string;
  private readonly output: HelperOutput;
  private readonly log: (message: string) => void;
  /** The files Git lists, which the client syncs. */
  private listed = new Set<string>();
  /** The files reported as ignored (`listed: false`) that still exist. */
  private readonly ignored = new Set<string>();
  /** Watches of the worktree's folders by relative path. */
  private readonly watches = new Map<string, FolderWatch>();
  /** Watches of folders outside the worktree's own (Git's folder, the global excludes file's) by absolute path. */
  private readonly gitWatches = new Map<string, { watcher: FSWatcher; names: Map<string, GitFileRole> }>();
  /** Folders of `gitWatches` that do not exist yet, such as `.git/logs` before the first commit. */
  private missingGitFolders = new Set<string>();
  private readonly echo = EchoFilter.start();
  private pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Why the next batch re-lists the worktree and asks for a full sync instead of reporting changes. */
  private relistReason: string | null = null;
  /** Why the next batch asks for a full sync after its changes, such as a folder that could not be watched. */
  private resyncReason: string | null = null;
  private headMoved = false;
  private batchDataBytes = 0;

  constructor(root: string, output: HelperOutput, log: (message: string) => void) {
    this.root = root;
    this.output = output;
    this.log = log;
  }

  /** Lists the worktree, sets every watch and reports `ready`; throws when Git cannot list the worktree. */
  start(): void {
    this.relist();
    this.output.send({ t: "ready" });
    if (this.resyncReason) {
      this.schedule();
    }
  }

  /** Handles one line from the client. */
  handleLine(line: string): void {
    const parsed = parseRequest(line);
    if ("error" in parsed) {
      this.output.send({ t: "error", message: parsed.error });
      return;
    }
    for (const problem of parsed.problems) {
      this.output.send({ t: "error", message: problem });
    }
    this.apply(parsed.request);
  }

  /** The client read everything it fell behind on: it gets a full sync, since reports were dropped meanwhile. */
  onCaughtUp(): void {
    this.relistReason ??= "the client did not keep up with the changes";
    this.schedule();
  }

  private apply(request: ApplyRequest): void {
    const files: AckEntry[] = [];
    const settle = (path: string, error: string | null) => {
      if (error) {
        this.output.send({ t: "error", message: error });
      }
      const state = this.stateForAck(path);
      this.echo.record(path, state);
      files.push({ path, state });
    };
    for (const write of request.writes) {
      settle(write.path, applyWrite(this.root, write));
    }
    for (const link of request.links) {
      settle(link.path, applyLink(this.root, link));
    }
    for (const path of request.deletes) {
      settle(path, applyDelete(this.root, path));
    }
    this.output.send({ t: "ack", id: request.id, files });
  }

  private stateForAck(path: string) {
    try {
      return fileStateOf(join(this.root, path));
    } catch (error) {
      this.log(messageOf(error));
      return null;
    }
  }

  private schedule(): void {
    this.timer ??= setTimeout(() => this.flush(), BATCH_MS);
  }

  private onWorktreeEvent(folder: string, name: string | null): void {
    if (!name) {
      this.relistReason ??= `a change in ${folder || "the worktree"} came without a file name`;
      this.schedule();
      return;
    }
    const path = childOf(folder, name);
    if (isSkipped(path)) return;
    if (isIgnoreFile(path)) {
      this.relistReason ??= `${path} changed`;
    }
    this.pending.add(path);
    if (this.pending.size > MAX_BATCH_PATHS) {
      this.relistReason ??= `more than ${MAX_BATCH_PATHS} paths changed at once`;
      this.pending.clear();
    }
    this.schedule();
  }

  private onGitEvent(folder: string, name: string | null): void {
    const entry = this.gitWatches.get(folder);
    const role = name ? entry?.names.get(name) : undefined;
    if (role === "rules") {
      this.relistReason ??= `${join(folder, name ?? "")} changed`;
    } else if (role === "head") {
      this.headMoved = true;
    } else if (name && this.missingGitFolders.has(join(folder, name))) {
      // A missing folder such as `.git/logs` appeared; watching it starts with a move of HEAD.
      this.watchGitFolders();
      this.headMoved = true;
    } else {
      return;
    }
    this.schedule();
  }

  /** Adds a watch of `folder`; a folder that vanished meanwhile is skipped, any other failure asks for a full sync. */
  private watchFolder(folder: string): void {
    if (this.watches.has(folder)) return;
    try {
      const entry = inspect(join(this.root, folder));
      if (entry.kind !== "folder") return;
      const watcher = watch(join(this.root, folder), (_event, name) => this.onWorktreeEvent(folder, name));
      watcher.on("error", (error) => this.onWatchError(folder, error));
      this.watches.set(folder, { watcher, inode: entry.inode });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return;
      this.resyncReason ??= `failed to watch ${folder || "the worktree"}: ${messageOf(error)}`;
    }
  }

  /** A watch that failed on a folder that still exists asks for a full sync; one whose folder is gone reports it. */
  private onWatchError(folder: string, error: Error): void {
    const watched = this.watches.get(folder);
    let entry;
    try {
      entry = inspect(join(this.root, folder));
    } catch {
      entry = null;
    }
    if (entry?.kind === "folder" && entry.inode === watched?.inode) {
      this.unwatchFolder(folder);
      this.resyncReason ??= `the watch of ${folder || "the worktree"} failed: ${error.message}`;
    } else {
      this.pending.add(folder);
    }
    this.schedule();
  }

  private unwatchFolder(folder: string): void {
    this.watches.get(folder)?.watcher.close();
    this.watches.delete(folder);
  }

  /**
   * The folders below `starts` (included) that Git does not ignore, found by reading folder after folder. A folder of
   * `known` leads to a listed file and is taken without asking Git; the others are checked in one batch per level.
   */
  private discoverFolders(starts: string[], known: Set<string>): string[] {
    const found: string[] = [];
    let level = starts;
    while (level.length) {
      found.push(...level);
      const next: string[] = [];
      const unknown: string[] = [];
      for (const folder of level) {
        for (const child of this.subfoldersOf(folder)) {
          if (known.has(child)) {
            next.push(child);
          } else {
            unknown.push(child);
          }
        }
      }
      const ignored = ignoredAmong(this.root, unknown);
      next.push(...unknown.filter((folder) => !ignored.has(folder)));
      level = next;
    }
    return found;
  }

  private subfoldersOf(folder: string): string[] {
    try {
      return readdirFolders(join(this.root, folder))
        .map((name) => childOf(folder, name))
        .filter((path) => !isSkipped(path));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        this.log(`failed to read ${folder || "the worktree"}: ${messageOf(error)}`);
      }
      return [];
    }
  }

  /** Re-lists the worktree, watches exactly the folders Git does not ignore and refreshes the watches of Git's files. */
  private relist(): void {
    const paths = listFiles(this.root);
    this.listed = new Set(paths);
    for (const path of this.ignored) {
      if (this.listed.has(path)) {
        this.ignored.delete(path);
      }
    }
    const folders = new Set(this.discoverFolders([""], foldersOf(paths)));
    for (const folder of [...this.watches.keys()]) {
      if (!folders.has(folder)) {
        this.unwatchFolder(folder);
      }
    }
    for (const folder of folders) {
      this.watchFolder(folder);
    }
    this.watchGitFolders();
  }

  /** The folders of Git's ignore files and HEAD, each with the names in it that matter. */
  private wantedGitFolders(): Map<string, Map<string, GitFileRole>> {
    const gitDir = gitDirOf(this.root);
    const files: [string, GitFileRole][] = [
      [gitPathOf(this.root, "info/exclude"), "rules"],
      [excludesFileOf(this.root), "rules"],
      [join(gitDir, "HEAD"), "head"],
      [join(gitDir, "logs", "HEAD"), "head"],
    ];
    const folders = new Map<string, Map<string, GitFileRole>>();
    for (const [file, role] of files) {
      const folder = dirname(file);
      const names = folders.get(folder) ?? new Map<string, GitFileRole>();
      names.set(basename(file), role);
      folders.set(folder, names);
    }
    return folders;
  }

  private watchGitFolders(): void {
    let wanted: Map<string, Map<string, GitFileRole>>;
    try {
      wanted = this.wantedGitFolders();
    } catch (error) {
      this.resyncReason ??= messageOf(error);
      return;
    }
    for (const [folder, entry] of [...this.gitWatches]) {
      if (!wanted.has(folder)) {
        entry.watcher.close();
        this.gitWatches.delete(folder);
      }
    }
    this.missingGitFolders = new Set();
    for (const [folder, names] of wanted) {
      const existing = this.gitWatches.get(folder);
      if (existing) {
        existing.names = names;
        continue;
      }
      try {
        const watcher = watch(folder, (_event, name) => this.onGitEvent(folder, name));
        watcher.on("error", () => {
          watcher.close();
          this.gitWatches.delete(folder);
        });
        this.gitWatches.set(folder, { watcher, names });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") {
          this.missingGitFolders.add(folder);
          continue;
        }
        this.resyncReason ??= `failed to watch ${folder}: ${messageOf(error)}`;
      }
    }
  }

  private flush(): void {
    this.timer = null;
    const paths = this.pending;
    this.pending = new Set();
    if (this.output.isBehind()) return;
    if (!this.relistReason) {
      this.reportChanges(paths);
    }
    if (this.headMoved) {
      this.headMoved = false;
      this.output.send({ t: "head" });
    }
    const relistReason = this.relistReason;
    if (relistReason) {
      this.relistReason = null;
      this.resyncReason = null;
      try {
        this.relist();
      } catch (error) {
        this.log(messageOf(error));
      }
      this.output.send({ t: "resync", reason: this.resyncReason ? `${relistReason}; ${this.resyncReason}` : relistReason });
      this.resyncReason = null;
    } else if (this.resyncReason) {
      this.output.send({ t: "resync", reason: this.resyncReason });
      this.resyncReason = null;
    }
  }

  /** Reports the changes at `paths`; when the batch holds too much content it asks for a full sync instead. */
  private reportChanges(paths: Set<string>): void {
    const reports = new Map<string, FileReport>();
    const unknownFiles: string[] = [];
    const newFolders: string[] = [];
    this.batchDataBytes = 0;
    try {
      for (const path of paths) {
        this.inspectPath(path, reports, unknownFiles, newFolders);
      }
      const ignored = ignoredAmong(this.root, [...unknownFiles, ...newFolders]);
      for (const path of unknownFiles) {
        if (ignored.has(path)) {
          this.reportIgnored(path, reports);
        } else {
          this.listed.add(path);
          this.reportListed(path, reports);
        }
      }
      const added = newFolders.filter((folder) => !ignored.has(folder));
      if (added.length) {
        for (const folder of this.discoverFolders(added, new Set())) {
          this.watchFolder(folder);
        }
        for (const path of listFiles(this.root, added)) {
          if (reports.has(path) || isSkipped(path)) continue;
          this.listed.add(path);
          this.reportListed(path, reports);
        }
      }
    } catch (error) {
      this.log(messageOf(error));
      this.relistReason ??= messageOf(error);
      return;
    }
    if (this.batchDataBytes > MAX_BATCH_DATA_BYTES) {
      this.relistReason ??= `more than ${MAX_BATCH_DATA_BYTES / 1024 / 1024} MiB changed at once`;
      return;
    }
    const files = [...reports.values()].filter((report) => !this.echo.isEcho(report.path, report.state));
    for (const message of changeMessages(files, MESSAGE_DATA_BYTES)) {
      this.output.send(message);
    }
  }

  /** Sorts one changed path into a report, a file Git has to classify or a folder that appeared. */
  private inspectPath(path: string, reports: Map<string, FileReport>, unknownFiles: string[], newFolders: string[]): void {
    const entry = inspect(join(this.root, path));
    const watched = this.watches.get(path);
    if (watched && (entry.kind !== "folder" || entry.inode !== watched.inode)) {
      this.folderGone(path, reports);
    }
    if (entry.kind === "missing" || entry.kind === "folder") {
      if (this.listed.delete(path)) {
        reports.set(path, { path, state: null, listed: true });
      } else if (this.ignored.delete(path)) {
        reports.set(path, { path, state: null, listed: false });
      }
      if (entry.kind === "folder" && !this.watches.has(path)) {
        newFolders.push(path);
      }
      return;
    }
    if (entry.kind === "other") return;
    if (this.listed.has(path)) {
      this.reportListed(path, reports);
    } else if (!this.ignored.has(path)) {
      unknownFiles.push(path);
    }
  }

  /** A watched folder is gone: every listed or ignored file below it is reported gone and its watches end. */
  private folderGone(folder: string, reports: Map<string, FileReport>): void {
    for (const watched of [...this.watches.keys()]) {
      if (isAtOrBelow(watched, folder)) {
        this.unwatchFolder(watched);
      }
    }
    for (const [set, listed] of [[this.listed, true], [this.ignored, false]] as const) {
      for (const path of [...set]) {
        if (path === folder || !isAtOrBelow(path, folder)) continue;
        set.delete(path);
        reports.set(path, { path, state: null, listed });
      }
    }
  }

  private reportIgnored(path: string, reports: Map<string, FileReport>): void {
    const state = fileStateOf(join(this.root, path));
    if (!state) return;
    this.ignored.add(path);
    reports.set(path, { path, state, listed: false });
  }

  /** Reports a listed file with its content or link target; a file that changes while it is read is read again later. */
  private reportListed(path: string, reports: Map<string, FileReport>): void {
    const absolute = join(this.root, path);
    const entry = inspect(absolute);
    if (entry.kind === "missing" || entry.kind === "folder") {
      this.listed.delete(path);
      reports.set(path, { path, state: null, listed: true });
      return;
    }
    if (entry.kind === "other" || this.echo.isEcho(path, entry.state)) return;
    if (entry.kind === "link") {
      const target = readLinkTarget(absolute);
      if (target === null) {
        this.requeue(path);
        return;
      }
      reports.set(path, { path, state: entry.state, listed: true, target });
      return;
    }
    if (entry.state.size > INLINE_DATA_MAX_BYTES) {
      reports.set(path, { path, state: entry.state, listed: true });
      return;
    }
    const file = readRegularFile(absolute);
    if (!file || file.data.length !== file.state.size || file.state.size > INLINE_DATA_MAX_BYTES) {
      this.requeue(path);
      return;
    }
    this.batchDataBytes += file.data.length;
    reports.set(path, { path, state: file.state, listed: true, data: file.data.toString("base64") });
  }

  private requeue(path: string): void {
    this.pending.add(path);
    this.schedule();
  }
}

/** The names of the real folders in `absolute`, links to folders excluded. */
function readdirFolders(absolute: string): string[] {
  return readdirSync(absolute, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}
