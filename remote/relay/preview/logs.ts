/**
 * The preview's logs in `<stateDir>/logs`: `<process>.log` per process and `setup.log` for the prepare and init steps.
 * Each is append-only and moves to `<name>.log.1`, replacing the previous one, once it would grow past 10 MB.
 */
import { closeSync, fstatSync, openSync, readSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";
import { messageOf } from "../relay.ts";

export const LOG_ROTATE_BYTES = 10 * 1024 * 1024;
const NEWLINE = 0x0a;
const LINE_BREAK = Buffer.from([NEWLINE]);
const TAIL_CHUNK_BYTES = 64 * 1024;

export function logPath(stateDir: string, name: string): string {
  return join(stateDir, "logs", `${name}.log`);
}

export interface LogFileOptions {
  maxBytes?: number;
  /** Called with the first of a run of failed writes; the output of that time is lost. */
  onError?(message: string): void;
}

/** One log file, opened on the first write. */
export class LogFile {
  private readonly path: string;
  private readonly maxBytes: number;
  private readonly onError: (message: string) => void;
  private fd: number | null = null;
  private size = 0;
  private endsWithNewline = true;
  private hasFailed = false;

  constructor(path: string, options: LogFileOptions = {}) {
    this.path = path;
    this.maxBytes = options.maxBytes ?? LOG_ROTATE_BYTES;
    this.onError = options.onError ?? (() => {});
  }

  write(chunk: string | Uint8Array): void {
    this.append(typeof chunk === "string" ? Buffer.from(chunk) : chunk, false);
  }

  /** Writes `text` as a line of its own, also when the output before it did not end with a line break. */
  line(text: string): void {
    this.append(Buffer.from(`${text}\n`), true);
  }

  /** Appends `data`, after a line break when `isLine` and the file does not end with one; rotates first if needed. */
  private append(data: Uint8Array, isLine: boolean): void {
    if (data.length === 0) return;
    try {
      let fd = this.fd ?? this.open();
      if (this.size > 0 && this.size + data.length > this.maxBytes) {
        fd = this.rotate();
      }
      const bytes = isLine && !this.endsWithNewline ? Buffer.concat([LINE_BREAK, data]) : data;
      let offset = 0;
      while (offset < bytes.length) {
        offset += writeSync(fd, bytes, offset);
      }
      this.size += bytes.length;
      this.endsWithNewline = bytes[bytes.length - 1] === NEWLINE;
      this.hasFailed = false;
    } catch (error) {
      this.close();
      if (!this.hasFailed) {
        this.hasFailed = true;
        this.onError(`failed to write ${this.path}: ${messageOf(error)}`);
      }
    }
  }

  close(): void {
    if (this.fd === null) return;
    const fd = this.fd;
    this.fd = null;
    try {
      closeSync(fd);
    } catch {
      // The descriptor is gone either way.
    }
  }

  private open(): number {
    const fd = openSync(this.path, "a+");
    this.fd = fd;
    this.size = fstatSync(fd).size;
    this.endsWithNewline = this.size === 0 || lastByte(fd, this.size) === NEWLINE;
    return fd;
  }

  private rotate(): number {
    this.close();
    renameSync(this.path, `${this.path}.1`);
    return this.open();
  }
}

function lastByte(fd: number, size: number): number {
  const buffer = Buffer.alloc(1);
  readSync(fd, buffer, 0, 1, size - 1);
  return buffer[0];
}

/** The last `count` lines of the log at `path`, continued from its rotated `.1` when it holds fewer; null without a log. */
export function readLogTail(path: string, count: number): string[] | null {
  const current = lastLines(path, count);
  if (current === null || current.length >= count) return current;
  return [...(lastLines(`${path}.1`, count - current.length) ?? []), ...current];
}

/** Reads `path` backwards in chunks until it has `count` complete lines; null when the file does not exist. */
function lastLines(path: string, count: number): string[] | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const chunks: Buffer[] = [];
    let position = fstatSync(fd).size;
    let newlines = 0;
    while (position > 0 && newlines <= count) {
      const length = Math.min(TAIL_CHUNK_BYTES, position);
      position -= length;
      const chunk = Buffer.alloc(length);
      readSync(fd, chunk, 0, length, position);
      chunks.unshift(chunk);
      for (let index = chunk.indexOf(NEWLINE); index !== -1; index = chunk.indexOf(NEWLINE, index + 1)) {
        newlines++;
      }
    }
    const lines = Buffer.concat(chunks).toString("utf8").split("\n");
    if (lines[lines.length - 1] === "") {
      lines.pop();
    }
    if (position > 0) {
      lines.shift();
    }
    return count > 0 ? lines.slice(-count) : [];
  } finally {
    closeSync(fd);
  }
}
