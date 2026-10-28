/**
 * The state and content of a path in the worktree as the sync helper reports them: its `lstat` (`file-state.value-object.ts`),
 * a regular file's content and a link's target. Errors are thrown as `failed to <verb> <what>: …`; a path that vanished meanwhile is
 * none.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readlinkSync, type BigIntStats } from "node:fs";
import { messageOf } from "../../../../libs/domain/src/shared/errors.utils.ts";
import { FileState } from "./file-state.value-object.ts";

/** What is at a path: nothing, a folder, a file or link with its state, or something else such as a socket. */
export type Entry = { kind: "missing" } | { kind: "folder"; inode: bigint } | { kind: "file" | "link" | "other"; state: FileState };

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
  return { kind, state: FileState.fromStats(stats) };
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
    return { state: FileState.fromStats(stats), data: readFileSync(descriptor) };
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
