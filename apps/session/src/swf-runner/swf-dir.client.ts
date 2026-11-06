/**
 * `.hunt/swf/` of the session's worktree, the runner's state on disk (`swf-runner.service.ts`): `pipeline.json`, the
 * pipeline the runner owns from the moment the gateway started it (`hunt-ctl swf-record` wrote the first one);
 * `result.md`, the step result the agent writes at the end of a step, which the runner moves to `steps/<nn>-<step>.md`
 * once it acted on it; `gate/<nn>-<check>.log`, the output of each check of the latest gate run of the run `nn`;
 * `transcripts/<nn>-<step>.jsonl`, a copy of the Claude Code transcript of the conversation the run `nn` had (its
 * `sessionId`, in the agent's project folder of `~/.claude/projects/`), renewed while the run goes on; and
 * `inbox/<ms>-<pid>.json`, the gateway's messages (`hunt-ctl swf-inbox`,
 * `libs/domain/src/swf/swf-inbox.utils.ts`), read in the order of their names and removed once handled. The Hunt client
 * reads `pipeline.json`, the steps and the transcripts through `hunt-ctl status` and the file sync.
 */
import { copyFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Pipeline, type Run } from "../../../../libs/domain/src/swf/pipeline.domain.ts";
import { parseInboxMessage, type InboxMessage } from "../../../../libs/domain/src/swf/swf-inbox.utils.ts";
import { writeJsonAtomic } from "../relay/json-file.utils.ts";

/** A message of the inbox with the name of its file; `message` is null for a file that holds no message. */
export interface InboxEntry {
  name: string;
  message: InboxMessage | null;
}

/** What the runner reads and writes in `.hunt/swf/`; the class below does it on disk, the tests stand in. */
export interface SwfFiles {
  /** The pipeline of `pipeline.json`; null while there is none or it is unusable. */
  readPipeline(): Pipeline | null;
  writePipeline(pipeline: Pipeline): void;
  /** The text of `result.md`; null while the agent wrote none. */
  readResult(): string | null;
  /** Keeps `result.md` as the result of the ended run `run`, `steps/<nn>-<step>.md`. */
  keepResult(run: Run): void;
  /** Removes an unusable `result.md`, so that the agent's next one is told apart. */
  discardResult(): void;
  /** Keeps the `output` of the gate check `name` on the result of the run `run`, `gate/<nn>-<name>.log`, replacing that of an earlier gate run. */
  keepGateLog(run: Run, name: string, output: string): void;
  /**
   * Copies the transcript of the conversation of `run` to `transcripts/<nn>-<step>.jsonl` when it grew since the last
   * copy; nothing for a run without a `sessionId` or whose transcript is not on this VM.
   */
  keepTranscript(run: Run): void;
  /** The inbox's entries, oldest first. */
  readInbox(): InboxEntry[];
  removeInboxEntry(name: string): void;
}

/** What an ACP session id may hold to name a transcript file (`ensure_session_id` of the client's `remote/transcript.rs`). */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export class SwfDir implements SwfFiles {
  readonly dir: string;
  /** The agent's project folder of the worktree in `~/.claude/projects/`, which holds a `<sessionId>.jsonl` per conversation. */
  readonly projectDir: string;

  constructor(dir: string, projectDir: string) {
    this.dir = dir;
    this.projectDir = projectDir;
  }

  readPipeline(): Pipeline | null {
    const text = readTextOrNull(join(this.dir, "pipeline.json"));
    if (text === null) return null;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
    const parsed = Pipeline.schema.safeParse(value);
    return parsed.success ? new Pipeline(parsed.data) : null;
  }

  writePipeline(pipeline: Pipeline): void {
    mkdirSync(this.dir, { recursive: true });
    writeJsonAtomic(join(this.dir, "pipeline.json"), pipeline.toJSON());
  }

  readResult(): string | null {
    return readTextOrNull(join(this.dir, "result.md"));
  }

  keepResult(run: Run): void {
    mkdirSync(join(this.dir, "steps"), { recursive: true });
    renameSync(join(this.dir, "result.md"), join(this.dir, "steps", `${runNumber(run)}-${run.step}.md`));
  }

  discardResult(): void {
    rmSync(join(this.dir, "result.md"), { force: true });
  }

  keepGateLog(run: Run, name: string, output: string): void {
    mkdirSync(join(this.dir, "gate"), { recursive: true });
    writeFileSync(join(this.dir, "gate", `${runNumber(run)}-${name}.log`), output);
  }

  keepTranscript(run: Run): void {
    if (!run.sessionId || !SESSION_ID_PATTERN.test(run.sessionId)) return;
    const source = join(this.projectDir, `${run.sessionId}.jsonl`);
    const target = join(this.dir, "transcripts", `${runNumber(run)}-${run.step}.jsonl`);
    const size = sizeOrNull(source);
    if (size === null || size === sizeOrNull(target)) return;
    mkdirSync(join(this.dir, "transcripts"), { recursive: true });
    // Copied beside and renamed, so that the client's file sync never pulls a half-written copy.
    copyFileSync(source, `${target}.tmp`);
    renameSync(`${target}.tmp`, target);
  }

  readInbox(): InboxEntry[] {
    let names: string[];
    try {
      names = readdirSync(join(this.dir, "inbox")).filter((name) => name.endsWith(".json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return names.sort().map((name) => {
      const text = readTextOrNull(join(this.dir, "inbox", name));
      let value: unknown;
      try {
        value = text === null ? undefined : JSON.parse(text);
      } catch {
        value = undefined;
      }
      return { name, message: parseInboxMessage(value) };
    });
  }

  removeInboxEntry(name: string): void {
    rmSync(join(this.dir, "inbox", name), { force: true });
  }
}

/** The number of `run` as the file names in `.hunt/swf/` carry it, zero-padded to two digits. */
function runNumber(run: Run): string {
  return String(run.n).padStart(2, "0");
}

/** The content of the file at `path`; null when it is missing. */
function readTextOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** The size of the file at `path` in bytes; null when it is missing. */
function sizeOrNull(path: string): number | null {
  try {
    return statSync(path).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
