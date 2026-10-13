/**
 * The preview supervisor's core, free of processes, sockets and files (`runtime.ts` wires it up). It runs the plan that
 * `hunt-ctl` applies (see `contract.ts`) in the session container: an apply stops what runs, opens the service
 * forwards, runs the `prepare` steps, then the `init` steps unless `init.json` records that they succeeded for this data
 * generation and init hash, and starts all processes at once. Steps and processes run in process groups of their own;
 * stopping one sends SIGTERM to its group and SIGKILL 10 s later. A process with a port is ready once it accepts
 * connections and its `ready` path answers below 500. A process that exits on its own restarts after 1, 2, 4 … 30 s;
 * after five such exits within two minutes it stays `crashed` until it is started by hand.
 *
 * `preview.json` reports the state whenever it changes. `applied.json` keeps the applied plan with the boot ID, so a
 * relay that restarts within the same boot of the VM resumes it; after a reboot the preview waits for a new apply.
 */
import { join } from "node:path";
import { isRecord } from "../jsonRpc.ts";
import { messageOf } from "../relay.ts";
import { parsePlan, previewUrlEnv, SETUP_LOG, type PlanForward, type PlanProcess, type PlanStep, type PlanUrls, type PreviewPlan } from "./contract.ts";

export const STOP_GRACE_MS = 10_000;
export const READY_INTERVAL_MS = 1_000;
export const CRASH_WINDOW_MS = 120_000;
export const MAX_CRASHES = 5;
export const MAX_BACKOFF_MS = 30_000;
const GROUP_POLL_MS = 100;
/** How long the processes of a killed group may take to disappear. */
const KILL_WAIT_MS = 1_000;
/** Plain output for the logs: no colors, no interactive terminal UI of Nx. */
const PLAIN_OUTPUT_ENV = { NO_COLOR: "1", NX_TUI: "false" };

export type PreviewState = "idle" | "preparing" | "init" | "starting" | "ready" | "degraded" | "failed" | "stopped";
export type ProcessState = "starting" | "ready" | "crashed" | "stopped";

export interface ProcessStatus {
  state: ProcessState;
  pid: number | null;
  /** Automatic restarts since the process was last started by an apply or by hand. */
  restarts: number;
  /** Of the last exit; 128 + the signal number after a signal. */
  exitCode: number | null;
  readyAt: number | null;
}

/** `preview.json`; times are Unix milliseconds. */
export interface PreviewStatus {
  /** Counts applies; the status of an apply carries the generation the apply answered with. */
  generation: number;
  state: PreviewState;
  /** The step that runs, or the one that failed. */
  step: string | null;
  error: string | null;
  urls: PlanUrls | null;
  processes: Record<string, ProcessStatus>;
  updatedAt: number;
}

/** How a step or process ended: its exit code (128 + the signal number after a signal), or why it could not start. */
export interface ExitResult {
  code: number | null;
  error: string | null;
}

/** A started step or process, leader of its process group; `pid` is null when it could not be started. */
export interface ChildHandle {
  pid: number | null;
  exited: Promise<ExitResult>;
}

export interface LogSink {
  write(chunk: string | Uint8Array): void;
  /** Writes `text` as a line of its own. */
  line(text: string): void;
  close(): void;
}

export interface ForwardHandle {
  close(): Promise<void>;
}

export interface SpawnRequest {
  run: string;
  cwd: string;
  env: Record<string, string>;
  output: LogSink;
}

export type GroupSignal = "SIGTERM" | "SIGKILL" | 0;
export type StateFile = "preview.json" | "applied.json" | "init.json";

export interface SupervisorDependencies {
  /** Starts `run` with bash in a process group of its own; stdout and stderr go to `output`. */
  spawn(request: SpawnRequest): ChildHandle;
  /** Signals the process group `pgid`; false when none of its processes is left. Signal 0 only checks. */
  signalGroup(pgid: number, signal: GroupSignal): boolean;
  /** One readiness check of a process; never rejects. */
  probe(process: PlanProcess): Promise<boolean>;
  startForward(forward: PlanForward): Promise<ForwardHandle>;
  openLog(name: string): LogSink;
  /** The parsed file in the state directory; undefined when it is missing or unreadable. */
  readState(name: StateFile): unknown;
  writeState(name: StateFile, value: unknown): void;
  /** The session's worktree, base of every `cwd`; may throw. */
  worktree(): string;
  /** The environment steps and processes start from. */
  baseEnv(): Record<string, string>;
  /** The session this container runs; an apply of another session's plan is refused. Null skips the check. */
  sessionId: string | null;
  bootId(): string | null;
  now(): number;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
  log(message: string): void;
}

/** `applied.json`. */
interface AppliedPlan {
  generation: number;
  bootId: string | null;
  dataGeneration: string;
  /** False after a stop; a plan that was running resumes when the relay restarts within the same boot. */
  running: boolean;
  plan: PreviewPlan;
}

/** One start of a plan, from its forwards to its processes. */
interface Run {
  /** The request that started it; a newer apply or stop makes the run stale. */
  request: number;
  plan: PreviewPlan;
  dataGeneration: string;
  isCancelled: boolean;
  forwards: ForwardHandle[];
  /** The step that runs now. */
  step: ChildHandle | null;
  runners: Map<string, ProcessRunner>;
  /** Settles when `execute` returned; the run creates nothing after that. */
  finished: Promise<void>;
}

type Timers = Pick<SupervisorDependencies, "now" | "setTimer" | "clearTimer">;
type Groups = Timers & Pick<SupervisorDependencies, "signalGroup">;

export class PreviewSupervisor {
  private readonly deps: SupervisorDependencies;
  private generation = 0;
  private plan: PreviewPlan | null = null;
  private dataGeneration: string | null = null;
  /** The state while no processes run: before they start, after a failure, after a stop. */
  private phase: PreviewState = "idle";
  private step: string | null = null;
  private error: string | null = null;
  private run: Run | null = null;
  /** Counts apply, resume, stop and shutdown requests; work queued for an older request gives up. */
  private requests = 0;
  private transitions: Promise<void> = Promise.resolve();
  private readonly children = new Set<ChildHandle>();
  private readonly logs = new Map<string, LogSink>();
  private publishedStatus = "";
  private updatedAt = 0;

  constructor(deps: SupervisorDependencies) {
    this.deps = deps;
  }

  /** Picks up `applied.json` when the relay starts: a plan that was running in this boot starts again. */
  resume(): void {
    const applied = this.readApplied();
    if (!applied) {
      this.publish();
      return;
    }
    this.generation = applied.generation;
    this.plan = applied.plan;
    this.dataGeneration = applied.dataGeneration;
    const bootId = this.deps.bootId();
    if (!applied.running || !bootId || applied.bootId !== bootId) {
      if (applied.running) {
        this.deps.log(`not resuming the preview of generation ${applied.generation}: the VM restarted since it was applied`);
      }
      this.setPhase("stopped");
      return;
    }
    this.deps.log(`resuming the preview of generation ${applied.generation}`);
    this.begin(applied.plan, applied.dataGeneration);
  }

  /** Replaces whatever runs with `plan`; returns at once, the start goes on in the background. */
  apply(plan: PreviewPlan, dataGeneration: string): PreviewStatus {
    if (this.deps.sessionId && plan.sessionId !== this.deps.sessionId) {
      throw new Error(`the plan is for the session ${plan.sessionId}, this container runs ${this.deps.sessionId}`);
    }
    this.generation++;
    this.plan = plan;
    this.dataGeneration = dataGeneration;
    this.saveApplied(true);
    this.begin(plan, dataGeneration);
    return this.status();
  }

  /** Stops the steps, processes and forwards; resolves once they are gone. The plan does not resume. */
  async stop(): Promise<PreviewStatus> {
    this.requests++;
    if (this.plan) {
      this.saveApplied(false);
      this.setPhase("stopped");
    }
    await this.enqueue(() => this.teardown());
    return this.status();
  }

  /** Stops everything because the relay exits; unlike `stop`, the next relay of this boot resumes the plan. */
  async shutdown(): Promise<void> {
    this.requests++;
    if (this.plan) {
      this.setPhase("stopped");
    }
    await this.enqueue(() => this.teardown());
    for (const log of this.logs.values()) {
      log.close();
    }
    this.logs.clear();
  }

  /** Sends SIGKILL to every step and process group, for a relay that cannot wait any longer; nothing restarts. */
  kill(): void {
    this.requests++;
    if (this.run) {
      this.run.isCancelled = true;
      for (const runner of this.run.runners.values()) {
        runner.abandon();
      }
    }
    for (const child of this.children) {
      if (child.pid !== null) {
        this.deps.signalGroup(child.pid, "SIGKILL");
      }
    }
  }

  /** Starts a stopped or crashed process; a running one keeps running. */
  startProcess(name: string): PreviewStatus {
    this.runnerOf(name).start();
    return this.status();
  }

  async stopProcess(name: string): Promise<PreviewStatus> {
    await this.runnerOf(name).stop();
    return this.status();
  }

  async restartProcess(name: string): Promise<PreviewStatus> {
    await this.runnerOf(name).restart();
    return this.status();
  }

  status(): PreviewStatus {
    const run = this.currentRun();
    const processes: Record<string, ProcessStatus> = {};
    for (const spec of this.plan?.processes ?? []) {
      processes[spec.name] = run?.runners.get(spec.name)?.status() ?? { state: "stopped", pid: null, restarts: 0, exitCode: null, readyAt: null };
    }
    const { generation, step, error, updatedAt } = this;
    return { generation, state: this.overallState(run), step, error, urls: this.plan?.urls ?? null, processes, updatedAt };
  }

  /** Tears the current run down and starts `plan` afterwards, unless a newer request came meanwhile. */
  private begin(plan: PreviewPlan, dataGeneration: string): void {
    const request = ++this.requests;
    this.setPhase("preparing");
    void this.enqueue(async () => {
      await this.teardown();
      if (request !== this.requests) return;
      const run: Run = { request, plan, dataGeneration, isCancelled: false, forwards: [], step: null, runners: new Map(), finished: Promise.resolve() };
      this.run = run;
      run.finished = this.execute(run);
    });
  }

  /** Runs `task` after the transitions queued before it; a failure is logged. */
  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.transitions.then(task).catch((error: unknown) => this.deps.log(`failed to change the preview: ${messageOf(error)}`));
    this.transitions = next;
    return next;
  }

  private async execute(run: Run): Promise<void> {
    const { plan } = run;
    try {
      const worktree = this.deps.worktree();
      for (const forward of plan.forwards) {
        run.forwards.push(await this.openForward(forward));
        if (!this.isCurrent(run)) return;
      }
      if (!(await this.runSteps(run, worktree, "preparing", plan.prepare))) return;
      if (this.needsInit(plan, run.dataGeneration)) {
        if (!(await this.runSteps(run, worktree, "init", plan.init))) return;
        this.writeState("init.json", { dataGeneration: run.dataGeneration, initHash: plan.initHash });
      } else if (plan.init.length > 0) {
        this.note(SETUP_LOG, `init steps skipped: they ran for data generation ${run.dataGeneration} already`);
      }
      this.startProcesses(run, worktree);
    } catch (error) {
      if (!this.isCurrent(run)) return;
      this.deps.log(`the preview failed: ${messageOf(error)}`);
      this.setPhase("failed", this.step, messageOf(error));
    }
  }

  /** Runs `steps` one after another; false when the run was cancelled meanwhile. Throws when a step fails. */
  private async runSteps(run: Run, worktree: string, phase: "preparing" | "init", steps: PlanStep[]): Promise<boolean> {
    const kind = phase === "init" ? "init" : "prepare";
    for (const step of steps) {
      if (!this.isCurrent(run)) return false;
      this.setPhase(phase, step.name);
      this.note(SETUP_LOG, `${kind} step ${step.name}: ${step.run}`);
      const output = this.logOf(SETUP_LOG);
      const child = this.spawn({ run: step.run, cwd: join(worktree, step.cwd), env: this.environment(run.plan, step.env), output });
      run.step = child;
      const exit = await child.exited;
      await terminate(this.deps, child);
      run.step = null;
      if (!this.isCurrent(run)) return false;
      const outcome = exit.error ? `failed to start: ${exit.error}` : `exited with code ${exit.code}`;
      this.note(SETUP_LOG, `${kind} step ${step.name} ${outcome}`);
      if (exit.code !== 0) throw new Error(`the ${kind} step ${step.name} ${outcome}`);
    }
    return true;
  }

  private needsInit(plan: PreviewPlan, dataGeneration: string): boolean {
    if (plan.init.length === 0) return false;
    const done = this.deps.readState("init.json");
    return !isRecord(done) || done.dataGeneration !== dataGeneration || done.initHash !== plan.initHash;
  }

  private startProcesses(run: Run, worktree: string): void {
    if (!this.isCurrent(run)) return;
    for (const spec of run.plan.processes) {
      const runner = new ProcessRunner(spec, {
        groups: this.deps,
        probe: (process) => this.deps.probe(process),
        spawn: (request) => this.spawn(request),
        output: this.logOf(spec.name),
        cwd: join(worktree, spec.cwd),
        env: this.environment(run.plan, spec.env),
        note: (text) => this.note(spec.name, text),
        changed: () => this.publish(),
      });
      run.runners.set(spec.name, runner);
    }
    this.setPhase("starting");
    for (const runner of run.runners.values()) {
      runner.start();
    }
  }

  /** Cancels the run and resolves once its steps, processes and forwards are gone. */
  private async teardown(): Promise<void> {
    const run = this.run;
    if (!run) return;
    this.run = null;
    run.isCancelled = true;
    await Promise.all([run.step ? terminate(this.deps, run.step) : undefined, run.finished]);
    await Promise.all([...run.runners.values()].map((runner) => runner.stop()));
    await Promise.all(run.forwards.map((forward) => forward.close().catch((error: unknown) => this.deps.log(`failed to close a forward: ${messageOf(error)}`))));
  }

  private isCurrent(run: Run): boolean {
    return !run.isCancelled && run.request === this.requests;
  }

  private currentRun(): Run | null {
    return this.run && this.run.request === this.requests ? this.run : null;
  }

  /** The phase, or once processes run: degraded when one crashed or was stopped, else starting until all are ready. */
  private overallState(run: Run | null): PreviewState {
    const states = [...(run?.runners.values() ?? [])].map((runner) => runner.status().state);
    if (states.length === 0) return this.phase;
    if (states.some((state) => state === "crashed" || state === "stopped")) return "degraded";
    return states.includes("starting") ? "starting" : "ready";
  }

  private runnerOf(name: string): ProcessRunner {
    const run = this.currentRun();
    const runner = run?.runners.get(name);
    if (runner) return runner;
    const names = this.plan?.processes.map((spec) => spec.name) ?? [];
    if (!names.includes(name)) throw new Error(names.length > 0 ? `the preview has no process ${name}; it has ${names.join(", ")}` : "no preview has been applied");
    const state = this.overallState(run);
    if (state === "preparing" || state === "init") throw new Error(`the preview runs its ${state === "init" ? "init" : "prepare"} steps; ${name} starts after them`);
    throw new Error(`${state === "failed" ? "the preview failed" : "the preview is stopped"}; ${name} runs again once the preview is started from Hunt`);
  }

  /** Starts a step or process and tracks it until it exits, for `kill`. */
  private spawn(request: SpawnRequest): ChildHandle {
    const child = this.deps.spawn(request);
    this.children.add(child);
    void child.exited.then(() => this.children.delete(child));
    return child;
  }

  /** The relay's environment, the plan's, the item's own, then what the supervisor sets for every step and process. */
  private environment(plan: PreviewPlan, own: Record<string, string>): Record<string, string> {
    return { ...this.deps.baseEnv(), ...plan.env, ...own, ...PLAIN_OUTPUT_ENV, ...previewUrlEnv(plan) };
  }

  private async openForward(forward: PlanForward): Promise<ForwardHandle> {
    try {
      return await this.deps.startForward(forward);
    } catch (error) {
      throw new Error(`failed to forward 127.0.0.1:${forward.port} to ${forward.host}:${forward.port}: ${messageOf(error)}`);
    }
  }

  private logOf(name: string): LogSink {
    let log = this.logs.get(name);
    if (!log) {
      log = this.deps.openLog(name);
      this.logs.set(name, log);
    }
    return log;
  }

  /** A line of the supervisor's own in the log `name`. */
  private note(name: string, text: string): void {
    this.logOf(name).line(`[hunt-preview ${new Date(this.deps.now()).toISOString()}] ${text}`);
  }

  private setPhase(phase: PreviewState, step: string | null = null, error: string | null = null): void {
    this.phase = phase;
    this.step = step;
    this.error = error;
    this.publish();
  }

  /** Writes `preview.json` when the status changed; `updatedAt` alone is no change. */
  private publish(): void {
    const status: Partial<PreviewStatus> = this.status();
    delete status.updatedAt;
    const key = JSON.stringify(status);
    if (key === this.publishedStatus) return;
    this.publishedStatus = key;
    this.updatedAt = this.deps.now();
    this.writeState("preview.json", this.status());
  }

  private saveApplied(running: boolean): void {
    if (!this.plan || this.dataGeneration === null) return;
    const applied: AppliedPlan = { generation: this.generation, bootId: this.deps.bootId(), dataGeneration: this.dataGeneration, running, plan: this.plan };
    this.writeState("applied.json", applied);
  }

  private readApplied(): AppliedPlan | null {
    const value = this.deps.readState("applied.json");
    if (value === undefined) return null;
    try {
      if (!isRecord(value)) throw new Error("expected a JSON object");
      const { generation, bootId, dataGeneration, running } = value;
      if (typeof generation !== "number" || !Number.isInteger(generation) || generation < 1) throw new Error("generation must be a positive integer");
      if (bootId !== null && typeof bootId !== "string") throw new Error("bootId must be a string or null");
      if (typeof dataGeneration !== "string") throw new Error("dataGeneration must be a string");
      if (typeof running !== "boolean") throw new Error("running must be true or false");
      return { generation, bootId, dataGeneration, running, plan: parsePlan(value.plan) };
    } catch (error) {
      this.deps.log(`ignored applied.json: ${messageOf(error)}`);
      return null;
    }
  }

  private writeState(name: StateFile, value: unknown): void {
    try {
      this.deps.writeState(name, value);
    } catch (error) {
      this.deps.log(`failed to write ${name}: ${messageOf(error)}`);
    }
  }
}

interface RunnerContext {
  groups: Groups;
  probe(process: PlanProcess): Promise<boolean>;
  spawn(request: SpawnRequest): ChildHandle;
  output: LogSink;
  cwd: string;
  env: Record<string, string>;
  note(text: string): void;
  changed(): void;
}

/** One process of a run: starts it, checks its readiness, restarts it after a crash and stops it. */
class ProcessRunner {
  private readonly spec: PlanProcess;
  private readonly context: RunnerContext;
  private state: ProcessState = "stopped";
  private child: ChildHandle | null = null;
  /** The child a stop is ending; its exit is no crash. */
  private stoppingChild: ChildHandle | null = null;
  private restarts = 0;
  private exitCode: number | null = null;
  private readyAt: number | null = null;
  /** Whether the process should run: set by start, cleared by stop and by too many crashes. */
  private isWanted = false;
  /** When the process exited on its own within the last CRASH_WINDOW_MS. */
  private crashes: number[] = [];
  /** Crashes since the process last ran for CRASH_WINDOW_MS; the backoff grows with them. */
  private streak = 0;
  private startedAt = 0;
  /** Counts spawns, so a readiness check of an earlier spawn is ignored. */
  private attempt = 0;
  /** The readiness check while the process runs, the restart delay after a crash. */
  private timer: unknown = null;
  /** The end of a process group: a stop, or what a crashed process left behind. */
  private settling: Promise<void> | null = null;

  constructor(spec: PlanProcess, context: RunnerContext) {
    this.spec = spec;
    this.context = context;
  }

  status(): ProcessStatus {
    return { state: this.state, pid: this.child?.pid ?? null, restarts: this.restarts, exitCode: this.exitCode, readyAt: this.readyAt };
  }

  /** Starts the process unless it runs, also during a restart delay; restarts, crashes and backoff count from zero. */
  start(): void {
    if (this.child && !this.stoppingChild) return;
    this.isWanted = true;
    this.restarts = 0;
    this.crashes = [];
    this.streak = 0;
    this.cancelTimer();
    this.spawnWhenSettled();
  }

  /** Stops the process for good; resolves once its process group is gone. */
  stop(): Promise<void> {
    this.isWanted = false;
    this.cancelTimer();
    if (!this.child && this.state !== "stopped") {
      this.state = "stopped";
      this.context.changed();
    }
    const child = this.child;
    if (child && !this.stoppingChild) {
      this.stoppingChild = child;
      this.context.note(`${this.spec.name} stops`);
      this.settle(terminate(this.context.groups, child));
    }
    return this.settling ?? Promise.resolve();
  }

  async restart(): Promise<void> {
    await this.stop();
    this.start();
  }

  /** Sends SIGKILL to the process group and gives the process up without waiting for it. */
  abandon(): void {
    this.isWanted = false;
    this.cancelTimer();
    if (this.child?.pid) {
      this.context.groups.signalGroup(this.child.pid, "SIGKILL");
    }
  }

  /** Spawns once the previous process group is gone, unless the process is no longer wanted or runs by then. */
  private spawnWhenSettled(): void {
    if (!this.settling) {
      this.spawn();
      return;
    }
    void this.settling.then(() => {
      if (this.isWanted && !this.child && this.timer === null) {
        this.spawnWhenSettled();
      }
    });
  }

  private spawn(): void {
    const attempt = ++this.attempt;
    this.state = "starting";
    this.readyAt = null;
    this.startedAt = this.context.groups.now();
    this.context.note(`${this.spec.name} starts: ${this.spec.run}`);
    const child = this.context.spawn({ run: this.spec.run, cwd: this.context.cwd, env: this.context.env, output: this.context.output });
    this.child = child;
    void child.exited.then((exit) => this.exited(child, exit));
    if (child.pid !== null && this.spec.port === null) {
      this.markReady();
    } else if (child.pid !== null) {
      this.checkReadiness(attempt);
    }
    this.context.changed();
  }

  private checkReadiness(attempt: number): void {
    this.timer = this.context.groups.setTimer(() => {
      this.timer = null;
      void this.context.probe(this.spec).then(
        (isReady) => this.probed(attempt, isReady),
        () => this.probed(attempt, false),
      );
    }, READY_INTERVAL_MS);
  }

  private probed(attempt: number, isReady: boolean): void {
    if (attempt !== this.attempt || !this.child || this.stoppingChild || this.state !== "starting") return;
    if (isReady) {
      this.markReady();
    } else {
      this.checkReadiness(attempt);
    }
  }

  private markReady(): void {
    this.state = "ready";
    this.readyAt = this.context.groups.now();
    this.context.note(`${this.spec.name} is ready`);
    this.context.changed();
  }

  private exited(child: ChildHandle, exit: ExitResult): void {
    if (this.child !== child) return;
    const wasStopped = this.stoppingChild === child;
    this.child = null;
    this.stoppingChild = null;
    this.exitCode = exit.code;
    this.readyAt = null;
    this.cancelTimer();
    this.context.note(`${this.spec.name} ${exit.error ? `failed to start: ${exit.error}` : `exited with code ${exit.code}`}`);
    if (wasStopped || !this.isWanted) {
      this.state = "stopped";
      this.context.changed();
      return;
    }
    this.crashed(child);
  }

  /** Ends what the process left in its group, then restarts it after the backoff or gives up after too many crashes. */
  private crashed(child: ChildHandle): void {
    const now = this.context.groups.now();
    if (now - this.startedAt >= CRASH_WINDOW_MS) {
      this.streak = 0;
    }
    this.streak++;
    this.crashes = [...this.crashes.filter((at) => now - at < CRASH_WINDOW_MS), now];
    this.settle(terminate(this.context.groups, child));
    if (this.crashes.length >= MAX_CRASHES) {
      this.isWanted = false;
      this.state = "crashed";
      this.context.note(`${this.spec.name} crashed ${MAX_CRASHES} times within ${CRASH_WINDOW_MS / 60_000} minutes; it stays stopped until it is started by hand`);
      this.context.changed();
      return;
    }
    const delay = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** (this.streak - 1));
    this.state = "starting";
    this.context.note(`${this.spec.name} restarts in ${delay / 1_000} s`);
    this.timer = this.context.groups.setTimer(() => {
      this.timer = null;
      this.restarts++;
      this.spawnWhenSettled();
    }, delay);
    this.context.changed();
  }

  private settle(work: Promise<void>): void {
    const settling: Promise<void> = work.finally(() => {
      if (this.settling === settling) {
        this.settling = null;
      }
    });
    this.settling = settling;
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    this.context.groups.clearTimer(this.timer);
    this.timer = null;
  }
}

function sleep(timers: Timers, ms: number): Promise<void> {
  return new Promise((resolve) => {
    timers.setTimer(resolve, ms);
  });
}

/** Whether `promise` settles before `deadline`. */
function settlesBefore(timers: Timers, promise: Promise<unknown>, deadline: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = timers.setTimer(() => resolve(false), Math.max(0, deadline - timers.now()));
    void promise.then(() => {
      timers.clearTimer(timer);
      resolve(true);
    });
  });
}

/** Waits until no process of group `pgid` is left; false when some remain at `deadline`. */
async function groupEmptied(groups: Groups, pgid: number, deadline: number): Promise<boolean> {
  while (groups.signalGroup(pgid, 0)) {
    if (groups.now() >= deadline) return false;
    await sleep(groups, GROUP_POLL_MS);
  }
  return true;
}

/**
 * Ends the process group `child` leads: SIGTERM, and SIGKILL to whatever is left after STOP_GRACE_MS. Also ends what a
 * leader that exited already left behind. Resolves once the group is gone.
 */
async function terminate(groups: Groups, child: ChildHandle): Promise<void> {
  const pgid = child.pid;
  if (pgid === null) {
    await child.exited;
    return;
  }
  groups.signalGroup(pgid, "SIGTERM");
  const deadline = groups.now() + STOP_GRACE_MS;
  if ((await settlesBefore(groups, child.exited, deadline)) && (await groupEmptied(groups, pgid, deadline))) return;
  groups.signalGroup(pgid, "SIGKILL");
  await child.exited;
  await groupEmptied(groups, pgid, groups.now() + KILL_WAIT_MS);
}
