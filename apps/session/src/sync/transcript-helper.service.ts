/**
 * The live transcript stream that `transcript-helper.main.ts` runs on a session VM: it watches the agent's Claude Code
 * project folder (created when missing) and reports every regular file below it, other than the memory and the files
 * the client owns, as it grows: from the offset the client holds, in chunks, with the file's size. A file that shrank or
 * was replaced is reset and reported from the start. It appends the client's writes to the files the client owns
 * (`transcript-protocol.types.ts`).
 */
import { appendFileSync, closeSync, mkdirSync, openSync, readdirSync, readSync, statSync, watch, writeFileSync, type BigIntStats, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import { messageOf } from "../../../../libs/domain/src/shared/errors.utils.ts";
import { CHUNK_BYTES, type TranscriptMessage, type TranscriptRequest } from "./transcript-protocol.types.ts";
import { parseTranscriptRequest } from "./transcript-protocol.utils.ts";
import { childOf, isAtOrBelow } from "./worktree-paths.utils.ts";

/** How long changes are collected before they are reported together. */
const BATCH_MS = 20;
/** The folder of the repository memory, which the desktop merges at retrieval rather than streams. */
const MEMORY_FOLDER = "memory";
/** The mode of a file the helper creates; Claude Code keeps its transcripts private the same way. */
const FILE_MODE = 0o600;

export interface HelperOutput {
  send(message: TranscriptMessage): void;
  /** Whether the client fell behind reading what was sent; the helper's `onCaughtUp` is called once it caught up. */
  isBehind(): boolean;
}

/** What the helper reported of a file: the bytes up to which the client holds it, and the inode they came from. */
interface Sent {
  offset: number;
  inode: bigint | null;
}

export class TranscriptHelper {
  private readonly root: string;
  private readonly output: HelperOutput;
  private readonly log: (message: string) => void;
  private watcher: FSWatcher | null = null;
  /** What was reported per path; a path the client holds nothing of is absent. */
  private readonly sent = new Map<string, Sent>();
  /** The paths the client writes, which are never reported. */
  private readonly owned = new Set<string>();
  /** Whether the client said what it holds; nothing is reported before. */
  private isSynced = false;
  private pending = new Set<string>();
  /** Whether the next batch scans the whole folder: a watch event without a name, or the client caught up. */
  private wantsScan = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(root: string, output: HelperOutput, log: (message: string) => void) {
    this.root = root;
    this.output = output;
    this.log = log;
  }

  /** Creates the folder when missing, watches it and reports `ready`. */
  start(): void {
    mkdirSync(this.root, { recursive: true });
    this.watcher = watch(this.root, { recursive: true }, (_event, name) => this.onEvent(name));
    this.watcher.on("error", (error) => {
      this.log(`the watch of ${this.root} failed: ${error.message}`);
      process.exit(1);
    });
    this.output.send({ t: "ready" });
  }

  /** Handles one line from the client. */
  handleLine(line: string): void {
    const parsed = parseTranscriptRequest(line);
    if ("error" in parsed) {
      this.output.send({ t: "error", message: parsed.error });
      return;
    }
    this.handle(parsed.request);
  }

  /** The client read everything it fell behind on: the folder is scanned, since reports were dropped meanwhile. */
  onCaughtUp(): void {
    this.wantsScan = true;
    this.schedule();
  }

  private handle(request: TranscriptRequest): void {
    switch (request.t) {
      case "sync":
        this.sent.clear();
        this.owned.clear();
        for (const [path, offset] of request.files) {
          this.sent.set(path, { offset, inode: null });
        }
        for (const path of request.owned) {
          this.owned.add(path);
        }
        this.isSynced = true;
        this.pending.clear();
        this.scan();
        return;
      case "read":
        this.sent.set(request.path, { offset: request.offset, inode: null });
        this.report(request.path);
        return;
      case "write":
        this.write(request);
        return;
    }
  }

  private write(request: Extract<TranscriptRequest, { t: "write" }>): void {
    const { id, path } = request;
    this.owned.add(path);
    this.sent.delete(path);
    const absolute = join(this.root, path);
    try {
      mkdirSync(dirname(absolute), { recursive: true });
      if (request.truncate) {
        writeFileSync(absolute, request.data, { mode: FILE_MODE });
      } else {
        const size = this.sizeOf(absolute);
        if (size !== request.offset) {
          this.output.send({ t: "ack", id, error: `${path} is ${size} bytes long, not ${request.offset}` });
          return;
        }
        appendFileSync(absolute, request.data, { mode: FILE_MODE });
      }
      this.output.send({ t: "ack", id, size: this.sizeOf(absolute) });
    } catch (error) {
      this.output.send({ t: "ack", id, error: `failed to write ${path}: ${messageOf(error)}` });
    }
  }

  /** The size of the regular file at `absolute`; 0 when there is none. */
  private sizeOf(absolute: string): number {
    const stats = statsOf(absolute);
    return stats?.isFile() ? Number(stats.size) : 0;
  }

  private onEvent(name: string | null): void {
    if (!name) {
      this.wantsScan = true;
    } else if (!isSkipped(name)) {
      this.pending.add(name);
    }
    this.schedule();
  }

  private schedule(): void {
    this.timer ??= setTimeout(() => this.flush(), BATCH_MS);
  }

  private flush(): void {
    this.timer = null;
    if (!this.isSynced || this.output.isBehind()) return;
    const paths = this.pending;
    this.pending = new Set();
    if (this.wantsScan) {
      this.wantsScan = false;
      this.scan();
      return;
    }
    for (const path of paths) {
      this.report(path);
    }
  }

  /** Reports every file of the folder and every file the client holds that is gone. */
  private scan(): void {
    const found = new Set<string>();
    try {
      this.walk("", found);
    } catch (error) {
      this.log(`failed to scan ${this.root}: ${messageOf(error)}`);
    }
    for (const path of found) {
      this.report(path);
    }
    for (const path of [...this.sent.keys()]) {
      if (!found.has(path)) {
        this.report(path);
      }
    }
  }

  private walk(folder: string, found: Set<string>): void {
    for (const entry of readdirSync(join(this.root, folder), { withFileTypes: true })) {
      const path = childOf(folder, entry.name);
      if (isSkipped(path)) continue;
      if (entry.isDirectory()) {
        this.walk(path, found);
      } else if (entry.isFile()) {
        found.add(path);
      }
    }
  }

  /** Reports what the client lacks of the file at `path`: its content beyond the reported offset, a reset or that it is gone. */
  private report(path: string): void {
    if (this.owned.has(path) || this.output.isBehind()) return;
    const absolute = join(this.root, path);
    const stats = statsOf(absolute);
    if (!stats?.isFile()) {
      if (stats?.isDirectory()) return;
      if (this.sent.delete(path)) {
        this.output.send({ t: "gone", path });
      }
      return;
    }
    const size = Number(stats.size);
    let entry = this.sent.get(path) ?? { offset: 0, inode: stats.ino };
    const isReplaced = entry.inode !== null && entry.inode !== stats.ino && entry.offset > 0;
    if (isReplaced || size < entry.offset) {
      this.output.send({ t: "reset", path });
      entry = { offset: 0, inode: stats.ino };
    }
    entry.inode = stats.ino;
    try {
      while (entry.offset < size) {
        const data = readChunk(absolute, entry.offset, Math.min(CHUNK_BYTES, size - entry.offset));
        if (!data.length) break;
        this.output.send({ t: "file", path, offset: entry.offset, data: data.toString("base64"), size });
        entry.offset += data.length;
      }
    } catch (error) {
      this.log(`failed to read ${path}: ${messageOf(error)}`);
      this.pending.add(path);
      this.schedule();
    }
    this.sent.set(path, entry);
  }
}

/** Whether `path` (relative to the folder) is left alone: the memory folder and everything in it. */
function isSkipped(path: string): boolean {
  return isAtOrBelow(path, MEMORY_FOLDER);
}

/** The `stat` of `absolute`; null when nothing is there. */
function statsOf(absolute: string): BigIntStats | null {
  try {
    return statSync(absolute, { bigint: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

/** Up to `length` bytes of the file at `absolute` from `offset`; fewer when the file ends before. */
function readChunk(absolute: string, offset: number, length: number): Buffer {
  const descriptor = openSync(absolute, "r");
  try {
    const buffer = Buffer.alloc(length);
    const read = readSync(descriptor, buffer, 0, length, offset);
    return buffer.subarray(0, read);
  } finally {
    closeSync(descriptor);
  }
}
