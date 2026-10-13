import { describe, expect, it } from "vitest";
import { buildPlan, type PlanForward, type PreviewPlan } from "./contract.ts";
import type { Readiness } from "./probe.ts";
import {
  CRASH_WINDOW_MS,
  PreviewSupervisor,
  READY_INTERVAL_MS,
  STOP_GRACE_MS,
  type ChildHandle,
  type ExitResult,
  type GroupSignal,
  type LogSink,
  type SpawnRequest,
  type SupervisorDependencies,
} from "./supervisor.ts";

const SESSION_ID = "7c0c6f2e-1234-4abc-8def-0123456789ab";
const DOMAIN = "preview.example.com";
const WORKTREE = `/srv/worktrees/${SESSION_ID}`;
const BOOT_ID = "boot-1";
const START = Date.UTC(2026, 9, 13, 10, 0, 0);
const BASE_ENV = { HOME: "/home/agent", PATH: "/usr/bin" };
const PREVIEW = {
  services: { db: { kind: "postgres-18" } },
  env: { DATABASE_URL: "postgres://127.0.0.1:5432/app" },
  prepare: [
    { name: "install", run: "npm ci" },
    { name: "build", run: "npm run build", cwd: "apps/api" },
  ],
  init: [{ name: "seed", run: "npm run seed", env: { SEED: "1" } }],
  processes: {
    api: { run: "npm run api", port: 3000, ready: "/health", main: true, env: { PORT: "3000" } },
    worker: { run: "npm run worker", cwd: "apps/worker" },
  },
};
const WEB_ONLY = { processes: { web: { run: "npm run dev", port: 3000, main: true } } };
const URL_ENV = {
  NO_COLOR: "1",
  NX_TUI: "false",
  HUNT_PREVIEW_URL: "https://7c0c6f2e.preview.example.com",
  HUNT_PREVIEW_URL_3000: "https://7c0c6f2e-3000.preview.example.com",
};

function planOf(preview: Record<string, unknown>): PreviewPlan {
  return buildPlan({ preview }, { sessionId: SESSION_ID, domain: DOMAIN });
}

/** Lets every pending promise continuation run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

interface FakeTimer {
  id: number;
  at: number;
  callback: () => void;
}

/** Time that moves only when a test advances it; due timers run in order, each followed by the promises it settles. */
class FakeClock {
  now = START;
  private nextId = 1;
  private readonly timers = new Map<number, Omit<FakeTimer, "id">>();

  set(callback: () => void, ms: number): number {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + ms, callback });
    return id;
  }

  clear(timer: unknown): void {
    this.timers.delete(timer as number);
  }

  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    await settle();
    for (let due = this.nextDue(target); due; due = this.nextDue(target)) {
      this.timers.delete(due.id);
      this.now = due.at;
      due.callback();
      await settle();
    }
    this.now = target;
    await settle();
  }

  private nextDue(target: number): FakeTimer | undefined {
    let next: FakeTimer | undefined;
    for (const [id, timer] of this.timers) {
      if (timer.at <= target && (!next || timer.at < next.at)) {
        next = { id, ...timer };
      }
    }
    return next;
  }
}

/** A started step or process; a SIGTERM to its group ends it unless it ignores SIGTERM, a SIGKILL always does. */
interface FakeChild extends ChildHandle {
  pid: number;
  request: SpawnRequest;
  isRunning: boolean;
  ignoresTerm: boolean;
  /** Processes of its group that outlive it until SIGTERM (or SIGKILL when it ignores SIGTERM). */
  hasStragglers: boolean;
  signals: GroupSignal[];
  exit(code: number): void;
}

function fakeChild(pid: number, request: SpawnRequest): FakeChild {
  let resolveExit: (exit: ExitResult) => void = () => {};
  const exited = new Promise<ExitResult>((resolve) => {
    resolveExit = resolve;
  });
  const child: FakeChild = {
    pid,
    request,
    exited,
    isRunning: true,
    ignoresTerm: false,
    hasStragglers: false,
    signals: [],
    exit: (code) => {
      if (!child.isRunning) return;
      child.isRunning = false;
      resolveExit({ code, error: null });
    },
  };
  return child;
}

interface HarnessOptions {
  bootId?: string | null;
  files?: Map<string, unknown>;
  forwardError?: string;
  spawnError?: string;
}

function createHarness(options: HarnessOptions = {}) {
  const clock = new FakeClock();
  const children: FakeChild[] = [];
  const files = new Map(options.files ?? []);
  const logs = new Map<string, string>();
  const readiness = new Map<string, Readiness>();
  const forwards: { forward: PlanForward; isClosed: boolean }[] = [];
  const messages: string[] = [];
  let statusWrites = 0;
  let nextPid = 1000;

  const deps: SupervisorDependencies = {
    spawn: (request) => {
      if (options.spawnError) return { pid: null, exited: Promise.resolve({ code: null, error: options.spawnError }) };
      const child = fakeChild(nextPid++, request);
      children.push(child);
      return child;
    },
    signalGroup: (pgid, signal) => {
      const child = children.find((candidate) => candidate.pid === pgid);
      if (!child || (!child.isRunning && !child.hasStragglers)) return false;
      if (signal === 0) return true;
      child.signals.push(signal);
      if (signal === "SIGKILL" || !child.ignoresTerm) {
        child.hasStragglers = false;
        child.exit(signal === "SIGKILL" ? 137 : 143);
      }
      return true;
    },
    probe: async (process) => readiness.get(process.name) ?? "waiting",
    startForward: async (forward) => {
      if (options.forwardError) throw new Error(options.forwardError);
      const record = { forward, isClosed: false };
      forwards.push(record);
      return {
        close: async () => {
          record.isClosed = true;
        },
      };
    },
    openLog: (name): LogSink => ({
      write: (chunk) => {
        logs.set(name, `${logs.get(name) ?? ""}${String(chunk)}`);
      },
      line: (text) => {
        logs.set(name, `${logs.get(name) ?? ""}${text}\n`);
      },
      close: () => {},
    }),
    readState: (name) => files.get(name),
    writeState: (name, value) => {
      files.set(name, JSON.parse(JSON.stringify(value)));
      if (name === "preview.json") {
        statusWrites++;
      }
    },
    worktree: () => WORKTREE,
    baseEnv: () => BASE_ENV,
    sessionId: SESSION_ID,
    bootId: () => (options.bootId === undefined ? BOOT_ID : options.bootId),
    now: () => clock.now,
    setTimer: (callback, ms) => clock.set(callback, ms),
    clearTimer: (timer) => clock.clear(timer),
    log: (message) => {
      messages.push(message);
    },
  };
  const supervisor = new PreviewSupervisor(deps);

  /** The started children whose command is `run`, oldest first. */
  function started(run: string): FakeChild[] {
    return children.filter((child) => child.request.run === run);
  }

  /** The newest child with the command `run`. */
  function latest(run: string): FakeChild {
    const matches = started(run);
    expect(matches.length).toBeGreaterThan(0);
    return matches[matches.length - 1];
  }

  /** Ends the step that runs now with `code`, `count` times. */
  async function finishSteps(count: number, code = 0): Promise<void> {
    for (let index = 0; index < count; index++) {
      children[children.length - 1].exit(code);
      await settle();
    }
  }

  /** The supervisor's own lines in the log `name`, without their time stamps. */
  function notes(name: string): string[] {
    return (logs.get(name) ?? "")
      .split("\n")
      .filter((line) => line.startsWith("[hunt-preview "))
      .map((line) => line.replace(/^\[hunt-preview [^\]]+\] /, ""));
  }

  return { supervisor, clock, children, files, logs, readiness, forwards, messages, started, latest, finishSteps, notes, statusWrites: () => statusWrites };
}

type Harness = ReturnType<typeof createHarness>;

/** Applies PREVIEW and runs its two prepare steps and its init step to the start of the processes. */
async function startedPreview(harness: Harness, dataGeneration = "data-1"): Promise<PreviewPlan> {
  const plan = planOf(PREVIEW);
  harness.supervisor.apply(plan, dataGeneration);
  await settle();
  await harness.finishSteps(3);
  return plan;
}

describe("PreviewSupervisor", () => {
  it("opens the forwards, runs the prepare and init steps and then starts every process with the composed environment", async () => {
    const harness = createHarness();
    const plan = planOf(PREVIEW);

    const applied = harness.supervisor.apply(plan, "data-1");
    expect(applied).toMatchObject({ generation: 1, state: "preparing", step: null, error: null, urls: plan.urls });
    expect(applied.processes).toEqual({
      api: { state: "stopped", pid: null, restarts: 0, exitCode: null, readyAt: null },
      worker: { state: "stopped", pid: null, restarts: 0, exitCode: null, readyAt: null },
    });
    expect(harness.files.get("applied.json")).toEqual({ generation: 1, bootId: BOOT_ID, dataGeneration: "data-1", running: true, plan });

    await settle();
    expect(harness.forwards).toEqual([{ forward: { port: 5432, host: "db" }, isClosed: false }]);
    expect(harness.children.map((child) => child.request.run)).toEqual(["npm ci"]);
    expect(harness.children[0].request.cwd).toBe(WORKTREE);
    expect(harness.children[0].request.env).toEqual({ ...BASE_ENV, DATABASE_URL: "postgres://127.0.0.1:5432/app", ...URL_ENV });
    expect(harness.supervisor.status()).toMatchObject({ state: "preparing", step: "install" });

    await harness.finishSteps(1);
    expect(harness.latest("npm run build").request.cwd).toBe(`${WORKTREE}/apps/api`);
    expect(harness.supervisor.status()).toMatchObject({ state: "preparing", step: "build" });

    await harness.finishSteps(1);
    expect(harness.latest("npm run seed").request.env).toMatchObject({ SEED: "1", ...URL_ENV });
    expect(harness.supervisor.status()).toMatchObject({ state: "init", step: "seed" });

    await harness.finishSteps(1);
    expect(harness.files.get("init.json")).toEqual({ dataGeneration: "data-1", initHash: plan.initHash });
    const api = harness.latest("npm run api");
    const worker = harness.latest("npm run worker");
    expect(api.request).toMatchObject({ cwd: WORKTREE, env: { PORT: "3000", DATABASE_URL: "postgres://127.0.0.1:5432/app", ...URL_ENV } });
    expect(worker.request.cwd).toBe(`${WORKTREE}/apps/worker`);
    expect(harness.supervisor.status()).toMatchObject({
      state: "starting",
      step: null,
      processes: { api: { state: "starting", pid: api.pid, readyAt: null }, worker: { state: "ready", pid: worker.pid, readyAt: START } },
    });

    await harness.clock.advance(READY_INTERVAL_MS * 3);
    expect(harness.supervisor.status().state).toBe("starting");
    harness.readiness.set("api", "ready");
    await harness.clock.advance(READY_INTERVAL_MS);
    const status = harness.supervisor.status();
    expect(status).toMatchObject({ state: "ready", processes: { api: { state: "ready", readyAt: START + 4 * READY_INTERVAL_MS } } });
    expect(harness.files.get("preview.json")).toEqual(status);
    expect(harness.notes("setup")).toEqual([
      "prepare step install: npm ci",
      "prepare step install exited with code 0",
      "prepare step build: npm run build",
      "prepare step build exited with code 0",
      "init step seed: npm run seed",
      "init step seed exited with code 0",
    ]);
    expect(harness.notes("api")).toEqual(["api starts: npm run api", "api is ready"]);
  });

  it("writes preview.json only when the status changes", async () => {
    const harness = createHarness();
    await startedPreview(harness);
    const writes = harness.statusWrites();

    await harness.clock.advance(READY_INTERVAL_MS * 10);

    expect(harness.statusWrites()).toBe(writes);
  });

  it("notes once per start that a process listens on 127.0.0.1 only and keeps checking it", async () => {
    const harness = createHarness();
    await startedPreview(harness);
    harness.readiness.set("api", "loopback-only");

    await harness.clock.advance(READY_INTERVAL_MS * 3);
    expect(harness.supervisor.status().processes.api.state).toBe("starting");
    harness.readiness.set("api", "ready");
    await harness.clock.advance(READY_INTERVAL_MS);

    expect(harness.notes("api")).toEqual([
      "api starts: npm run api",
      "api listens on 127.0.0.1:3000 only, where the preview cannot reach it; let it listen on 0.0.0.0",
      "api is ready",
    ]);
  });

  it("skips the init steps while init.json records them for the data generation and init hash", async () => {
    const plan = planOf(PREVIEW);
    const files = new Map<string, unknown>([["init.json", { dataGeneration: "data-1", initHash: plan.initHash }]]);
    const harness = createHarness({ files });

    harness.supervisor.apply(plan, "data-1");
    await settle();
    await harness.finishSteps(2);

    expect(harness.children.map((child) => child.request.run)).toEqual(["npm ci", "npm run build", "npm run api", "npm run worker"]);
    expect(harness.notes("setup")).toContain("init steps skipped: they ran for data generation data-1 already");

    harness.supervisor.apply(plan, "data-2");
    await settle();
    await harness.finishSteps(2);
    expect(harness.supervisor.status()).toMatchObject({ generation: 2, state: "init", step: "seed" });

    const changed = planOf({ ...PREVIEW, init: [{ name: "seed", run: "npm run seed -- --all" }] });
    harness.supervisor.apply(changed, "data-1");
    await settle();
    await harness.finishSteps(2);
    expect(harness.supervisor.status()).toMatchObject({ generation: 3, state: "init", step: "seed" });
  });

  it("fails at a step that exits with an error, names it and starts no process", async () => {
    const harness = createHarness();
    harness.supervisor.apply(planOf(PREVIEW), "data-1");
    await settle();

    await harness.finishSteps(1);
    await harness.finishSteps(1, 2);

    expect(harness.supervisor.status()).toMatchObject({
      state: "failed",
      step: "build",
      error: "the prepare step build exited with code 2",
      processes: { api: { state: "stopped", pid: null } },
    });
    expect(harness.children).toHaveLength(2);
    expect(harness.files.has("init.json")).toBe(false);
    expect(harness.forwards[0].isClosed).toBe(false);
    expect(() => harness.supervisor.startProcess("api")).toThrow("the preview failed; api runs again once the preview is started from Hunt");
  });

  it("fails with the reason when a step cannot start", async () => {
    const harness = createHarness({ spawnError: "the directory /srv/worktrees/x does not exist" });
    harness.supervisor.apply(planOf(PREVIEW), "data-1");
    await settle();

    expect(harness.supervisor.status()).toMatchObject({
      state: "failed",
      step: "install",
      error: "the prepare step install failed to start: the directory /srv/worktrees/x does not exist",
    });
  });

  it("fails when a forward cannot listen", async () => {
    const harness = createHarness({ forwardError: "listen EADDRINUSE: address already in use 127.0.0.1:5432" });
    harness.supervisor.apply(planOf(PREVIEW), "data-1");
    await settle();

    expect(harness.supervisor.status()).toMatchObject({
      state: "failed",
      step: null,
      error: "failed to forward 127.0.0.1:5432 to db:5432: listen EADDRINUSE: address already in use 127.0.0.1:5432",
    });
    expect(harness.children).toHaveLength(0);
  });

  it("restarts a process that exits after 1, 2, 4 and 8 s and keeps it crashed after five exits within two minutes", async () => {
    const harness = createHarness();
    harness.supervisor.apply(planOf(WEB_ONLY), "1");
    await settle();

    for (const [attempt, delay] of [1_000, 2_000, 4_000, 8_000].entries()) {
      harness.latest("npm run dev").exit(1);
      await settle();
      expect(harness.supervisor.status()).toMatchObject({ state: "starting", processes: { web: { state: "starting", pid: null, exitCode: 1, restarts: attempt } } });
      await harness.clock.advance(delay - 1);
      expect(harness.started("npm run dev")).toHaveLength(attempt + 1);
      await harness.clock.advance(1);
      expect(harness.started("npm run dev")).toHaveLength(attempt + 2);
    }
    harness.latest("npm run dev").exit(1);
    await settle();

    expect(harness.supervisor.status()).toMatchObject({ state: "degraded", processes: { web: { state: "crashed", pid: null, restarts: 4, exitCode: 1 } } });
    await harness.clock.advance(CRASH_WINDOW_MS);
    expect(harness.started("npm run dev")).toHaveLength(5);
    expect(harness.notes("web")).toContain("web crashed 5 times within 2 minutes; it stays stopped until it is started by hand");

    harness.supervisor.startProcess("web");
    expect(harness.started("npm run dev")).toHaveLength(6);
    expect(harness.supervisor.status()).toMatchObject({ state: "starting", processes: { web: { state: "starting", restarts: 0 } } });
  });

  it("caps the backoff at 30 s and starts it over after a run of two minutes", async () => {
    const harness = createHarness();
    harness.supervisor.apply(planOf(WEB_ONLY), "1");
    await settle();

    const delays: number[] = [];
    for (let crash = 0; crash < 7; crash++) {
      await harness.clock.advance(50_000);
      harness.latest("npm run dev").exit(1);
      await settle();
      const before = harness.started("npm run dev").length;
      let waited = 0;
      while (harness.started("npm run dev").length === before) {
        await harness.clock.advance(1_000);
        waited += 1_000;
      }
      delays.push(waited);
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);

    await harness.clock.advance(CRASH_WINDOW_MS);
    harness.latest("npm run dev").exit(1);
    await harness.clock.advance(1_000);
    expect(harness.supervisor.status().processes.web).toMatchObject({ state: "starting", restarts: 8 });
    expect(harness.latest("npm run dev").isRunning).toBe(true);
  });

  it("ends what a crashed process left in its group before it starts the process again", async () => {
    const harness = createHarness();
    harness.supervisor.apply(planOf(WEB_ONLY), "1");
    await settle();
    const first = harness.latest("npm run dev");
    first.hasStragglers = true;
    first.ignoresTerm = true;

    first.exit(1);
    await settle();
    expect(first.signals).toEqual(["SIGTERM"]);
    await harness.clock.advance(STOP_GRACE_MS - 1);
    expect(harness.started("npm run dev")).toHaveLength(1);

    await harness.clock.advance(1);
    expect(first.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(harness.started("npm run dev")).toHaveLength(2);
  });

  it("stops a process with SIGTERM to its group, sends SIGKILL after 10 s and starts it again only by hand", async () => {
    const harness = createHarness();
    await startedPreview(harness);
    const api = harness.latest("npm run api");
    api.ignoresTerm = true;

    const stopped = harness.supervisor.stopProcess("api");
    await settle();
    expect(api.signals).toEqual(["SIGTERM"]);
    expect(harness.supervisor.status().processes.api).toMatchObject({ state: "starting", pid: api.pid });
    await harness.clock.advance(STOP_GRACE_MS - 1);
    expect(api.signals).toEqual(["SIGTERM"]);
    await harness.clock.advance(1);

    expect(api.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(await stopped).toMatchObject({ state: "degraded", processes: { api: { state: "stopped", pid: null, exitCode: 137 }, worker: { state: "ready" } } });
    await harness.clock.advance(CRASH_WINDOW_MS);
    expect(harness.started("npm run api")).toHaveLength(1);

    const restarted = await harness.supervisor.restartProcess("api");
    expect(restarted.processes.api).toMatchObject({ state: "starting", pid: harness.latest("npm run api").pid, restarts: 0 });
    expect(harness.started("npm run api")).toHaveLength(2);
  });

  it("restarts a running process: the old one is gone before the new one starts", async () => {
    const harness = createHarness();
    await startedPreview(harness);
    const api = harness.latest("npm run api");

    const restarted = harness.supervisor.restartProcess("api");
    await settle();
    expect(api.isRunning).toBe(false);

    expect((await restarted).processes.api.pid).toBe(harness.latest("npm run api").pid);
    expect(harness.started("npm run api")).toHaveLength(2);
    expect(harness.supervisor.startProcess("api").processes.api.pid).toBe(harness.latest("npm run api").pid);
    expect(harness.started("npm run api")).toHaveLength(2);
  });

  it("names unknown processes and says why a process cannot be controlled yet", async () => {
    const harness = createHarness();
    expect(() => harness.supervisor.startProcess("api")).toThrow("no preview has been applied");

    harness.supervisor.apply(planOf(PREVIEW), "data-1");
    await settle();
    expect(() => harness.supervisor.startProcess("web")).toThrow("the preview has no process web; it has api, worker");
    await expect(harness.supervisor.restartProcess("api")).rejects.toThrow("the preview runs its prepare steps; api starts after them");
    await harness.finishSteps(2);
    await expect(harness.supervisor.stopProcess("api")).rejects.toThrow("the preview runs its init steps; api starts after them");
  });

  it("refuses a plan of another session", () => {
    const harness = createHarness();
    const plan = buildPlan({ preview: WEB_ONLY }, { sessionId: "00000000-1234-4abc-8def-0123456789ab", domain: DOMAIN });

    expect(() => harness.supervisor.apply(plan, "1")).toThrow(`the plan is for the session 00000000-1234-4abc-8def-0123456789ab, this container runs ${SESSION_ID}`);
    expect(harness.files.has("applied.json")).toBe(false);
  });

  it("replaces the running plan on a new apply once its processes and forwards are gone", async () => {
    const harness = createHarness();
    await startedPreview(harness);
    const api = harness.latest("npm run api");
    const worker = harness.latest("npm run worker");
    api.ignoresTerm = true;

    const status = harness.supervisor.apply(planOf(WEB_ONLY), "data-1");
    expect(status).toMatchObject({ generation: 2, state: "preparing", processes: { web: { state: "stopped" } } });
    expect(Object.keys(status.processes)).toEqual(["web"]);
    await settle();
    expect(worker.isRunning).toBe(false);
    expect(harness.started("npm run dev")).toHaveLength(0);
    expect(harness.forwards[0].isClosed).toBe(false);

    await harness.clock.advance(STOP_GRACE_MS);
    expect(api.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(harness.forwards[0].isClosed).toBe(true);
    expect(harness.started("npm run dev")).toHaveLength(1);
    expect(harness.supervisor.status()).toMatchObject({ generation: 2, state: "starting" });
  });

  it("stops a run in a prepare step, starts nothing more and does not resume it", async () => {
    const harness = createHarness();
    harness.supervisor.apply(planOf(PREVIEW), "data-1");
    await settle();
    const install = harness.latest("npm ci");

    const stopped = await harness.supervisor.stop();

    expect(install.signals).toEqual(["SIGTERM"]);
    expect(stopped).toMatchObject({ generation: 1, state: "stopped", step: null, processes: { api: { state: "stopped" } } });
    expect(harness.forwards[0].isClosed).toBe(true);
    expect(harness.children).toHaveLength(1);
    expect(harness.files.get("applied.json")).toMatchObject({ running: false });
    expect(harness.files.get("preview.json")).toMatchObject({ state: "stopped" });

    const next = createHarness({ files: harness.files });
    next.supervisor.resume();
    await settle();
    expect(next.supervisor.status()).toMatchObject({ generation: 1, state: "stopped" });
    expect(next.children).toHaveLength(0);
  });

  it("stops every process and forward, then answers", async () => {
    const harness = createHarness();
    await startedPreview(harness);

    const stopped = await harness.supervisor.stop();

    expect(stopped).toMatchObject({ state: "stopped", processes: { api: { state: "stopped" }, worker: { state: "stopped" } } });
    expect(harness.children.every((child) => !child.isRunning)).toBe(true);
    expect(harness.forwards[0].isClosed).toBe(true);
    await harness.clock.advance(CRASH_WINDOW_MS);
    expect(harness.children).toHaveLength(5);
  });

  it("resumes the applied plan when the relay restarts within the same boot, skipping init steps that ran", async () => {
    const harness = createHarness();
    await startedPreview(harness);
    await harness.supervisor.shutdown();
    expect(harness.files.get("applied.json")).toMatchObject({ generation: 1, running: true });
    expect(harness.files.get("preview.json")).toMatchObject({ state: "stopped" });
    expect(harness.children.every((child) => !child.isRunning)).toBe(true);

    const resumed = createHarness({ files: harness.files });
    resumed.supervisor.resume();
    expect(resumed.supervisor.status()).toMatchObject({ generation: 1, state: "preparing" });
    await settle();
    await resumed.finishSteps(2);

    expect(resumed.children.map((child) => child.request.run)).toEqual(["npm ci", "npm run build", "npm run api", "npm run worker"]);
    expect(resumed.messages).toContain("resuming the preview of generation 1");
    expect(resumed.supervisor.apply(planOf(WEB_ONLY), "data-1").generation).toBe(2);
  });

  it("does not resume after a reboot of the VM", async () => {
    const harness = createHarness();
    await startedPreview(harness);
    await harness.supervisor.shutdown();

    const rebooted = createHarness({ files: harness.files, bootId: "boot-2" });
    rebooted.supervisor.resume();
    await settle();

    expect(rebooted.supervisor.status()).toMatchObject({ generation: 1, state: "stopped", urls: planOf(PREVIEW).urls });
    expect(rebooted.children).toHaveLength(0);
    expect(rebooted.messages).toEqual(["not resuming the preview of generation 1: the VM restarted since it was applied"]);
  });

  it("starts idle without applied.json and ignores an applied.json it cannot read", () => {
    const fresh = createHarness();
    fresh.supervisor.resume();
    expect(fresh.files.get("preview.json")).toEqual({ generation: 0, state: "idle", step: null, error: null, urls: null, processes: {}, updatedAt: START });

    const unreadable = { generation: 1, bootId: BOOT_ID, dataGeneration: "1", running: true, plan: { version: 2 } };
    const broken = createHarness({ files: new Map([["applied.json", unreadable]]) });
    broken.supervisor.resume();
    expect(broken.supervisor.status()).toMatchObject({ generation: 0, state: "idle" });
    expect(broken.messages[0]).toMatch(/^ignored applied\.json: plan\.version: must be 1\n/);
  });

  it("kills every process group at once and restarts nothing", async () => {
    const harness = createHarness();
    await startedPreview(harness);
    const running = harness.children.filter((child) => child.isRunning);

    harness.supervisor.kill();
    await harness.clock.advance(CRASH_WINDOW_MS);

    expect(running.map((child) => child.signals)).toEqual([["SIGKILL"], ["SIGKILL"]]);
    expect(harness.children).toHaveLength(5);
  });
});
