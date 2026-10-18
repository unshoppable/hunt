/**
 * The sync helper's access to the worktree: Git's listing and ignore rules, the state and content of a path, and the
 * writes, links and deletions the client applies. Errors are thrown as `failed to <verb> <what>: …`, except where a
 * function says it returns them.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { messageOf } from "../../../../libs/domain/src/errors.ts";
import { ancestorsOf, splitNul } from "./folders.ts";
import type { FileState, FileWrite, LinkWrite } from "./protocol.ts";

const GIT_MAX_BUFFER = 1024 * 1024 * 1024;
const FILE_MODE = 0o644;
const EXECUTABLE_MODE = 0o755;

/** Runs git in `root` and returns its stdout; `okStatuses` are the exit codes that count as success. */
function git(root: string, args: string[], input?: string, okStatuses: number[] = [0]): { status: number; stdout: string } {
  const result = spawnSync("git", ["-C", root, ...args], { input, encoding: "utf8", maxBuffer: GIT_MAX_BUFFER, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  if (result.error) throw new Error(`failed to run git ${args[0]}: ${result.error.message}`);
  if (result.status === null || !okStatuses.includes(result.status)) {
    throw new Error(`failed to run git ${args[0]}: ${result.stderr.trim() || `exit status ${result.status ?? result.signal}`}`);
  }
  return { status: result.status, stdout: result.stdout };
}

/** The files Git sees in the worktree, tracked and untracked but not ignored, optionally only those below `folders`. */
export function listFiles(root: string, folders: string[] = []): string[] {
  const pathspec = folders.length ? ["--", ...folders] : [];
  return splitNul(git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", ...pathspec]).stdout);
}

/** Which of `paths` (files or folders that exist) Git ignores; tracked files never count as ignored. */
export function ignoredAmong(root: string, paths: string[]): Set<string> {
  if (!paths.length) return new Set();
  const { stdout } = git(root, ["check-ignore", "-z", "--stdin"], `${paths.join("\0")}\0`, [0, 1]);
  return new Set(splitNul(stdout));
}

/** The absolute path of the worktree's Git folder. */
export function gitDirOf(root: string): string {
  return resolve(root, git(root, ["rev-parse", "--path-format=absolute", "--git-dir"]).stdout.trim());
}

/** The absolute path Git uses for `name` inside its folder, such as `info/exclude`, which lives in the common folder. */
export function gitPathOf(root: string, name: string): string {
  return resolve(root, git(root, ["rev-parse", "--path-format=absolute", "--git-path", name]).stdout.trim());
}

/** The global ignore file Git reads: `core.excludesFile`, else `$XDG_CONFIG_HOME/git/ignore` or `~/.config/git/ignore`. */
export function excludesFileOf(root: string): string {
  const { status, stdout } = git(root, ["config", "--path", "--get", "core.excludesFile"], undefined, [0, 1]);
  const configured = status === 0 ? stdout.trim() : "";
  if (configured) return isAbsolute(configured) ? configured : resolve(root, configured);
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "git", "ignore");
}

/** What is at a path: nothing, a folder, a file or link with its state, or something else such as a socket. */
export type Entry = { kind: "missing" } | { kind: "folder"; inode: bigint } | { kind: "file" | "link" | "other"; state: FileState };

function stateFrom(stats: BigIntStats): FileState {
  return { size: Number(stats.size), modifiedNs: stats.mtimeNs.toString(), executable: (stats.mode & 0o100n) !== 0n, link: stats.isSymbolicLink() };
}

function isVanished(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** The `lstat` of `absolute`. */
export function inspect(absolute: string): Entry {
  let stats: BigIntStats;
  try {
    stats = lstatSync(absolute, { bigint: true });
  } catch (error) {
    if (isVanished(error)) return { kind: "missing" };
    throw new Error(`failed to inspect ${absolute}: ${messageOf(error)}`, { cause: error });
  }
  if (stats.isDirectory()) return { kind: "folder", inode: stats.ino };
  const kind = stats.isFile() ? "file" : stats.isSymbolicLink() ? "link" : "other";
  return { kind, state: stateFrom(stats) };
}

/** The state of the file at `absolute` for an `ack`: null when no file is there, also when a folder is. */
export function fileStateOf(absolute: string): FileState | null {
  const entry = inspect(absolute);
  return entry.kind === "missing" || entry.kind === "folder" ? null : entry.state;
}

/** A regular file's state and content read through one descriptor; null when it is no regular file any more. */
export function readRegularFile(absolute: string): { state: FileState; data: Buffer } | null {
  let descriptor: number;
  try {
    descriptor = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (isVanished(error) || (error as NodeJS.ErrnoException).code === "ELOOP") return null;
    throw new Error(`failed to read ${absolute}: ${messageOf(error)}`, { cause: error });
  }
  try {
    const stats = fstatSync(descriptor, { bigint: true });
    if (!stats.isFile()) return null;
    return { state: stateFrom(stats), data: readFileSync(descriptor) };
  } finally {
    closeSync(descriptor);
  }
}

/** A link's target; null when it is no link any more. */
export function readLinkTarget(absolute: string): string | null {
  try {
    return readlinkSync(absolute);
  } catch (error) {
    if (isVanished(error) || (error as NodeJS.ErrnoException).code === "EINVAL") return null;
    throw new Error(`failed to read the link ${absolute}: ${messageOf(error)}`, { cause: error });
  }
}

/** The first folder above `path` that is a link, which a write below would follow out of the worktree; null for none. */
function linkAbove(root: string, path: string): string | null {
  for (const folder of ancestorsOf(path).reverse()) {
    const entry = inspect(join(root, folder));
    if (entry.kind === "missing") return null;
    if (entry.kind === "link") return folder;
  }
  return null;
}

let temporaryCounter = 0;

/** A fresh name for a temporary file next to `absolute`. */
function temporaryNextTo(absolute: string): string {
  temporaryCounter += 1;
  return join(dirname(absolute), `.hunt-sync-${process.pid}-${temporaryCounter}.tmp`);
}

/** Seconds since the epoch with the microseconds of `nanoseconds`, as `utimes` takes them. */
function secondsOf(nanoseconds: bigint): number {
  return Number(nanoseconds / 1000n) / 1e6;
}

/** Checks that `path` can be replaced by a file or link: no link above it, no folder at it. Returns the problem. */
function replaceProblem(root: string, path: string): string | null {
  const link = linkAbove(root, path);
  if (link) return `${link} is a link`;
  if (inspect(join(root, path)).kind === "folder") return "a folder is in the way";
  return null;
}

/** Writes a file through a temporary file and a rename, with its mode and modification time; returns the error. */
export function applyWrite(root: string, write: FileWrite): string | null {
  const absolute = join(root, write.path);
  let temporary = "";
  try {
    const problem = replaceProblem(root, write.path);
    if (problem) return `failed to write ${write.path}: ${problem}`;
    mkdirSync(dirname(absolute), { recursive: true });
    temporary = temporaryNextTo(absolute);
    const mode = write.executable ? EXECUTABLE_MODE : FILE_MODE;
    writeFileSync(temporary, write.data, { mode, flag: "wx" });
    chmodSync(temporary, mode);
    const seconds = secondsOf(write.modifiedNs);
    utimesSync(temporary, seconds, seconds);
    renameSync(temporary, absolute);
    return null;
  } catch (error) {
    if (temporary) {
      rmSync(temporary, { force: true });
    }
    return `failed to write ${write.path}: ${messageOf(error)}`;
  }
}

/** Replaces whatever file or link is at the path by a symbolic link with its own modification time; returns the error. */
export function applyLink(root: string, link: LinkWrite): string | null {
  const absolute = join(root, link.path);
  let temporary = "";
  try {
    const problem = replaceProblem(root, link.path);
    if (problem) return `failed to link ${link.path}: ${problem}`;
    mkdirSync(dirname(absolute), { recursive: true });
    temporary = temporaryNextTo(absolute);
    symlinkSync(link.target, temporary);
    const seconds = secondsOf(link.modifiedNs);
    try {
      lutimesSync(temporary, seconds, seconds);
    } catch {
      // A file system without link times keeps the time of creation.
    }
    renameSync(temporary, absolute);
    return null;
  } catch (error) {
    if (temporary) {
      rmSync(temporary, { force: true });
    }
    return `failed to link ${link.path}: ${messageOf(error)}`;
  }
}

/** Deletes a file or link and then the folders above it that became empty, up to the worktree; returns the error. */
export function applyDelete(root: string, path: string): string | null {
  try {
    const link = linkAbove(root, path);
    if (link) return `failed to delete ${path}: ${link} is a link`;
    const entry = inspect(join(root, path));
    if (entry.kind === "folder") return `failed to delete ${path}: it is a folder`;
    if (entry.kind !== "missing") {
      unlinkSync(join(root, path));
    }
  } catch (error) {
    return `failed to delete ${path}: ${messageOf(error)}`;
  }
  for (const folder of ancestorsOf(path)) {
    try {
      rmdirSync(join(root, folder));
    } catch {
      break;
    }
  }
  return null;
}
