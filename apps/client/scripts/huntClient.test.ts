import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCommandLine, replyOutcome } from "./huntClient.mjs";

const CLIENT = fileURLToPath(new URL("./huntClient.mjs", import.meta.url));
const SESSION_ID = "6f0c2a52-0b55-4c4e-9d0e-2f8b1f3c7a10";
const OTHER_SESSION_ID = "0d4b9a71-3c2e-4f6a-8b1d-5e7f9a0c2b34";
const WORKING_DIRECTORY = "/Users/agent/worktree";
const TAB_NAMES = ["diff", "git", "editor", "graph", "pullRequest", "preview", "desktop", "checks", "terminal"];

type Message = Record<string, unknown>;

interface Run {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

let folder: string;
let socketPath: string;
let control: Server | undefined;
/** The requests Hunt's fake socket received. */
let requests: Message[];

beforeEach(() => {
  folder = realpathSync(mkdtempSync(join(tmpdir(), "hunt-client-")));
  socketPath = join(folder, "control.sock");
  requests = [];
});

afterEach(async () => {
  await new Promise<void>((resolve) => (control ? control.close(() => resolve()) : resolve()));
  control = undefined;
  rmSync(folder, { recursive: true, force: true });
});

/** Starts Hunt's fake control socket, which answers each request line with `reply`, or closes without one for `null`. */
function startControl(reply: string | null): Promise<void> {
  const server = createServer((connection) => {
    createInterface({ input: connection }).once("line", (line) => {
      requests.push(JSON.parse(line) as Message);
      if (reply === null) {
        connection.end();
      } else {
        connection.end(`${reply}\n`);
      }
    });
  });
  control = server;
  return new Promise((resolve) => server.listen(socketPath, resolve));
}

/** Runs hunt-client in `folder` with Hunt's variables, which `environment` replaces or (with `undefined`) removes. */
function runClient(argv: string[], environment: Record<string, string | undefined> = {}): Promise<Run> {
  const child = spawn(process.execPath, [CLIENT, ...argv], {
    cwd: folder,
    env: { ...process.env, HUNT_CONTROL_SOCKET: socketPath, HUNT_SESSION_ID: SESSION_ID, ...environment },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return new Promise((resolve) => child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr })));
}

function commandOf(argv: string[]): unknown {
  return parseCommandLine(argv, WORKING_DIRECTORY);
}

describe("parseCommandLine", () => {
  it("reads every command into the command object Hunt's frontend runs, leaving out the options not given", () => {
    const cases: [string[], Message][] = [
      [["show"], { name: "show" }],
      [["tab", "pullRequest"], { name: "tab", tab: "pullRequest" }],
      [["open", "file", "src/main.ts"], { name: "openFile", path: `${WORKING_DIRECTORY}/src/main.ts` }],
      [
        ["open", "file", "/repo/../repo/a.ts", "--line", "12", "--column", "4", "--window"],
        { name: "openFile", path: "/repo/a.ts", line: 12, column: 4, window: true },
      ],
      [["open", "file", "../other/b.ts", "--column=7"], { name: "openFile", path: "/Users/agent/other/b.ts", column: 7 }],
      [["open", "diff", "./README.md"], { name: "openDiff", path: `${WORKING_DIRECTORY}/README.md` }],
      [["open", "settings"], { name: "openSettings" }],
      [["open", "settings", "--page", "updates"], { name: "openSettings", page: "updates" }],
      [["open", "guardrails"], { name: "openGuardrails" }],
      [["open", "browser"], { name: "openBrowser" }],
    ];
    for (const [argv, command] of cases) {
      expect(commandOf(argv), argv.join(" ")).toStrictEqual({ kind: "command", command, session: undefined });
    }
  });

  it("knows every tab of a session", () => {
    for (const tab of TAB_NAMES) {
      expect(commandOf(["tab", tab])).toStrictEqual({ kind: "command", command: { name: "tab", tab }, session: undefined });
    }
  });

  it("takes --session before and after the command", () => {
    expect(commandOf(["--session", OTHER_SESSION_ID, "show"])).toStrictEqual({ kind: "command", command: { name: "show" }, session: OTHER_SESSION_ID });
    expect(commandOf(["open", "guardrails", `--session=${OTHER_SESSION_ID}`])).toStrictEqual({
      kind: "command",
      command: { name: "openGuardrails" },
      session: OTHER_SESSION_ID,
    });
  });

  it("reports a usage error with the help of the command it concerns", () => {
    const cases: [string[], string, string][] = [
      [[], "no command given", "hunt-client [--session <id>] <command>"],
      [["reload"], "unknown command reload", "hunt-client [--session <id>] <command>"],
      [["open"], "open needs one of file, diff, settings, guardrails, browser", "hunt-client [--session <id>] <command>"],
      [["open", "terminal"], "unknown command open terminal", "hunt-client [--session <id>] <command>"],
      [["tab"], "tab needs <name>", "hunt-client tab <name>"],
      [["tab", ""], "tab needs <name>", "hunt-client tab <name>"],
      [["tab", "diffs"], `unknown tab diffs; it is one of ${TAB_NAMES.join(", ")}`, "hunt-client tab <name>"],
      [["tab", "diff", "git"], "unexpected argument git", "hunt-client tab <name>"],
      [["show", "--line", "3"], "show takes no --line", "hunt-client show"],
      [["open", "diff", "a.ts", "--window"], "open diff takes no --window", "hunt-client open diff <path>"],
      [["open", "file"], "open file needs <path>", "hunt-client open file <path>"],
      [["open", "file", "a.ts", "--line", "0"], "--line needs a positive integer, not 0", "hunt-client open file <path>"],
      [["open", "file", "a.ts", "--line", "1.5"], "--line needs a positive integer, not 1.5", "hunt-client open file <path>"],
      [["open", "file", "a.ts", "--column=-3"], "--column needs a positive integer, not -3", "hunt-client open file <path>"],
      [["open", "file", "a.ts", "--line", "99999999999999999999"], "--line needs a positive integer, not 99999999999999999999", "hunt-client open file <path>"],
      [["open", "settings", "--page", "general"], "unknown settings page general; it is one of updates", "hunt-client open settings"],
      [["open", "browser", "--session", ""], "--session needs the ID of a Hunt session", "hunt-client open browser"],
      [["show", "--session"], "Option '--session <value>' argument missing", "hunt-client show"],
      [["show", "--verbose"], "Unknown option '--verbose'", "hunt-client show"],
    ];
    for (const [argv, message, usage] of cases) {
      const parsed = commandOf(argv) as { kind: string; message: string; help: string };
      expect(parsed.kind, argv.join(" ")).toBe("usageError");
      expect(parsed.message, argv.join(" ")).toContain(message);
      expect(parsed.help, argv.join(" ")).toContain(`usage: ${usage}`);
    }
  });

  it("answers --help and -h with the overview or the help of the command, whatever else the arguments hold", () => {
    const overview = commandOf(["--help"]) as { kind: string; text: string };

    expect(overview.kind).toBe("help");
    expect(overview.text).toMatch(/^usage: hunt-client \[--session <id>\] <command>/);
    const usages = ["show", "tab <name>", "open file <path> [--line <n>] [--match <text>] [--column <n>] [--window]", "open diff <path>", "open settings [--page <page>]"];
    for (const usage of usages) {
      expect(overview.text).toContain(`\n  ${usage}`);
    }
    expect(overview.text).toContain("\n  open guardrails ");
    expect(overview.text).toContain("\n  open browser ");
    expect(commandOf(["-h"])).toStrictEqual(overview);
    expect(commandOf(["open", "--help"])).toStrictEqual(overview);

    const fileHelp = commandOf(["open", "file", "--bogus", "-h"]) as { kind: string; text: string };

    expect(fileHelp.kind).toBe("help");
    expect(fileHelp.text).toMatch(/^usage: hunt-client open file <path> \[--line <n>\] \[--match <text>\] \[--column <n>\] \[--window\] \[--session <id>\]\n/);
    expect(fileHelp.text).toContain("Open the file <path> in the session's editor tab.");
    for (const option of ["--line <n>", "--match <text>", "--column <n>", "--window", "--session <id>", "-h, --help"]) {
      expect(fileHelp.text).toContain(`\n  ${option} `);
    }
    expect((commandOf(["tab", "--help"]) as { text: string }).text).toContain(TAB_NAMES.join(", "));
  });

  it("puts the cursor of open file --match on the one line of the file that contains the text", () => {
    writeFileSync(join(folder, "sweep.ts"), "try {\n  await remove(filePath);\n  removedCount++;\r\n} catch (error) {}\n");

    expect(parseCommandLine(["open", "file", "sweep.ts", "--match", "removedCount++", "--column", "3"], folder)).toStrictEqual({
      kind: "command",
      command: { name: "openFile", path: join(folder, "sweep.ts"), line: 3, column: 3 },
      session: undefined,
    });
  });

  it("reports a usage error when open file --match finds no line, several lines or no file, or comes with --line", () => {
    writeFileSync(join(folder, "sweep.ts"), "await remove(a);\nawait remove(b);\n");
    const cases: [string[], string][] = [
      [["open", "file", "sweep.ts", "--match", "unlink"], `no line of ${join(folder, "sweep.ts")} contains unlink`],
      [["open", "file", "sweep.ts", "--match", "await remove"], `lines 1, 2 of ${join(folder, "sweep.ts")} contain await remove`],
      [["open", "file", "sweep.ts", "--match", ""], "--match needs the text of a line"],
      [["open", "file", "missing.ts", "--match", "remove"], `cannot read ${join(folder, "missing.ts")}`],
      [["open", "file", "sweep.ts", "--match", "remove(a)", "--line", "1"], "open file takes --line or --match, not both"],
    ];
    for (const [argv, message] of cases) {
      const parsed = parseCommandLine(argv, folder) as { kind: string; message: string; help: string };
      expect(parsed.kind, argv.join(" ")).toBe("usageError");
      expect(parsed.message, argv.join(" ")).toContain(message);
      expect(parsed.help, argv.join(" ")).toContain("usage: hunt-client open file <path>");
    }
  });
});

describe("replyOutcome", () => {
  it("exits with 0 and prints nothing when Hunt answered ok, and with 1 and the reason otherwise", () => {
    expect(replyOutcome('{"ok":true}')).toStrictEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(replyOutcome('{"error":"failed to open the file: it is outside the worktree"}')).toStrictEqual({
      exitCode: 1,
      stdout: "",
      stderr: "hunt-client: failed to open the file: it is outside the worktree\n",
    });
    expect(replyOutcome('{"ok":false}')).toStrictEqual({ exitCode: 1, stdout: "", stderr: 'hunt-client: Hunt answered {"ok":false}\n' });
    expect(replyOutcome("Bad request")).toStrictEqual({ exitCode: 1, stdout: "", stderr: "hunt-client: Hunt answered Bad request\n" });
  });
});

describe("huntClient.mjs", () => {
  it("sends the command of the agent's session to Hunt with paths resolved in the working directory, and exits with 0 without output", async () => {
    await startControl(JSON.stringify({ ok: true }));

    const run = await runClient(["open", "file", "src/main.ts", "--line", "3"]);

    expect(run).toStrictEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(requests).toStrictEqual([{ type: "ui", session: SESSION_ID, command: { name: "openFile", path: join(folder, "src/main.ts"), line: 3 } }]);
  });

  it("sends the session --session names instead of HUNT_SESSION_ID", async () => {
    await startControl(JSON.stringify({ ok: true }));

    const run = await runClient(["--session", OTHER_SESSION_ID, "tab", "checks"], { HUNT_SESSION_ID: undefined });

    expect(run.exitCode).toBe(0);
    expect(requests).toStrictEqual([{ type: "ui", session: OTHER_SESSION_ID, command: { name: "tab", tab: "checks" } }]);
  });

  it("prints Hunt's error and exits with 1", async () => {
    await startControl(JSON.stringify({ error: "failed to show the session: Hunt has no session 6f0c2a52" }));

    expect(await runClient(["show"])).toStrictEqual({
      exitCode: 1,
      stdout: "",
      stderr: "hunt-client: failed to show the session: Hunt has no session 6f0c2a52\n",
    });
  });

  it("exits with 1 when Hunt does not listen on the socket or closes the connection without an answer", async () => {
    const missing = await runClient(["show"]);

    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toBe(`hunt-client: Hunt does not run or did not answer (HUNT_CONTROL_SOCKET=${socketPath}): connect ENOENT ${socketPath}\n`);

    await startControl(null);
    const unanswered = await runClient(["show"]);

    expect(unanswered.exitCode).toBe(1);
    expect(unanswered.stderr).toBe(
      `hunt-client: Hunt does not run or did not answer (HUNT_CONTROL_SOCKET=${socketPath}): it closed the connection without an answer\n`,
    );
  });

  it("exits with 1 outside an agent Hunt started", async () => {
    expect(await runClient(["show"], { HUNT_CONTROL_SOCKET: undefined })).toStrictEqual({
      exitCode: 1,
      stdout: "",
      stderr: "hunt-client: HUNT_CONTROL_SOCKET is not set; hunt-client works only in an agent that Hunt started on this Mac\n",
    });
    expect(await runClient(["show"], { HUNT_SESSION_ID: undefined })).toStrictEqual({
      exitCode: 1,
      stdout: "",
      stderr: "hunt-client: HUNT_SESSION_ID is not set and no --session was given; hunt-client works only in an agent that Hunt started on this Mac\n",
    });
  });

  it("exits with 2 and prints the usage on stderr on a usage error, without asking Hunt", async () => {
    await startControl(JSON.stringify({ ok: true }));

    const run = await runClient(["tab", "diffs"]);

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toMatch(/^hunt-client: unknown tab diffs; it is one of diff, git, .*\n\nusage: hunt-client tab <name> \[--session <id>\]\n/);
    expect(requests).toStrictEqual([]);
  });

  it("prints the help on stdout and exits with 0, also outside Hunt", async () => {
    const run = await runClient(["--help"], { HUNT_CONTROL_SOCKET: undefined, HUNT_SESSION_ID: undefined });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toMatch(/^usage: hunt-client /);
    expect(run.stderr).toBe("");
  });
});
