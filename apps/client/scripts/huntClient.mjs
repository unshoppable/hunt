// The command line through which the agents that Hunt starts on this Mac show the user something in Hunt's UI, run
// the checks of its Checks tab and start the services of hunt.json in its Terminal tab. An
// agent runs it from its Bash tool as `hunt-client <command>`: `.hunt/hunt-client`, a sh wrapper Hunt writes, runs
// `node huntClient.mjs "$@"`. Hunt sets HUNT_CONTROL_SOCKET (the path of its control socket) and HUNT_SESSION_ID (the
// agent's Hunt session) on the agent's process; `--session <id>` replaces the latter. Each call connects to the socket,
// sends one line `{"type":"ui","session":"<session id>","command":<command>}` of at most MAX_REQUEST_LINE_BYTES and
// reads one line back, `{"ok":true}`, with `"result"` for a command that has one, or `{"error":"<message>"}`; Hunt's
// frontend validates the command. `checks run` then asks for `checks` every CHECK_POLL_MS until the checks ended, and
// `services start` asks for `services` every SERVICE_POLL_MS until the services it started listen on their ports or
// ended, at most SERVICE_WAIT_MS. Paths are
// resolved against the working directory, so Hunt gets them absolute; `open file --match` reads the file itself to find
// the line it sends. `hunt-client --help` lists the commands. It
// prints the result, a string as it is and anything else as JSON, and exits with 0 when Hunt answered ok, also when a
// check failed; it exits with 1 when Hunt answered an error or is not reachable
// (a variable is missing, nothing listens on the socket, or no answer came within ANSWER_TIMEOUT_MS), with the reason
// on stderr, and with 2 on a usage error, with the help of the command on stderr. The tests import the exported
// functions; only running the file as the entry point runs `main`.
import { readFileSync, realpathSync } from "node:fs";
import { connect } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

/** How long Hunt may take to answer; its main window answers a UI command within 15 s. */
const ANSWER_TIMEOUT_MS = 20_000;
/** How often `checks run` asks whether the checks it started ended. */
const CHECK_POLL_MS = 2000;
/** How often `services start` asks whether the services it started listen on their ports. */
const SERVICE_POLL_MS = 2000;
/** How long `services start` waits for the services it started before it prints their state as it is. */
const SERVICE_WAIT_MS = 5 * 60_000;
/** How often `graph generate` asks whether the diagram it started is written. */
const GRAPH_POLL_MS = 2000;
/** How long `graph generate` waits for the diagram before it prints the tab's state as it is. */
const GRAPH_WAIT_MS = 15 * 60_000;
/** The longest request line Hunt's control socket reads, its newline included. */
const MAX_REQUEST_LINE_BYTES = 4096;
/** Why a missing variable means hunt-client cannot reach Hunt. */
const OUTSIDE_HUNT = "hunt-client works only in an agent that Hunt started on this Mac";
/** The column at which the descriptions of the overview's listings start. */
const OVERVIEW_COLUMN = 24;

/** The tabs of a session, as `tab` names them. */
const TAB_NAMES = ["diff", "git", "editor", "graph", "pullRequest", "desktop", "checks", "terminal", "factory"];
/** The pages `open settings --page` opens. */
const SETTINGS_PAGES = ["updates"];
/** The diagram types of the Architecture tab. */
const DIAGRAM_TYPES = ["dependencies", "c4-context", "c4-container", "states", "erd", "process", "freeform"];
/** The review levels below which the dependency graph hides files; 1 shows every file. */
const REVIEW_LEVELS = ["1", "2", "3", "4"];
/** The tabs of the Diff tab's changelist. */
const CHANGE_LIST_TABS = ["changelist", "shelf", "review"];
/** Whose changes the changelist lists. */
const CHANGELIST_SCOPES = ["own", "downstream", "all"];
/** Whose lines the diff of a file shows. */
const LINE_SCOPES = ["own", "all"];
/** How the changelist lists its files. */
const CHANGELIST_VIEWS = ["flat", "tree"];
/** How the Diff tab lays out a file's changes. */
const DIFF_MODES = ["split", "unified"];
/** Whether the Diff tab collapses unchanged lines. */
const SWITCH_STATES = ["on", "off"];

/** Every option as `parseArgs` reads it, with the placeholder of its value and its help. */
const OPTIONS = {
  session: { type: "string", placeholder: "<id>", description: "the Hunt session to act on (default: $HUNT_SESSION_ID)" },
  help: { type: "boolean", short: "h", description: "print this help" },
  line: { type: "string", placeholder: "<n>", description: "put the cursor on line <n>, counting from 1" },
  match: { type: "string", placeholder: "<text>", description: "put the cursor on the one line that contains <text>, instead of --line" },
  column: { type: "string", placeholder: "<n>", description: "put the cursor on column <n>, counting from 1" },
  window: { type: "boolean", description: "open the file in an editor window of its own instead" },
  page: { type: "string", placeholder: "<page>", description: `open the settings on <page>: ${SETTINGS_PAGES.join(", ")}` },
  "no-wait": { type: "boolean", description: "return once the checks, services or the diagram started instead of waiting for them" },
  clear: { type: "boolean", description: "clear the choice, so the tab shows its default" },
  "only-changed": { type: "boolean", description: "hide every table the branch neither adds nor changes" },
  hide: { type: "string", placeholder: "<id,…>", description: "hide the tables with these ids" },
  "show-all": { type: "boolean", description: "show every table or file again" },
  exclude: { type: "string", placeholder: "<path,…>", description: "hide these changed files" },
  "min-review": { type: "string", placeholder: "<1-4>", description: "hide the files the agent rated below this level; 1 shows all" },
  "hide-globs": { type: "string", placeholder: "<globs>", description: "hide the files matching these comma or space separated globs" },
  instructions: { type: "string", placeholder: "<text>", description: "additional instructions for this run" },
  ref: { type: "string", placeholder: "<ref>", description: "list the commits reachable from <ref>" },
  text: { type: "string", placeholder: "<text>", description: "list the commits whose message or author contains <text>; empty for all" },
  all: { type: "boolean", description: "close every tab of every pane" },
  dir: { type: "string", placeholder: "<path>", description: "start the shell in the folder <path>" },
  script: { type: "string", placeholder: "<name>", description: "run the package script <name> in the shell" },
};
/** The options every command takes. */
const COMMON_OPTIONS = ["session", "help"];

/**
 * The commands: the words that name one, its operands (in brackets when optional), the options it takes besides
 * COMMON_OPTIONS, what it does for the user, `toCommand(operands, options, workingDirectory)`, which builds the command
 * object Hunt's frontend runs, and whether it waits for the checks or the services it started. `findCommand` takes the first command
 * whose words fit, so a command stands before one whose words begin it.
 */
const COMMANDS = [
  {
    words: ["show"],
    operands: [],
    options: [],
    summary: "bring Hunt's main window to the front with this session selected",
    toCommand: () => ({ name: "show" }),
  },
  {
    words: ["tab"],
    operands: ["<name>"],
    options: [],
    summary: `show the session's tab <name>: ${TAB_NAMES.join(", ")}`,
    toCommand: ([tab]) => ({ name: "tab", tab: oneOf("tab", tab, TAB_NAMES) }),
  },
  {
    words: ["open", "file"],
    operands: ["<path>"],
    options: ["line", "match", "column", "window"],
    summary: "open the file <path> in the session's editor tab",
    toCommand: openFileCommand,
  },
  {
    words: ["open", "diff"],
    operands: ["<path>"],
    options: [],
    summary: "show the changes of the file <path> in a diff window of its own",
    toCommand: ([path], _options, workingDirectory) => ({ name: "openDiff", path: resolve(workingDirectory, path) }),
  },
  {
    words: ["open", "settings"],
    operands: [],
    options: ["page"],
    summary: "open Hunt's settings window",
    toCommand: openSettingsCommand,
  },
  {
    words: ["open", "guardrails"],
    operands: [],
    options: [],
    summary: "open the guardrails window of the session's repository",
    toCommand: () => ({ name: "openGuardrails" }),
  },
  {
    words: ["open", "browser"],
    operands: [],
    options: [],
    summary: "open the session's browser, the Chrome window that the browser tools drive",
    toCommand: () => ({ name: "openBrowser" }),
  },
  {
    words: ["checks", "run"],
    operands: ["[<name>]"],
    options: ["no-wait"],
    summary: "run the check <name> of hunt.json, or all of them, in the Checks tab, wait until they ended and print how they ended",
    toCommand: ([check]) => (check === undefined ? { name: "runChecks" } : { name: "runChecks", check }),
    waitsForChecks: true,
  },
  {
    words: ["checks", "stop"],
    operands: ["[<name>]"],
    options: [],
    summary: "stop the running check <name>, or every running check",
    toCommand: ([check]) => tabAction("checks", check === undefined ? { name: "stop" } : { name: "stop", check }),
  },
  {
    words: ["checks", "select"],
    operands: ["[<name>]"],
    options: ["clear"],
    summary: "show the check <name> in the Checks tab; --clear lets the tab pick",
    toCommand: ([check], options) => tabAction("checks", { name: "select", check: clearableOperand("checks select", check, options) }),
  },
  {
    words: ["checks"],
    operands: [],
    options: [],
    summary: "print the checks of hunt.json with their last runs, a failed one with the end of its output, and the check the tab shows",
    toCommand: () => ({ name: "checks" }),
  },
  {
    words: ["services", "start"],
    operands: ["[<name>]"],
    options: ["no-wait"],
    summary: "start the service <name> of hunt.json, or all of them, in the Terminal tab, wait until each listens on its port or ended and print their state",
    toCommand: ([service]) => (service === undefined ? { name: "startServices" } : { name: "startServices", service }),
    waitsForServices: true,
  },
  {
    words: ["services", "stop"],
    operands: ["<name>"],
    options: [],
    summary: "stop the service <name> of hunt.json; its tab keeps the output",
    toCommand: ([service]) => ({ name: "stopService", service }),
  },
  {
    words: ["services"],
    operands: [],
    options: [],
    summary: "print the services of hunt.json: state, port, whether it listens and the log of its window",
    toCommand: () => ({ name: "services" }),
  },
  {
    words: ["state"],
    operands: [],
    options: [],
    summary: "print the tab the session's inspector shows and that tab's state",
    toCommand: () => ({ name: "state" }),
  },
  {
    words: ["graph", "type"],
    operands: ["<type>"],
    options: [],
    summary: `show the diagram type <type> in the Architecture tab: ${DIAGRAM_TYPES.join(", ")}`,
    toCommand: ([type]) => tabAction("graph", { name: "type", type: oneOf("diagram type", type, DIAGRAM_TYPES) }),
  },
  {
    words: ["graph", "file"],
    operands: ["[<path>]"],
    options: ["clear"],
    summary: "show the diagram file <path> of the repository in the Architecture tab; --clear goes back to the generated diagrams",
    toCommand: ([path], options, workingDirectory) =>
      tabAction("graph", { name: "file", path: clearableOperand("graph file", path === undefined ? undefined : resolve(workingDirectory, path), options) }),
  },
  {
    words: ["graph", "tables"],
    operands: [],
    options: ["only-changed", "hide", "show-all"],
    summary: "choose the tables the ERD shows: only those the branch adds or changes, all but some, or all",
    toCommand: graphTablesCommand,
  },
  {
    words: ["graph", "files"],
    operands: [],
    options: ["exclude", "show-all"],
    summary: "choose the changed files the dependency graph shows: all but some, or all",
    toCommand: graphFilesCommand,
  },
  {
    words: ["graph", "filter"],
    operands: [],
    options: ["min-review", "hide-globs"],
    summary: "filter the dependency graph's files by the agent's review rating and by path",
    toCommand: graphFilterCommand,
  },
  {
    words: ["graph", "generate"],
    operands: [],
    options: ["instructions", "no-wait"],
    summary: "generate the diagram the Architecture tab shows, wait until it is written and print the tab's state",
    toCommand: (_operands, options) =>
      tabAction("graph", options.instructions === undefined ? { name: "generate" } : { name: "generate", instructions: options.instructions }),
    waitsForGraph: true,
  },
  {
    words: ["graph"],
    operands: [],
    options: [],
    summary: "print the state of the Architecture tab: diagram type or file, hidden tables and files, filter, generation",
    toCommand: () => ({ name: "graph" }),
  },
  {
    words: ["diff", "select"],
    operands: ["[<path>]"],
    options: ["clear"],
    summary: "select the changed file <path> in the Diff tab; --clear selects none",
    toCommand: ([path], options, workingDirectory) =>
      tabAction("diff", { name: "select", path: clearableOperand("diff select", path === undefined ? undefined : resolve(workingDirectory, path), options) }),
  },
  {
    words: ["diff", "subtab"],
    operands: ["<tab>"],
    options: [],
    summary: `show the changelist's tab <tab>: ${CHANGE_LIST_TABS.join(", ")}`,
    toCommand: ([tab]) => tabAction("diff", { name: "subtab", tab: oneOf("changelist tab", tab, CHANGE_LIST_TABS) }),
  },
  {
    words: ["diff", "scope"],
    operands: ["<scope>"],
    options: [],
    summary: `list the changes of this session (own), also of its sub sessions (downstream) or of every session (all) in the changelist`,
    toCommand: ([scope]) => tabAction("diff", { name: "scope", scope: oneOf("changelist scope", scope, CHANGELIST_SCOPES) }),
  },
  {
    words: ["diff", "globs"],
    operands: ["[<globs>]"],
    options: ["clear"],
    summary: "hide the changed files matching the comma or space separated <globs> from the changelist; --clear shows all",
    toCommand: ([globs], options) => tabAction("diff", { name: "globs", globs: clearableOperand("diff globs", globs, options) ?? "" }),
  },
  {
    words: ["diff", "view"],
    operands: ["<view>"],
    options: [],
    summary: `list the changed files ${CHANGELIST_VIEWS.join(" or as a ")}`,
    toCommand: ([view]) => tabAction("diff", { name: "view", view: oneOf("changelist view", view, CHANGELIST_VIEWS) }),
  },
  {
    words: ["diff", "lines"],
    operands: ["<scope>"],
    options: [],
    summary: "show only this session's lines (own) or every change (all) in the diff of a file other sessions changed too",
    toCommand: ([scope]) => tabAction("diff", { name: "lines", scope: oneOf("line scope", scope, LINE_SCOPES) }),
  },
  {
    words: ["diff", "mode"],
    operands: ["<mode>"],
    options: [],
    summary: `lay out the diff ${DIFF_MODES.join(" or ")}`,
    toCommand: ([mode]) => tabAction("diff", { name: "mode", mode: oneOf("diff mode", mode, DIFF_MODES) }),
  },
  {
    words: ["diff", "collapse"],
    operands: ["<on|off>"],
    options: [],
    summary: "collapse the unchanged lines of the diff, or show them",
    toCommand: ([state]) => tabAction("diff", { name: "collapse", collapsed: oneOf("collapse state", state, SWITCH_STATES) === "on" }),
  },
  {
    words: ["diff", "check"],
    operands: ["[<path,…>]"],
    options: ["clear"],
    summary: "check these changed files in the changelist, the files a commit takes; --clear unchecks all",
    toCommand: ([paths], options, workingDirectory) =>
      tabAction("diff", { name: "check", paths: listOf(clearableOperand("diff check", paths, options) ?? "").map((path) => resolve(workingDirectory, path)) }),
  },
  {
    words: ["diff"],
    operands: [],
    options: [],
    summary: "print the state of the Diff tab: changelist tab, scope, filters, layout, selected and checked files, the changed files",
    toCommand: () => ({ name: "diff" }),
  },
  {
    words: ["git", "filter"],
    operands: [],
    options: ["ref", "text"],
    summary: "filter the Git tab's log by a reference and by text",
    toCommand: gitFilterCommand,
  },
  {
    words: ["git", "select-file"],
    operands: ["[<path>]"],
    options: ["clear"],
    summary: "show the file <path> (relative to the repository) of the selected commit in the Git tab; --clear shows none",
    toCommand: ([path], options) => tabAction("git", { name: "selectFile", path: clearableOperand("git select-file", path, options) }),
  },
  {
    words: ["git", "select"],
    operands: ["[<commit>]"],
    options: ["clear"],
    summary: "select the commit <commit> in the Git tab's log; --clear selects none",
    toCommand: ([commit], options) => tabAction("git", { name: "select", commit: clearableOperand("git select", commit, options) }),
  },
  {
    words: ["git"],
    operands: [],
    options: [],
    summary: "print the state of the Git tab: references, filter, the first commits of the log, the selected commit and file",
    toCommand: () => ({ name: "git" }),
  },
  {
    words: ["editor", "close"],
    operands: ["[<path>]"],
    options: ["all"],
    summary: "close the editor tab of the file <path>, or with --all every tab",
    toCommand: editorCloseCommand,
  },
  {
    words: ["editor", "activate"],
    operands: ["<path>"],
    options: [],
    summary: "bring the open editor tab of the file <path> to the front; `open file` opens one",
    toCommand: ([path], _options, workingDirectory) => tabAction("editor", { name: "activate", path: resolve(workingDirectory, path) }),
  },
  {
    words: ["editor", "back"],
    operands: [],
    options: [],
    summary: "go back to the previous place in the editor",
    toCommand: () => tabAction("editor", { name: "back" }),
  },
  {
    words: ["editor", "forward"],
    operands: [],
    options: [],
    summary: "go forward to the next place in the editor",
    toCommand: () => tabAction("editor", { name: "forward" }),
  },
  {
    words: ["editor", "reveal"],
    operands: ["[<path>]"],
    options: [],
    summary: "reveal the file or folder <path>, or the active file, in the project tree",
    toCommand: ([path], _options, workingDirectory) =>
      tabAction("editor", path === undefined ? { name: "reveal" } : { name: "reveal", path: resolve(workingDirectory, path) }),
  },
  {
    words: ["editor"],
    operands: [],
    options: [],
    summary: "print the state of the Editor tab: panes with their tabs and active files, history",
    toCommand: () => ({ name: "editor" }),
  },
  {
    words: ["pull-request"],
    operands: [],
    options: [],
    summary: "print the state of the Pull request tab: the reviewed pull request, review drafts and threads",
    toCommand: () => ({ name: "pullRequest" }),
  },
  {
    words: ["desktop", "reconnect"],
    operands: [],
    options: [],
    summary: "connect the Desktop tab to the VM's desktop again",
    toCommand: () => tabAction("desktop", { name: "reconnect" }),
  },
  {
    words: ["desktop"],
    operands: [],
    options: [],
    summary: "print the state of the Desktop tab's connection",
    toCommand: () => ({ name: "desktop" }),
  },
  {
    words: ["terminal", "select"],
    operands: ["<key>"],
    options: [],
    summary: "show the terminal tab <key>, as `hunt-client terminal` lists them",
    toCommand: ([key]) => tabAction("terminal", { name: "select", key }),
  },
  {
    words: ["terminal", "new"],
    operands: [],
    options: ["dir", "script"],
    summary: "open a shell in the Terminal tab, in the worktree or --dir, running --script if given",
    toCommand: terminalNewCommand,
  },
  {
    words: ["terminal", "rerun"],
    operands: ["<key>"],
    options: [],
    summary: "run the command of the terminal window <key> again",
    toCommand: ([key]) => tabAction("terminal", { name: "rerun", key }),
  },
  {
    words: ["terminal"],
    operands: [],
    options: [],
    summary: "print the state of the Terminal tab: its tabs with their keys and the active one",
    toCommand: () => ({ name: "terminal" }),
  },
  {
    words: ["factory", "select"],
    operands: ["[<n>]"],
    options: ["clear"],
    summary: "show the run <n> of the pipeline in the Factory tab; --clear lets the tab pick",
    toCommand: ([run], options) => {
      const value = clearableOperand("factory select", run, options);
      if (value !== null && !/^[1-9][0-9]*$/.test(value)) throw new UsageError(`factory select needs the positive number of a run, not ${value}`);
      return tabAction("factory", { name: "select", run: value === null ? null : Number(value) });
    },
  },
  {
    words: ["factory", "refresh"],
    operands: [],
    options: [],
    summary: "load the pipeline of the Factory tab again",
    toCommand: () => tabAction("factory", { name: "refresh" }),
  },
  {
    words: ["factory"],
    operands: [],
    options: [],
    summary: "print the state of the Factory tab: the issue's pipeline, its runs and the one shown",
    toCommand: () => ({ name: "factory" }),
  },
];

/** An error in the arguments, reported with exit code 2 and the help of the command it concerns. */
class UsageError extends Error {}

/**
 * Reads the arguments `argv` of hunt-client (without node and the script): `{ kind: "help", text }` with the help to
 * print, `{ kind: "usageError", message, help }` with the help of the command the error concerns, or
 * `{ kind: "command", command, session }` with the command object for Hunt and the value of `--session` (`undefined`
 * without one), plus `waitsForChecks: true`, `waitsForServices: true` or `waitsForGraph: true` when hunt-client waits
 * for the checks, the services or the diagram the command starts. Relative paths
 * resolve against `workingDirectory`.
 */
export function parseCommandLine(argv, workingDirectory) {
  const loose = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: false });
  const command = findCommand(loose.positionals);
  const help = command ? commandHelp(command) : overviewHelp();
  if (loose.values.help) return { kind: "help", text: help };
  try {
    const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
    if (!command) throw new UsageError(unknownCommandMessage(positionals));
    if (values.session === "") throw new UsageError("--session needs the ID of a Hunt session");
    const parsed = { kind: "command", command: commandObject(command, values, positionals.slice(command.words.length), workingDirectory), session: values.session };
    if (values["no-wait"]) return parsed;
    if (command.waitsForChecks) return { ...parsed, waitsForChecks: true };
    if (command.waitsForServices) return { ...parsed, waitsForServices: true };
    if (command.waitsForGraph) return { ...parsed, waitsForGraph: true };
    return parsed;
  } catch (error) {
    if (!(error instanceof UsageError) && !error?.code?.startsWith("ERR_PARSE_ARGS_")) throw error;
    return { kind: "usageError", message: error.message, help };
  }
}

/** What hunt-client prints and exits with for a reply line of Hunt's control socket: `{ exitCode, stdout, stderr }`. */
export function replyOutcome(line) {
  let reply;
  try {
    reply = JSON.parse(line);
  } catch {
    return failure(1, `Hunt answered ${line}`);
  }
  if (reply?.ok === true) return { exitCode: 0, stdout: resultText(reply.result), stderr: "" };
  if (typeof reply?.error === "string") return failure(1, reply.error);
  return failure(1, `Hunt answered ${line}`);
}

/** What hunt-client prints for the result of a command: nothing without one, a string as it is, anything else as JSON. */
function resultText(result) {
  if (result === undefined || result === null) return "";
  return typeof result === "string" ? `${result}\n` : `${JSON.stringify(result, null, 2)}\n`;
}

/** The report `report` of `hunt-client checks` cut to the check `name`, or whole without a name. */
export function reportOfCheck(report, name) {
  return name === undefined ? report : { ...report, checks: report.checks.filter((check) => check.name === name) };
}

/** Whether a check of the report `report` still runs. */
export function isAnyCheckRunning(report) {
  return report.checks.some((check) => check.state === "running");
}

/** The report `report` of `hunt-client services` cut to the service `name`, or whole without a name. */
export function reportOfService(report, name) {
  return name === undefined ? report : { ...report, services: report.services.filter((service) => service.name === name) };
}

/** Whether a service of the report `report` runs but does not listen on its port yet. */
export function isAnyServiceStarting(report) {
  return report.services.some((service) => service.state === "running" && service.port !== null && !service.isListening);
}

/** Runs hunt-client with `argv` in `environment` and `workingDirectory`; resolves to `{ exitCode, stdout, stderr }`. */
async function run(argv, environment, workingDirectory) {
  const parsed = parseCommandLine(argv, workingDirectory);
  if (parsed.kind === "help") return { exitCode: 0, stdout: parsed.text, stderr: "" };
  if (parsed.kind === "usageError") return { exitCode: 2, stdout: "", stderr: `hunt-client: ${parsed.message}\n\n${parsed.help}` };
  const socketPath = environment.HUNT_CONTROL_SOCKET;
  if (!socketPath) return failure(1, `HUNT_CONTROL_SOCKET is not set; ${OUTSIDE_HUNT}`);
  const session = parsed.session ?? environment.HUNT_SESSION_ID;
  if (!session) return failure(1, `HUNT_SESSION_ID is not set and no --session was given; ${OUTSIDE_HUNT}`);
  const line = JSON.stringify({ type: "ui", session, command: parsed.command });
  const lineBytes = Buffer.byteLength(line) + 1;
  if (lineBytes > MAX_REQUEST_LINE_BYTES) return failure(2, `the request has ${lineBytes} bytes, more than the ${MAX_REQUEST_LINE_BYTES} Hunt reads`);
  try {
    const outcome = replyOutcome(await exchange(socketPath, line));
    if (outcome.exitCode !== 0) return outcome;
    const ask = (name) => () => exchange(socketPath, JSON.stringify({ type: "ui", session, command: { name } }));
    if (parsed.waitsForChecks) return await waitForChecks(ask("checks"), parsed.command.check);
    if (parsed.waitsForServices) return await waitForServices(ask("services"), parsed.command.service);
    if (parsed.waitsForGraph) return await waitForGraph(ask("graph"));
    return outcome;
  } catch (error) {
    return failure(1, `Hunt does not run or did not answer (HUNT_CONTROL_SOCKET=${socketPath}): ${error.message}`);
  }
}

/** Asks for the checks with `askForChecks` until the check `name`, or every check without a name, ended; resolves to the outcome that prints how they ended. */
async function waitForChecks(askForChecks, name) {
  for (;;) {
    const line = await askForChecks();
    const outcome = replyOutcome(line);
    if (outcome.exitCode !== 0) return outcome;
    const report = reportOfCheck(JSON.parse(line).result, name);
    if (!isAnyCheckRunning(report)) return { ...outcome, stdout: resultText(report) };
    await sleep(CHECK_POLL_MS);
  }
}

/**
 * Asks for the services with `askForServices` until the service `name`, or every service without a name, listens on its
 * port or does not run, at most SERVICE_WAIT_MS; resolves to the outcome that prints their state.
 */
async function waitForServices(askForServices, name) {
  const deadline = Date.now() + SERVICE_WAIT_MS;
  for (;;) {
    const line = await askForServices();
    const outcome = replyOutcome(line);
    if (outcome.exitCode !== 0) return outcome;
    const report = reportOfService(JSON.parse(line).result, name);
    if (!isAnyServiceStarting(report) || Date.now() >= deadline) return { ...outcome, stdout: resultText(report) };
    await sleep(SERVICE_POLL_MS);
  }
}

/**
 * Asks for the Architecture tab's state with `askForGraph` until the diagram it shows is no longer generating, at most
 * GRAPH_WAIT_MS; resolves to the outcome that prints that state, or to a failure with the generation's error.
 */
async function waitForGraph(askForGraph) {
  const deadline = Date.now() + GRAPH_WAIT_MS;
  for (;;) {
    const line = await askForGraph();
    const outcome = replyOutcome(line);
    if (outcome.exitCode !== 0) return outcome;
    const state = JSON.parse(line).result;
    if (!state.isGenerating && state.error) return failure(1, `the diagram was not generated: ${state.error}`);
    if (!state.isGenerating || Date.now() >= deadline) return outcome;
    await sleep(GRAPH_POLL_MS);
  }
}

/** Sends `line` to Hunt's control socket at `socketPath`; resolves to the line Hunt answers, without its newline. */
function exchange(socketPath, line) {
  return new Promise((resolveReply, reject) => {
    const socket = connect(socketPath);
    let received = "";
    let isSettled = false;
    const settle = (error, reply) => {
      if (isSettled) return;
      isSettled = true;
      socket.destroy();
      if (error) {
        reject(error);
      } else {
        resolveReply(reply);
      }
    };
    socket.setEncoding("utf8");
    socket.setTimeout(ANSWER_TIMEOUT_MS, () => settle(new Error(`no answer within ${ANSWER_TIMEOUT_MS / 1000} s`)));
    socket.on("connect", () => socket.write(`${line}\n`));
    socket.on("data", (chunk) => {
      received += chunk;
      const newline = received.indexOf("\n");
      if (newline < 0) return;
      settle(undefined, received.slice(0, newline));
    });
    socket.on("error", (error) => settle(error));
    socket.on("close", () => settle(new Error("it closed the connection without an answer")));
  });
}

/** The command object of `command` for its `operands` and parsed `options`; throws a UsageError when they do not fit. */
function commandObject(command, options, operands, workingDirectory) {
  const name = command.words.join(" ");
  for (const option of Object.keys(options)) {
    if (!COMMON_OPTIONS.includes(option) && !command.options.includes(option)) throw new UsageError(`${name} takes no --${option}`);
  }
  const required = command.operands.filter((operand) => !operand.startsWith("["));
  if (operands.length < required.length || operands.some((operand) => !operand)) throw new UsageError(`${name} needs ${(required.length ? required : command.operands).join(" ")}`);
  if (operands.length > command.operands.length) throw new UsageError(`unexpected argument ${operands[command.operands.length]}`);
  return command.toCommand(operands, options, workingDirectory);
}

function openFileCommand([path], options, workingDirectory) {
  const command = { name: "openFile", path: resolve(workingDirectory, path) };
  if (options.line !== undefined && options.match !== undefined) throw new UsageError("open file takes --line or --match, not both");
  if (options.line !== undefined) {
    command.line = positiveInteger("line", options.line);
  }
  if (options.match !== undefined) {
    command.line = matchingLine(command.path, options.match);
  }
  if (options.column !== undefined) {
    command.column = positiveInteger("column", options.column);
  }
  if (options.window) {
    command.window = true;
  }
  return command;
}

/** The 1-based number of the one line of the file at `path` that contains `text`; throws a UsageError when none or several do. */
function matchingLine(path, text) {
  if (!text) throw new UsageError("--match needs the text of a line");
  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    throw new UsageError(`cannot read ${path}: ${error.message}`);
  }
  const lineNumbers = content.split(/\r?\n/).flatMap((line, index) => (line.includes(text) ? [index + 1] : []));
  if (lineNumbers.length === 0) throw new UsageError(`no line of ${path} contains ${text}`);
  if (lineNumbers.length > 1) throw new UsageError(`lines ${lineNumbers.join(", ")} of ${path} contain ${text}; make --match longer or pass --line`);
  return lineNumbers[0];
}

/** The command that runs `action` on the inspector tab `tab`. */
function tabAction(tab, action) {
  return { name: tab, action };
}

/** `operand`, or `null` with `--clear`; throws a UsageError when the command `name` got both or neither. */
function clearableOperand(name, operand, options) {
  if (options.clear && operand !== undefined) throw new UsageError(`${name} takes an argument or --clear, not both`);
  if (options.clear) return null;
  if (operand === undefined) throw new UsageError(`${name} needs an argument or --clear`);
  return operand;
}

/** The items of the comma separated `value`, trimmed, without empty ones. */
function listOf(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** The one option of `names` that `options` holds; throws a UsageError naming the command `name` when it holds none or several. */
function oneOptionOf(name, options, names) {
  const given = names.filter((option) => options[option] !== undefined);
  if (given.length !== 1) throw new UsageError(`${name} takes exactly one of ${names.map((option) => `--${option}`).join(", ")}`);
  return given[0];
}

function graphTablesCommand(_operands, options) {
  const option = oneOptionOf("graph tables", options, ["only-changed", "hide", "show-all"]);
  if (option === "only-changed") return tabAction("graph", { name: "changedTables" });
  const hide = option === "hide" ? listOf(options.hide) : [];
  if (option === "hide" && hide.length === 0) throw new UsageError("--hide needs the ids of tables");
  return tabAction("graph", { name: "tables", hide });
}

function graphFilesCommand(_operands, options, workingDirectory) {
  const option = oneOptionOf("graph files", options, ["exclude", "show-all"]);
  const exclude = option === "exclude" ? listOf(options.exclude).map((path) => resolve(workingDirectory, path)) : [];
  if (option === "exclude" && exclude.length === 0) throw new UsageError("--exclude needs the paths of files");
  return tabAction("graph", { name: "files", exclude });
}

function graphFilterCommand(_operands, options) {
  if (options["min-review"] === undefined && options["hide-globs"] === undefined) throw new UsageError("graph filter needs --min-review or --hide-globs");
  const action = { name: "filter" };
  if (options["min-review"] !== undefined) {
    action.minReview = Number(oneOf("review level", options["min-review"], REVIEW_LEVELS));
  }
  if (options["hide-globs"] !== undefined) {
    action.hiddenGlobs = options["hide-globs"];
  }
  return tabAction("graph", action);
}

function gitFilterCommand(_operands, options) {
  if (options.ref === undefined && options.text === undefined) throw new UsageError("git filter needs --ref or --text");
  const action = { name: "filter" };
  if (options.ref !== undefined) {
    if (!options.ref) throw new UsageError("--ref needs a reference");
    action.reference = options.ref;
  }
  if (options.text !== undefined) {
    action.text = options.text;
  }
  return tabAction("git", action);
}

function editorCloseCommand([path], options, workingDirectory) {
  if (options.all && path !== undefined) throw new UsageError("editor close takes a path or --all, not both");
  if (options.all) return tabAction("editor", { name: "closeAll" });
  if (path === undefined) throw new UsageError("editor close needs a path or --all");
  return tabAction("editor", { name: "close", path: resolve(workingDirectory, path) });
}

function terminalNewCommand(_operands, options, workingDirectory) {
  const action = { name: "new" };
  if (options.dir !== undefined) {
    if (!options.dir) throw new UsageError("--dir needs a folder");
    action.directory = resolve(workingDirectory, options.dir);
  }
  if (options.script !== undefined) {
    if (!options.script) throw new UsageError("--script needs the name of a package script");
    action.script = options.script;
  }
  return tabAction("terminal", action);
}

function openSettingsCommand(_operands, options) {
  if (options.page === undefined) return { name: "openSettings" };
  return { name: "openSettings", page: oneOf("settings page", options.page, SETTINGS_PAGES) };
}

/** `value` as a number when it is a positive integer; throws a UsageError naming the option `name` otherwise. */
function positiveInteger(name, value) {
  const number = Number(value);
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(number)) throw new UsageError(`--${name} needs a positive integer, not ${value}`);
  return number;
}

/** `value` when `allowed` holds it; throws a UsageError naming `what` otherwise. */
function oneOf(what, value, allowed) {
  if (!allowed.includes(value)) throw new UsageError(`unknown ${what} ${value}; it is one of ${allowed.join(", ")}`);
  return value;
}

/** The command whose words begin `positionals`. */
function findCommand(positionals) {
  return COMMANDS.find((command) => command.words.every((word, position) => positionals[position] === word));
}

/** Why `positionals` name no command. */
function unknownCommandMessage(positionals) {
  const [first, second] = positionals;
  if (!first) return "no command given";
  const subcommands = COMMANDS.filter((command) => command.words.length > 1 && command.words[0] === first).map((command) => command.words[1]);
  if (subcommands.length === 0) return `unknown command ${first}`;
  if (!second) return `${first} needs one of ${subcommands.join(", ")}`;
  return `unknown command ${first} ${second}`;
}

/** The help of hunt-client: its usage, every command and the options every command takes. */
function overviewHelp() {
  const commandRows = COMMANDS.map((command) => [usageOf(command, command.options), command.summary]);
  return [
    "usage: hunt-client [--session <id>] <command> [<arguments>]",
    "",
    "Shows the user something in Hunt, the app that started this agent: reads and sets what each tab of the session's inspector shows (`hunt-client <tab>` prints a tab's state as JSON, `hunt-client <tab> <verb>` changes it and shows the tab), runs the checks of its Checks tab and starts the services of hunt.json in its Terminal tab. Prints nothing when it worked, except for the commands that print a state or a report.",
    "",
    "Commands:",
    ...listing(commandRows, OVERVIEW_COLUMN),
    "",
    "Options of every command:",
    ...listing(COMMON_OPTIONS.map(optionRow), OVERVIEW_COLUMN),
    "",
    "`hunt-client <command> --help` describes a command. Paths are relative to the working directory.",
    "Exit codes: 0 done, also when a check failed, 1 Hunt answered an error or is not reachable, 2 usage error.",
    "",
  ].join("\n");
}

/** The help of `command`: its usage, what it shows the user, its options and, for a command such as `graph`, the commands it begins. */
function commandHelp(command) {
  const optionRows = [...command.options, ...COMMON_OPTIONS].map(optionRow);
  const subcommandRows = COMMANDS.filter((other) => other !== command && command.words.every((word, position) => other.words[position] === word)).map(
    (other) => [usageOf(other, other.options), other.summary],
  );
  return [
    `usage: hunt-client ${usageOf(command, [...command.options, "session"])}`,
    "",
    `${command.summary[0].toUpperCase()}${command.summary.slice(1)}.`,
    "",
    ...(subcommandRows.length ? ["Commands:", ...listing(subcommandRows, OVERVIEW_COLUMN), ""] : []),
    "Options:",
    ...listing(optionRows, Math.max(...optionRows.map(([label]) => label.length)) + 4),
    "",
  ].join("\n");
}

/** The words and operands of `command`, followed by the options `optionNames` in brackets. */
function usageOf(command, optionNames) {
  return [...command.words, ...command.operands, ...optionNames.map((name) => `[${optionLabel(name)}]`)].join(" ");
}

/** `--<name> <placeholder>`, or `--<name>` for a flag. */
function optionLabel(name) {
  const { placeholder } = OPTIONS[name];
  return placeholder ? `--${name} ${placeholder}` : `--${name}`;
}

/** The listing row of the option `name`: its label, short form first, and its description. */
function optionRow(name) {
  const { short, description } = OPTIONS[name];
  return [short ? `-${short}, ${optionLabel(name)}` : optionLabel(name), description];
}

/** The lines of a listing of `[label, description]` rows whose descriptions start at `column`; a longer label puts its description on the next line. */
function listing(rows, column) {
  return rows.flatMap(([label, description]) => {
    const indentedLabel = `  ${label}`;
    if (indentedLabel.length + 2 > column) return [indentedLabel, `${" ".repeat(column)}${description}`];
    return [`${indentedLabel.padEnd(column)}${description}`];
  });
}

function failure(exitCode, message) {
  return { exitCode, stdout: "", stderr: `hunt-client: ${message}\n` };
}

async function main() {
  const { exitCode, stdout, stderr } = await run(process.argv.slice(2), process.env, process.cwd());
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = exitCode;
}

// Node resolves symlinks in the module's URL, not in argv.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
