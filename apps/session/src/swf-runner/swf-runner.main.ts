/**
 * Entry point of the swf runner on a session VM, run by `hunt-swf-runner.service` as the user `agent` for a session the
 * software factory's poller cloned (see `swf-runner.service.ts` for what it does):
 *
 *   node /srv/hunt/current/session/swfRunner.mjs      (the bundle `nx build session` writes)
 *
 * Environment: `HUNT_SESSION_ID` and `HUNT_WORKTREE` (`/etc/hunt/swf-runner.env`, which `hunt-ctl start` writes),
 * `HUNT_SOCKET_DIR` (agent.env), where the relay keeps `status.json` and `relay.sock`, `HUNT_CONFIG` (agent.env),
 * the relay's `hunt-session.json`, whose config options the runner sets before each step's fresh conversation, and
 * `CLAUDE_CONFIG_DIR` (agent.env), whose `projects/` holds the transcripts of the agent's conversations. The
 * checks of a step's gate run as the agent in a login shell in the worktree, like the agent's own commands. It runs a tick whenever the
 * socket directory or the inbox changes (`fs.watch`; the relay's systemd RuntimeDirectory is created anew with every
 * relay start, so the watch is set up again whenever it is gone) and every POLL_INTERVAL_MS anyway. It connects to the
 * relay only to send a prompt and touches nothing that counts as activity for `hunt-idle-check` while it waits, so
 * that the VM suspends while the pipeline waits for people. The prompts of the steps are compiled in through the `?raw`
 * imports, as the gateway compiles them into its poller. Runs on Node 24 through type stripping; no dependencies.
 */
import { execFile, spawn } from "node:child_process";
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
import swfGateEscalatePrompt from "../../../../libs/domain/prompts/swf/gate-escalate.user-prompt.md?raw";
import swfGateFailedPrompt from "../../../../libs/domain/prompts/swf/gate-failed.user-prompt.md?raw";
import swfNudgePrompt from "../../../../libs/domain/prompts/swf/nudge.user-prompt.md?raw";
import { connectRelaySocket, sendPrompt } from "../../../../libs/domain/src/relay/relay-prompt.client.ts";
import { SessionId } from "../../../../libs/domain/src/session/session-id.value-object.ts";
import { messageOf } from "../../../../libs/domain/src/shared/errors.utils.ts";
import { journalLine, type LogLevel } from "../../../../libs/domain/src/shared/journal.utils.ts";
import type { PromptFiles } from "../../../../libs/domain/src/swf/swf-prompts.utils.ts";
import { replaceConfigOptions } from "../relay/hunt-session-config.utils.ts";
import { HuntJson } from "../session-config/hunt-json.value-object.ts";
import { GhClient } from "./gh.client.ts";
import { changedPathsOf } from "./git-status.utils.ts";
import { relaySessionStatusOf } from "./relay-status-file.utils.ts";
import { SwfDir } from "./swf-dir.client.ts";
import { SwfRunner } from "./swf-runner.service.ts";

const POLL_INTERVAL_MS = 10_000;
/** How long after a change the tick runs, so that a burst of changes costs one tick. */
const SETTLE_MS = 200;
/** `hunt-ctl clear` waits up to 120 s for the relay; the runner gives it a little longer. */
const CLEAR_TIMEOUT_MS = 150_000;
const GH_TIMEOUT_MS = 60_000;
const GIT_TIMEOUT_MS = 60_000;
/** How much of the end of a gate check's output the runner keeps, in characters. */
const CHECK_OUTPUT_MAX_CHARS = 200 * 1024;
const HUNT_CTL = "/usr/local/bin/hunt-ctl";
const GH = "/usr/local/bin/gh";
/** The folder of `.hunt/swf/` in the worktree, as `hunt-ctl` names it (SWF_DIR). */
const SWF_DIR = ".hunt/swf";

/** Writes to stderr, which systemd hands to the journal under the unit's SyslogIdentifier; `level` becomes its priority. */
function log(message: string, level: LogLevel = "info"): void {
  console.error(journalLine(message, level));
}

/**
 * The name of the project folder Claude Code keeps the transcripts of `worktree` in: every character but an ASCII letter
 * or digit becomes `-` (`project_slug` of the client's `remote/transcript.rs`).
 */
function projectSlug(worktree: string): string {
  return worktree.replace(/[^A-Za-z0-9]/g, "-");
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
    swfGateFailed: swfGateFailedPrompt,
    swfGateEscalate: swfGateEscalatePrompt,
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

/** The command line of the check `name` of the hunt.json in `worktree` and the folder it runs in; throws with the problems. */
function findCheck(worktree: string, name: string): { command: string; cwd: string } {
  const path = join(worktree, "hunt.json");
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`failed to read ${path}: ${messageOf(error)}`);
  }
  const parsed = HuntJson.fromDocument(document);
  if (parsed.problems) throw new Error(`${path} has problems:\n${parsed.problems.join("\n")}`);
  const { command, cwd } = parsed.huntJson.findCheck(name);
  return { command, cwd: cwd === null ? worktree : join(worktree, cwd) };
}

/**
 * Runs the check `name` of the worktree's hunt.json in a login shell to its end, without a timeout, and gives its exit
 * code (null when a signal ended it) with the last CHECK_OUTPUT_MAX_CHARS of stdout and stderr as they came; a check it
 * cannot find or start gives null with the problem as output.
 */
function runCheck(worktree: string, name: string): Promise<{ exitCode: number | null; output: string }> {
  let check: { command: string; cwd: string };
  try {
    check = findCheck(worktree, name);
  } catch (error) {
    return Promise.resolve({ exitCode: null, output: messageOf(error) });
  }
  return new Promise((resolve) => {
    let output = "";
    function append(chunk: string): void {
      output += chunk;
      if (output.length > 2 * CHECK_OUTPUT_MAX_CHARS) output = output.slice(-CHECK_OUTPUT_MAX_CHARS);
    }
    const child = spawn("/bin/bash", ["-lc", check.command], {
      cwd: check.cwd,
      env: { ...process.env, FORCE_COLOR: "0", CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8").on("data", append);
    child.stderr.setEncoding("utf8").on("data", append);
    child.on("error", (error) => resolve({ exitCode: null, output: `${output}${messageOf(error)}`.slice(-CHECK_OUTPUT_MAX_CHARS) }));
    child.on("close", (code) => resolve({ exitCode: code, output: output.slice(-CHECK_OUTPUT_MAX_CHARS) }));
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
  const configPath = requireEnv("HUNT_CONFIG");
  const statusPath = join(socketDir, "status.json");
  const socketPath = join(socketDir, "relay.sock");
  const swfDir = join(worktree, SWF_DIR);
  const projectDir = join(requireEnv("CLAUDE_CONFIG_DIR"), "projects", projectSlug(worktree));
  const inboxDir = join(swfDir, "inbox");
  mkdirSync(inboxDir, { recursive: true });

  const runner = new SwfRunner({
    files: new SwfDir(swfDir, projectDir),
    github: new GhClient((args, input) => run(GH, args, input, GH_TIMEOUT_MS)),
    readStatus: () => relaySessionStatusOf(readTextOrNull(statusPath), Date.now()),
    clearConversation: async () => {
      const output = await run("sudo", ["-n", HUNT_CTL, "clear", sessionId.id, "--keep-stored"], undefined, CLEAR_TIMEOUT_MS);
      const status = relaySessionStatusOf(output, Date.now());
      if (!status) throw new Error(`hunt-ctl clear reported no ready relay: ${output.trim().slice(0, 500)}`);
      return status;
    },
    sendPrompt: async (request) => sendPrompt(await connectRelaySocket(socketPath), request),
    runCheck: (name) => runCheck(worktree, name),
    changedFiles: async () => changedPathsOf(await run("git", ["-C", worktree, "status", "--porcelain", "-z", "--untracked-files=all"], undefined, GIT_TIMEOUT_MS)),
    currentBranch: async () => (await run("git", ["-C", worktree, "rev-parse", "--abbrev-ref", "HEAD"], undefined, GIT_TIMEOUT_MS)).trim(),
    setBranch: async (name) => {
      await run("sudo", ["-n", HUNT_CTL, "set-branch", sessionId.id, name], undefined, GIT_TIMEOUT_MS);
    },
    setConfigOptions: (options) => replaceConfigOptions(configPath, options),
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
