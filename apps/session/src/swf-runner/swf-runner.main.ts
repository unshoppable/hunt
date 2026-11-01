/**
 * Entry point of the swf runner on a session VM, run by `hunt-swf-runner.service` as the user `agent` for a session the
 * software factory's poller cloned (see `swf-runner.service.ts` for what it does):
 *
 *   node /srv/hunt/current/session/swfRunner.mjs      (the bundle `nx build session` writes)
 *
 * Environment: `HUNT_SESSION_ID` and `HUNT_WORKTREE` (`/etc/hunt/swf-runner.env`, which `hunt-ctl start` writes) and
 * `HUNT_SOCKET_DIR` (agent.env), where the relay keeps `status.json` and `relay.sock`. It runs a tick whenever the
 * socket directory or the inbox changes (`fs.watch`; the relay's systemd RuntimeDirectory is created anew with every
 * relay start, so the watch is set up again whenever it is gone) and every POLL_INTERVAL_MS anyway. It connects to the
 * relay only to send a prompt and touches nothing that counts as activity for `hunt-idle-check` while it waits, so
 * that the VM suspends while the pipeline waits for people. The prompts of the steps are compiled in through the `?raw`
 * imports, as the gateway compiles them into its poller. Runs on Node 24 through type stripping; no dependencies.
 */
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, statSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import gitPushPrompt from "../../../../libs/domain/prompts/git-push.system-prompt.md?raw";
import questionPrompt from "../../../../libs/domain/prompts/question.system-prompt.md?raw";
import remotePrompt from "../../../../libs/domain/prompts/remote.system-prompt.md?raw";
import sessionsPrompt from "../../../../libs/domain/prompts/sessions.system-prompt.md?raw";
import swfSystemPromptFile from "../../../../libs/domain/prompts/swf/0-system-prompt.md?raw";
import swfPlanPrompt from "../../../../libs/domain/prompts/swf/1-plan.user-prompt.md?raw";
import swfEscalatePrompt from "../../../../libs/domain/prompts/swf/2-implement-escalate.user-prompt.md?raw";
import swfImplementPrompt from "../../../../libs/domain/prompts/swf/2-implement.user-prompt.md?raw";
import swfVerifyPrompt from "../../../../libs/domain/prompts/swf/3-verify.user-prompt.md?raw";
import swfReviewPrompt from "../../../../libs/domain/prompts/swf/4-review.user-prompt.md?raw";
import swfPrPrompt from "../../../../libs/domain/prompts/swf/5-pr.user-prompt.md?raw";
import swfAnswerPrompt from "../../../../libs/domain/prompts/swf/answer.user-prompt.md?raw";
import swfBadResultPrompt from "../../../../libs/domain/prompts/swf/bad-result.user-prompt.md?raw";
import swfNudgePrompt from "../../../../libs/domain/prompts/swf/nudge.user-prompt.md?raw";
import { connectRelaySocket, sendPrompt } from "../../../../libs/domain/src/relay/relay-prompt.client.ts";
import { SessionId } from "../../../../libs/domain/src/session/session-id.value-object.ts";
import { journalLine, type LogLevel } from "../../../../libs/domain/src/shared/journal.utils.ts";
import type { PromptFiles } from "../../../../libs/domain/src/swf/swf-prompts.utils.ts";
import { GhClient } from "./gh.client.ts";
import { relaySessionStatusOf } from "./relay-status-file.utils.ts";
import { SwfDir } from "./swf-dir.client.ts";
import { SwfRunner } from "./swf-runner.service.ts";

const POLL_INTERVAL_MS = 10_000;
/** How long after a change the tick runs, so that a burst of changes costs one tick. */
const SETTLE_MS = 200;
/** `hunt-ctl clear` waits up to 120 s for the relay; the runner gives it a little longer. */
const CLEAR_TIMEOUT_MS = 150_000;
const GH_TIMEOUT_MS = 60_000;
const HUNT_CTL = "/usr/local/bin/hunt-ctl";
const GH = "/usr/local/bin/gh";
/** The folder of `.hunt/swf/` in the worktree, as `hunt-ctl` names it (SWF_DIR). */
const SWF_DIR = ".hunt/swf";

/** Writes to stderr, which systemd hands to the journal under the unit's SyslogIdentifier; `level` becomes its priority. */
function log(message: string, level: LogLevel = "info"): void {
  console.error(journalLine(message, level));
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    log(`${name} is not set`, "fatal");
    process.exit(1);
  }
  return value;
}

function readPrompts(): PromptFiles {
  return {
    remote: remotePrompt,
    gitPush: gitPushPrompt,
    question: questionPrompt,
    sessions: sessionsPrompt,
    swfSystem: swfSystemPromptFile,
    swfPlan: swfPlanPrompt,
    swfImplement: swfImplementPrompt,
    swfEscalate: swfEscalatePrompt,
    swfVerify: swfVerifyPrompt,
    swfReview: swfReviewPrompt,
    swfPr: swfPrPrompt,
    swfNudge: swfNudgePrompt,
    swfAnswer: swfAnswerPrompt,
    swfBadResult: swfBadResultPrompt,
  };
}

/** Runs `file` with `args` and `input` on stdin and gives its stdout; a failure carries the exit status and stderr. */
function run(file: string, args: string[], input: string | undefined, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const detail = stderr.trim() || error.message;
        reject(new Error(`${file} ${args.slice(0, 2).join(" ")} failed: ${detail.slice(0, 2000)}`));
        return;
      }
      resolve(stdout);
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(input ?? "");
  });
}

/** The inode of the directory `dir`; null when it is missing. */
function inodeOf(dir: string): number | null {
  try {
    return statSync(dir).ino;
  } catch {
    return null;
  }
}

/** The content of the file at `path`; null when it cannot be read. */
function readTextOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function main(): void {
  const sessionId = SessionId.of(requireEnv("HUNT_SESSION_ID"));
  const worktree = requireEnv("HUNT_WORKTREE");
  const socketDir = requireEnv("HUNT_SOCKET_DIR");
  const statusPath = join(socketDir, "status.json");
  const socketPath = join(socketDir, "relay.sock");
  const swfDir = join(worktree, SWF_DIR);
  const inboxDir = join(swfDir, "inbox");
  mkdirSync(inboxDir, { recursive: true });

  const runner = new SwfRunner({
    files: new SwfDir(swfDir),
    github: new GhClient((args, input) => run(GH, args, input, GH_TIMEOUT_MS)),
    readStatus: () => relaySessionStatusOf(readTextOrNull(statusPath), Date.now()),
    clearConversation: async () => {
      const output = await run("sudo", ["-n", HUNT_CTL, "clear", sessionId.id, "--keep-stored"], undefined, CLEAR_TIMEOUT_MS);
      const status = relaySessionStatusOf(output, Date.now());
      if (!status) throw new Error(`hunt-ctl clear reported no ready relay: ${output.trim().slice(0, 500)}`);
      return status;
    },
    sendPrompt: async (request) => sendPrompt(await connectRelaySocket(socketPath), request),
    prompts: readPrompts(),
    worktree,
    vmName: sessionId.vm.name,
    now: () => Date.now(),
    log,
  });

  let settle: NodeJS.Timeout | null = null;
  function scheduleTick(): void {
    if (settle) return;
    settle = setTimeout(() => {
      settle = null;
      void runner.tick();
    }, SETTLE_MS);
  }

  /**
   * The watches on the socket directory and the inbox, each with the inode it watches: a directory that was removed and
   * created anew (the relay restarted) gets a new watch, since the old one reports nothing about the new directory.
   */
  const watchers = new Map<string, { watcher: FSWatcher; ino: number }>();
  function watchDir(dir: string): void {
    const ino = inodeOf(dir);
    const current = watchers.get(dir);
    if (current && current.ino === ino) return;
    current?.watcher.close();
    watchers.delete(dir);
    if (ino === null) return;
    try {
      const watcher = watch(dir, scheduleTick);
      watcher.on("error", () => {
        watcher.close();
        watchers.delete(dir);
      });
      watchers.set(dir, { watcher, ino });
    } catch {
      // The directory went away in between; the next poll tries again.
    }
  }
  function poll(): void {
    watchDir(socketDir);
    watchDir(inboxDir);
    void runner.tick().then(() => watchDir(socketDir));
  }

  const timer = setInterval(poll, POLL_INTERVAL_MS);
  log(`running for session ${sessionId.id} in ${worktree}`);
  poll();

  function stop(): void {
    clearInterval(timer);
    for (const { watcher } of watchers.values()) {
      watcher.close();
    }
    process.exit(0);
  }
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

// Node resolves the symlink /srv/hunt/current in the module's URL, not in argv.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
