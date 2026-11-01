/**
 * `.hunt/swf/` of the session's worktree, the runner's state on disk (`swf-runner.service.ts`): `pipeline.json`, the
 * pipeline the runner owns from the moment the gateway started it (`hunt-ctl swf-record` wrote the first one);
 * `result.md`, the step result the agent writes at the end of a step, which the runner moves to `steps/<nn>-<step>.md`
 * once it acted on it; `gate/<nn>-<check>.log`, the output of each check of the latest gate run of the run `nn`; and
 * `inbox/<ms>-<pid>.json`, the gateway's messages (`hunt-ctl swf-inbox`,
 * `libs/domain/src/swf/swf-inbox.utils.ts`), read in the order of their names and removed once handled. The Hunt client
 * reads `pipeline.json` and the steps through `hunt-ctl status` and the file sync.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
  /** The inbox's entries, oldest first. */
  readInbox(): InboxEntry[];
  removeInboxEntry(name: string): void;
}

export class SwfDir implements SwfFiles {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
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
