import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildPlan, ContractError, parsePlan, type PlanOptions } from "./contract.ts";

const PLAN_CLI = fileURLToPath(new URL("./planCli.ts", import.meta.url));
const SESSION_ID = "7c0c6f2e-1b2c-4d3e-8f90-0123456789ab";
const SHORT = "7c0c6f2e";
const DOMAIN = "hunt.example.com";
const OPTIONS: PlanOptions = { sessionId: SESSION_ID, domain: DOMAIN };
const MAIN_URL = `https://${SHORT}.${DOMAIN}`;
const NAME_RULE = "must match ^[a-z][a-z0-9-]{0,23}$";
const ENV_KEY_RULE = "invalid name, must match ^[A-Z_][A-Z0-9_]*$";
const RESERVED_ENV = "reserved: names starting with CLAUDE_ or HUNT_ belong to Hunt";
const RELATIVE_CWD = "must be a path inside the worktree, relative and without ..";
const MEMORY_FORMAT = 'must be a size such as "512m" or "1g"';
const WEB = { run: "npm run dev", port: 3000, main: true };

/** A hunt.json with a section of another contract and every preview section: two services, URLs in env, a step of each kind, four processes. */
const COMPLETE = {
  environment: { node: "24" },
  preview: {
    services: {
      db: { kind: "postgres-18", env: { POSTGRES_PASSWORD: "dev", POSTGRES_DB: "app" }, memory: "2g" },
      cache: { kind: "redis-7.2" },
    },
    env: { DATABASE_URL: "postgres://postgres:dev@127.0.0.1:5432/app", APP_URL: "${HUNT_PREVIEW_URL}", ADMIN_URL: "${HUNT_PREVIEW_URL_4300}/admin" },
    prepare: [{ name: "install", run: "npm ci" }],
    init: [{ name: "seed", run: "npm run db:migrate && npm run db:seed", cwd: "./apps/api/", env: { API_URL: "${HUNT_PREVIEW_URL_3000}" } }],
    processes: {
      api: { run: "npm run start:api", cwd: "apps/api", env: { PUBLIC_URL: "${HUNT_PREVIEW_URL}" }, port: 3000, ready: "/health", main: true },
      admin: { run: "npm run start:admin", port: 4300, protocol: "https", ready: "/" },
      worker: { run: "npm run start:worker", cwd: "apps//worker", env: { QUEUE: "default" } },
      ui: { run: "npm run start:ui", port: 4400, optional: true },
    },
  },
};

const COMPLETE_PLAN = {
  version: 1,
  sessionId: SESSION_ID,
  short: SHORT,
  domain: DOMAIN,
  services: [
    { name: "db", kind: "postgres-18", port: 5432, env: { POSTGRES_PASSWORD: "dev", POSTGRES_DB: "app" }, memoryMb: 2048 },
    { name: "cache", kind: "redis-7.2", port: 6379, env: {}, memoryMb: 256 },
  ],
  forwards: [
    { port: 5432, host: "db" },
    { port: 6379, host: "cache" },
  ],
  env: { DATABASE_URL: "postgres://postgres:dev@127.0.0.1:5432/app", APP_URL: MAIN_URL, ADMIN_URL: `${portUrl(4300)}/admin` },
  prepare: [{ name: "install", run: "npm ci", cwd: ".", env: {} }],
  init: [{ name: "seed", run: "npm run db:migrate && npm run db:seed", cwd: "apps/api", env: { API_URL: portUrl(3000) } }],
  initHash: expect.stringMatching(/^[0-9a-f]{64}$/),
  processes: [
    {
      name: "api",
      run: "npm run start:api",
      cwd: "apps/api",
      env: { PUBLIC_URL: MAIN_URL },
      port: 3000,
      protocol: "http",
      ready: "/health",
      main: true,
      optional: false,
    },
    { name: "admin", run: "npm run start:admin", cwd: ".", env: {}, port: 4300, protocol: "https", ready: "/", main: false, optional: false },
    {
      name: "worker",
      run: "npm run start:worker",
      cwd: "apps/worker",
      env: { QUEUE: "default" },
      port: null,
      protocol: "http",
      ready: null,
      main: false,
      optional: false,
    },
  ],
  routes: [
    { host: `${SHORT}.${DOMAIN}`, port: 3000, protocol: "http" },
    { host: `${SHORT}-3000.${DOMAIN}`, port: 3000, protocol: "http" },
    { host: `${SHORT}-4300.${DOMAIN}`, port: 4300, protocol: "https" },
  ],
  urls: { main: MAIN_URL, processes: { api: MAIN_URL, admin: portUrl(4300) } },
};

function portUrl(port: number): string {
  return `https://${SHORT}-${port}.${DOMAIN}`;
}

/** A hunt.json whose preview has the main process `web`, the `processes` given in addition and the other `sections`. */
function huntJson(sections: Record<string, unknown> = {}, processes: Record<string, unknown> = {}): Record<string, unknown> {
  return { preview: { ...sections, processes: { web: WEB, ...processes } } };
}

function steps(count: number): { name: string; run: string }[] {
  return Array.from({ length: count }, (_, index) => ({ name: `step-${index + 1}`, run: "true" }));
}

/** `count` processes without a port, `worker-1` … */
function workers(count: number): Record<string, unknown> {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => [`worker-${index + 1}`, { run: "true" }]));
}

/** The problems of the ContractError that building the plan throws. */
function problemsOf(value: unknown, options: Partial<PlanOptions> = {}): string[] {
  try {
    buildPlan(value, { ...OPTIONS, ...options });
  } catch (error) {
    if (error instanceof ContractError) return error.problems;
    throw error;
  }
  throw new Error("expected a ContractError");
}

/** The problems of the ContractError that parsing the plan throws. */
function planProblemsOf(value: unknown): string[] {
  try {
    parsePlan(value);
  } catch (error) {
    if (error instanceof ContractError) return error.problems;
    throw error;
  }
  throw new Error("expected a ContractError");
}

describe("buildPlan", () => {
  it("builds the plan of a complete contract: services, forwards, expanded env, steps, processes, routes and URLs", () => {
    expect(buildPlan(COMPLETE, OPTIONS)).toEqual(COMPLETE_PLAN);
  });

  it("fills in the defaults: cwd, protocol, ready path, the catalog's memory and empty env and steps", () => {
    const plan = buildPlan(huntJson({ services: { db: { kind: "postgres-18" }, cache: { kind: "redis-7.2" } } }), OPTIONS);

    expect(plan.services).toEqual([
      { name: "db", kind: "postgres-18", port: 5432, env: {}, memoryMb: 1024 },
      { name: "cache", kind: "redis-7.2", port: 6379, env: {}, memoryMb: 256 },
    ]);
    expect(plan.env).toEqual({});
    expect(plan.prepare).toEqual([]);
    expect(plan.init).toEqual([]);
    expect(plan.processes).toEqual([{ name: "web", run: "npm run dev", cwd: ".", env: {}, port: 3000, protocol: "http", ready: null, main: true, optional: false }]);
    expect(plan.routes).toEqual([
      { host: `${SHORT}.${DOMAIN}`, port: 3000, protocol: "http" },
      { host: `${SHORT}-3000.${DOMAIN}`, port: 3000, protocol: "http" },
    ]);
    expect(plan.urls).toEqual({ main: MAIN_URL, processes: { web: MAIN_URL } });
  });

  it("accepts the limits: 8 processes, 10 steps per list, names of 24 characters, ports at the edges of their ranges and 4g of memory", () => {
    const longName = "p".padEnd(24, "x");
    const limits = huntJson(
      { services: { db: { kind: "postgres-18", memory: "3840m" }, cache: { kind: "redis-7.2" } }, prepare: steps(10), init: steps(10) },
      {
        web: { ...WEB, port: 1024 },
        high: { run: "x", port: 65535 },
        below: { run: "x", port: 9199 },
        above: { run: "x", port: 9250 },
        [longName]: { run: "x", port: 2018 },
        ...workers(3),
      },
    );

    const plan = buildPlan(limits, OPTIONS);

    expect(plan.processes.map((spec) => spec.port)).toEqual([1024, 65535, 9199, 9250, 2018, null, null, null]);
    expect(plan.prepare).toHaveLength(10);
    expect(plan.init).toHaveLength(10);
    expect(plan.services.map((service) => service.memoryMb)).toEqual([3840, 256]);
    expect(buildPlan(huntJson({ services: { db: { kind: "postgres-18", memory: "64m" } } }), OPTIONS).services[0].memoryMb).toBe(64);
  });

  it("throws a ContractError for an invalid contract", () => {
    expect(() => buildPlan(huntJson({ version: 1 }), OPTIONS)).toThrow(ContractError);
    expect(() => buildPlan(huntJson({ version: 1 }), OPTIONS)).toThrow("preview.version: unknown field");
  });

  it("collects every problem of the contract and the options in one error", () => {
    const invalid = { preview: { extra: true, env: { lower: "x" }, processes: { web: { ...WEB, port: 80 }, Worker: { run: "x" } } } };
    const problems = [
      "session: must be a session ID, a lowercase UUID",
      "domain: must be a lowercase host name with at least two labels",
      "preview.extra: unknown field",
      "preview.processes.web.port: must be an integer from 1024 to 65535",
      `preview.processes.Worker: invalid name, ${NAME_RULE}`,
      `preview.env.lower: ${ENV_KEY_RULE}`,
    ];

    let thrown: unknown;
    try {
      buildPlan(invalid, { sessionId: "nope", domain: "localhost" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ContractError);
    expect((thrown as ContractError).problems).toEqual(problems);
    expect((thrown as ContractError).message).toBe(problems.join("\n"));
  });
});

describe("optional processes", () => {
  it("run only when requested, with their route and URL", () => {
    expect(buildPlan(COMPLETE, OPTIONS).processes.map((spec) => spec.name)).toEqual(["api", "admin", "worker"]);

    const plan = buildPlan(COMPLETE, { ...OPTIONS, withOptional: ["ui"] });

    expect(plan.processes.map((spec) => spec.name)).toEqual(["api", "admin", "worker", "ui"]);
    const ui = { name: "ui", run: "npm run start:ui", cwd: ".", env: {}, port: 4400, protocol: "http", ready: null, main: false, optional: true };
    expect(plan.processes[3]).toEqual(ui);
    expect(plan.routes[plan.routes.length - 1]).toEqual({ host: `${SHORT}-4400.${DOMAIN}`, port: 4400, protocol: "http" });
    expect(plan.urls.processes).toEqual({ api: MAIN_URL, admin: portUrl(4300), ui: portUrl(4400) });
  });

  it("accept a requested process that is not optional and reject one that does not exist", () => {
    expect(buildPlan(COMPLETE, { ...OPTIONS, withOptional: ["api"] })).toEqual(buildPlan(COMPLETE, OPTIONS));
    expect(problemsOf(COMPLETE, { withOptional: ["ui", "docs"] })).toEqual(["with: preview.processes has no process docs"]);
  });
});

describe("placeholders", () => {
  it("expand to the preview's URLs in the env of the preview, its steps, its processes and its services", () => {
    const placeholders = {
      preview: {
        services: { db: { kind: "postgres-18", env: { POSTGRES_DB: "${HUNT_PREVIEW_URL_3000}" } } },
        env: { BOTH: "${HUNT_PREVIEW_URL} and ${HUNT_PREVIEW_URL_4000}" },
        prepare: [{ name: "build", run: "npm run build", env: { BASE: "${HUNT_PREVIEW_URL}/base" } }],
        init: [{ name: "seed", run: "npm run seed", env: { CALLBACK: "${HUNT_PREVIEW_URL_4000}/callback" } }],
        processes: {
          web: { ...WEB, env: { SELF: "${HUNT_PREVIEW_URL_3000}" } },
          docs: { run: "npm run docs", port: 4000 },
        },
      },
    };

    const plan = buildPlan(placeholders, OPTIONS);

    expect(plan.env).toEqual({ BOTH: `${MAIN_URL} and ${portUrl(4000)}` });
    expect(plan.prepare[0].env).toEqual({ BASE: `${MAIN_URL}/base` });
    expect(plan.init[0].env).toEqual({ CALLBACK: `${portUrl(4000)}/callback` });
    expect(plan.processes[0].env).toEqual({ SELF: portUrl(3000) });
    expect(plan.services[0].env).toEqual({ POSTGRES_DB: portUrl(3000) });
  });

  it("leave other references alone", () => {
    const plan = buildPlan(huntJson({ env: { HOME_DIR: "${HOME}/app", BARE: "$HUNT_PREVIEW_URL", LOWER: "${hunt_preview_url}" } }), OPTIONS);

    expect(plan.env).toEqual({ HOME_DIR: "${HOME}/app", BARE: "$HUNT_PREVIEW_URL", LOWER: "${hunt_preview_url}" });
  });

  it("accept the port of an optional process that is not requested", () => {
    const optional = huntJson({ env: { UI_URL: "${HUNT_PREVIEW_URL_4400}" } }, { ui: { run: "npm run ui", port: 4400, optional: true } });

    const plan = buildPlan(optional, OPTIONS);

    expect(plan.processes.map((spec) => spec.name)).toEqual(["web"]);
    expect(plan.env).toEqual({ UI_URL: portUrl(4400) });
  });

  it("reject a port no process has and unknown HUNT_ placeholders, naming the env entry", () => {
    const invalid = huntJson(
      {
        env: { DB: "${HUNT_PREVIEW_URL_5432}", TYPO: "${HUNT_PREVIEW_URLS}", PADDED: "${HUNT_PREVIEW_URL_03000}" },
        prepare: [{ name: "build", run: "npm run build", env: { SECRET: "${HUNT_SECRET}" } }],
      },
      { web: { ...WEB, env: { OTHER: "${HUNT_PREVIEW_URL_4000}" } } },
    );

    expect(problemsOf(invalid)).toEqual([
      "preview.processes.web.env.OTHER: ${HUNT_PREVIEW_URL_4000} names port 4000, which no process has",
      "preview.env.DB: ${HUNT_PREVIEW_URL_5432} names port 5432, which no process has",
      "preview.env.TYPO: unknown placeholder ${HUNT_PREVIEW_URLS}",
      "preview.env.PADDED: unknown placeholder ${HUNT_PREVIEW_URL_03000}",
      "preview.prepare[0].env.SECRET: unknown placeholder ${HUNT_SECRET}",
    ]);
  });
});

describe("initHash", () => {
  const BASE = {
    services: { db: { kind: "postgres-18", env: { POSTGRES_USER: "app", POSTGRES_DB: "app" } } },
    env: { MODE: "dev" },
    prepare: [{ name: "install", run: "npm ci" }],
    init: [{ name: "seed", run: "npm run seed", env: { FIRST: "1", SECOND: "2" } }],
  };

  function initHashOf(sections: Record<string, unknown>, processes: Record<string, unknown> = {}): string {
    return buildPlan(huntJson(sections, processes), OPTIONS).initHash;
  }

  it("stays the same when env keys are reordered and when the processes, the prepare steps or the env change", () => {
    const hash = initHashOf(BASE);

    expect(initHashOf(BASE)).toBe(hash);
    expect(
      initHashOf({
        ...BASE,
        services: { db: { kind: "postgres-18", env: { POSTGRES_DB: "app", POSTGRES_USER: "app" } } },
        init: [{ name: "seed", run: "npm run seed", env: { SECOND: "2", FIRST: "1" } }],
      }),
    ).toBe(hash);
    expect(initHashOf({ ...BASE, env: { MODE: "test" }, prepare: [] }, { web: { ...WEB, run: "npm start" }, ...workers(1) })).toBe(hash);
  });

  it("changes with the init steps and the services", () => {
    const hash = initHashOf(BASE);
    const changes = [
      { ...BASE, init: [{ name: "seed", run: "npm run seed -- --full", env: { FIRST: "1", SECOND: "2" } }] },
      { ...BASE, init: [{ name: "seed", run: "npm run seed", env: { FIRST: "1", SECOND: "3" } }] },
      { ...BASE, init: [] },
      { ...BASE, services: { db: { kind: "postgres-18", env: { POSTGRES_USER: "app", POSTGRES_DB: "other" } } } },
      { ...BASE, services: { db: { kind: "postgres-18", env: { POSTGRES_USER: "app", POSTGRES_DB: "app" }, memory: "2g" } } },
      { ...BASE, services: { ...BASE.services, cache: { kind: "redis-7.2" } } },
    ];

    for (const change of changes) {
      expect(initHashOf(change)).not.toBe(hash);
    }
  });
});

const INVALID: { case: string; huntJson: unknown; problems: string[] }[] = [
  { case: "a hunt.json that is not an object", huntJson: ["preview"], problems: ["hunt.json: must be an object"] },
  { case: "a hunt.json without a preview section", huntJson: { environment: {} }, problems: ["preview: missing: hunt.json has no preview section"] },
  { case: "a preview that is not an object", huntJson: { preview: "web" }, problems: ["preview: must be an object"] },
  { case: "a preview without processes", huntJson: { preview: { env: {} } }, problems: ["preview.processes: missing: a preview needs a main process"] },
  {
    case: "processes that are not an object",
    huntJson: { preview: { processes: [WEB] } },
    problems: ["preview.processes: must be an object", 'preview.processes: needs exactly one process with "main": true, not 0'],
  },
  { case: "an unknown field in the preview", huntJson: huntJson({ version: 1 }), problems: ["preview.version: unknown field"] },
  {
    case: "an unknown field in a service",
    huntJson: huntJson({ services: { db: { kind: "postgres-18", image: "postgres:18" } } }),
    problems: ["preview.services.db.image: unknown field"],
  },
  {
    case: "an unknown field in a step",
    huntJson: huntJson({ prepare: [{ name: "install", run: "npm ci", timeout: 60 }] }),
    problems: ["preview.prepare[0].timeout: unknown field"],
  },
  {
    case: "an unknown field in a process",
    huntJson: huntJson({}, { worker: { run: "npm run worker", restart: "always" } }),
    problems: ["preview.processes.worker.restart: unknown field"],
  },
  {
    case: "invalid process names",
    huntJson: huntJson({}, { Worker: { run: "x" }, ["p".padEnd(25, "x")]: { run: "x" }, "2nd": { run: "x" } }),
    problems: [
      `preview.processes.Worker: invalid name, ${NAME_RULE}`,
      `preview.processes.${"p".padEnd(25, "x")}: invalid name, ${NAME_RULE}`,
      `preview.processes["2nd"]: invalid name, ${NAME_RULE}`,
    ],
  },
  {
    case: "a process called setup",
    huntJson: huntJson({}, { setup: { run: "x" } }),
    problems: ["preview.processes.setup: setup is reserved for the log of the prepare and init steps"],
  },
  { case: "a process that is not an object", huntJson: huntJson({}, { worker: "npm run worker" }), problems: ["preview.processes.worker: must be an object"] },
  ...[80, 1023, 65536, 3000.5, "3000"].map((port) => ({
    case: `the port ${JSON.stringify(port)}`,
    huntJson: huntJson({}, { web: { ...WEB, port } }),
    problems: ["preview.processes.web.port: must be an integer from 1024 to 65535"],
  })),
  ...[2019, 5432, 6379, 9200, 9249].map((port) => ({
    case: `the reserved port ${port}`,
    huntJson: huntJson({}, { web: { ...WEB, port } }),
    problems: [`preview.processes.web.port: ${port} is reserved; 2019, 5432, 6379 and 9200–9249 are not available`],
  })),
  {
    case: "a port two processes use",
    huntJson: huntJson({}, { api: { run: "npm run api", port: 3000 } }),
    problems: ["preview.processes.api.port: 3000 is the port of web already"],
  },
  {
    case: "no main process",
    huntJson: huntJson({}, { web: { run: "npm run dev", port: 3000 } }),
    problems: ['preview.processes: needs exactly one process with "main": true, not 0'],
  },
  {
    case: "two main processes",
    huntJson: huntJson({}, { api: { run: "npm run api", port: 3001, main: true } }),
    problems: ['preview.processes: needs exactly one process with "main": true, not 2'],
  },
  {
    case: "a main process without a port",
    huntJson: huntJson({}, { web: { run: "npm run dev", main: true } }),
    problems: ["preview.processes.web: the main process needs a port"],
  },
  {
    case: "an optional main process",
    huntJson: huntJson({}, { web: { ...WEB, optional: true } }),
    problems: ["preview.processes.web.optional: the main process cannot be optional"],
  },
  {
    case: "a flag that is not a boolean",
    huntJson: huntJson({}, { worker: { run: "x", optional: "yes" } }),
    problems: ["preview.processes.worker.optional: must be true or false"],
  },
  {
    case: "a protocol without a port",
    huntJson: huntJson({}, { worker: { run: "x", protocol: "https" } }),
    problems: ["preview.processes.worker.protocol: needs a port"],
  },
  {
    case: "a ready path without a port",
    huntJson: huntJson({}, { worker: { run: "x", ready: "/health" } }),
    problems: ["preview.processes.worker.ready: needs a port"],
  },
  {
    case: "an unknown protocol",
    huntJson: huntJson({}, { web: { ...WEB, protocol: "tcp" } }),
    problems: ['preview.processes.web.protocol: must be "http" or "https"'],
  },
  ...["health", "/a b", "", null].map((ready) => ({
    case: `the ready path ${JSON.stringify(ready)}`,
    huntJson: huntJson({}, { web: { ...WEB, ready } }),
    problems: ['preview.processes.web.ready: must be a path such as "/health"'],
  })),
  ...["/srv/app", "apps/../../etc", "..", ""].map((cwd) => ({
    case: `the cwd ${JSON.stringify(cwd)}`,
    huntJson: huntJson({}, { web: { ...WEB, cwd } }),
    problems: [`preview.processes.web.cwd: ${RELATIVE_CWD}`],
  })),
  {
    case: "a step cwd that leaves the worktree",
    huntJson: huntJson({ prepare: [{ name: "install", run: "npm ci", cwd: "apps/.." + "/.." }] }),
    problems: [`preview.prepare[0].cwd: ${RELATIVE_CWD}`],
  },
  { case: "an empty run", huntJson: huntJson({}, { web: { ...WEB, run: "  " } }), problems: ["preview.processes.web.run: must not be empty"] },
  {
    case: "a run of several lines",
    huntJson: huntJson({}, { web: { ...WEB, run: "npm ci\nnpm start" } }),
    problems: ["preview.processes.web.run: must be a single line"],
  },
  { case: "a process without run", huntJson: huntJson({}, { worker: {} }), problems: ["preview.processes.worker.run: must be a string"] },
  { case: "a step without run", huntJson: huntJson({ init: [{ name: "seed" }] }), problems: ["preview.init[0].run: must be a string"] },
  { case: "an env that is not an object", huntJson: huntJson({ env: ["A=1"] }), problems: ["preview.env: must be an object"] },
  {
    case: "invalid env names",
    huntJson: huntJson({ env: { "bad-key": "x", "1ABC": "x", "A B": "x" } }),
    problems: [`preview.env.bad-key: ${ENV_KEY_RULE}`, `preview.env["1ABC"]: ${ENV_KEY_RULE}`, `preview.env["A B"]: ${ENV_KEY_RULE}`],
  },
  {
    case: "env names reserved for Hunt and Claude Code",
    huntJson: huntJson(
      { env: { CLAUDE_CODE_OAUTH_TOKEN: "x" }, prepare: [{ name: "install", run: "npm ci", env: { HUNT_SESSION_ID: "x" } }] },
      { web: { ...WEB, env: { HUNT_PREVIEW_URL: "x" } } },
    ),
    problems: [
      `preview.processes.web.env.HUNT_PREVIEW_URL: ${RESERVED_ENV}`,
      `preview.env.CLAUDE_CODE_OAUTH_TOKEN: ${RESERVED_ENV}`,
      `preview.prepare[0].env.HUNT_SESSION_ID: ${RESERVED_ENV}`,
    ],
  },
  {
    case: "env values that are not single-line strings",
    huntJson: huntJson({ env: { MOTD: "hello\nworld", CR: "a\rb", NUL: "a\0b", PORT: 3000 } }),
    problems: [
      "preview.env.MOTD: must be a single line",
      "preview.env.CR: must be a single line",
      "preview.env.NUL: must be a single line",
      "preview.env.PORT: must be a string",
    ],
  },
  {
    case: "an unknown service kind",
    huntJson: huntJson({ services: { db: { kind: "mysql-8" }, cache: {} } }),
    problems: ["preview.services.db.kind: must be one of postgres-18, redis-7.2", "preview.services.cache.kind: must be one of postgres-18, redis-7.2"],
  },
  {
    case: "an invalid service name",
    huntJson: huntJson({ services: { DB: { kind: "postgres-18" } } }),
    problems: [`preview.services.DB: invalid name, ${NAME_RULE}`],
  },
  { case: "a service that is not an object", huntJson: huntJson({ services: { db: "postgres-18" } }), problems: ["preview.services.db: must be an object"] },
  {
    case: "an env name Postgres does not take",
    huntJson: huntJson({ services: { db: { kind: "postgres-18", env: { PGDATA: "/data" } } } }),
    problems: ["preview.services.db.env.PGDATA: not taken by postgres-18, which takes POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB"],
  },
  {
    case: "env for Redis",
    huntJson: huntJson({ services: { cache: { kind: "redis-7.2", env: { REDIS_PASSWORD: "x" } } } }),
    problems: ["preview.services.cache.env.REDIS_PASSWORD: redis-7.2 takes no environment variables"],
  },
  ...["1G", "512", "1.5g", "0m", 512].map((memory) => ({
    case: `the memory ${JSON.stringify(memory)}`,
    huntJson: huntJson({ services: { db: { kind: "postgres-18", memory } } }),
    problems: [`preview.services.db.memory: ${MEMORY_FORMAT}`],
  })),
  {
    case: "less than 64m of memory",
    huntJson: huntJson({ services: { db: { kind: "postgres-18", memory: "63m" } } }),
    problems: ["preview.services.db.memory: must be at least 64m"],
  },
  {
    case: "more than 4g of memory for all services",
    huntJson: huntJson({ services: { db: { kind: "postgres-18", memory: "4g" }, cache: { kind: "redis-7.2" } } }),
    problems: ["preview.services: the services need 4352m of memory together, at most 4g are possible"],
  },
  {
    case: "two Postgres services",
    huntJson: huntJson({ services: { db: { kind: "postgres-18" }, analytics: { kind: "postgres-18" } } }),
    problems: ["preview.services.analytics.kind: only one postgres-18 service is possible: 127.0.0.1:5432 goes to db"],
  },
  { case: "steps that are not an array", huntJson: huntJson({ init: { name: "seed", run: "x" } }), problems: ["preview.init: must be an array of steps"] },
  { case: "a step that is not an object", huntJson: huntJson({ prepare: ["npm ci"] }), problems: ["preview.prepare[0]: must be an object"] },
  { case: "more than 10 steps", huntJson: huntJson({ prepare: steps(11) }), problems: ["preview.prepare: has 11 steps, at most 10 are possible"] },
  {
    case: "two steps with one name",
    huntJson: huntJson({ prepare: [{ name: "install", run: "npm ci" }, { name: "install", run: "npm run build" }] }),
    problems: ["preview.prepare[1].name: install is the name of another step"],
  },
  { case: "an invalid step name", huntJson: huntJson({ init: [{ name: "Seed", run: "x" }] }), problems: [`preview.init[0].name: ${NAME_RULE}`] },
  { case: "more than 8 processes", huntJson: huntJson({}, workers(8)), problems: ["preview.processes: has 9 processes, at most 8 are possible"] },
];

describe("invalid contracts", () => {
  const cases = INVALID.map((entry): [string, unknown, string[]] => [entry.case, entry.huntJson, entry.problems]);

  it.each(cases)("reject %s, naming the path of every problem", (_case, value, problems) => {
    expect(problemsOf(value)).toEqual(problems);
  });
});

describe("session ID and domain", () => {
  it("reject a session ID that is not a lowercase UUID", () => {
    for (const sessionId of [SESSION_ID.toUpperCase(), SHORT, `${SESSION_ID}0`, ""]) {
      expect(problemsOf(huntJson(), { sessionId })).toEqual(["session: must be a session ID, a lowercase UUID"]);
    }
  });

  it("reject a domain that is not a lowercase host name of two labels or more, or too long for the preview's host names", () => {
    const longest = ["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(46)].join(".");
    expect(longest).toHaveLength(238);
    expect(buildPlan(huntJson({}, { web: { ...WEB, port: 65535 } }), { ...OPTIONS, domain: longest }).routes[1].host).toHaveLength(253);

    for (const domain of ["Hunt.example.com", "localhost", "-x.example.com", "x-.example.com", "example.com.", "exa mple.com", `${longest}e`]) {
      expect(problemsOf(huntJson(), { domain })).toEqual(["domain: must be a lowercase host name with at least two labels"]);
    }
  });
});

describe("parsePlan", () => {
  const PLAN = buildPlan(COMPLETE, { ...OPTIONS, withOptional: ["ui"] });

  function withProcess(index: number, change: Record<string, unknown>): Record<string, unknown> {
    return { ...PLAN, processes: PLAN.processes.map((spec, position) => (position === index ? { ...spec, ...change } : spec)) };
  }

  it("reads a plan back after a JSON round trip", () => {
    expect(parsePlan(JSON.parse(JSON.stringify(PLAN)))).toEqual(PLAN);
  });

  it("rejects tampered plans, naming the path of every problem", () => {
    const { urls: _urls, ...withoutUrls } = PLAN;
    const cases: [unknown, string[]][] = [
      ["plan", ["plan: must be an object"]],
      [{ ...PLAN, version: 2 }, ["plan.version: must be 1"]],
      [{ ...PLAN, extra: true }, ["plan.extra: unknown field"]],
      [{ ...PLAN, sessionId: "nope" }, ["plan.sessionId: must be a lowercase UUID"]],
      [{ ...PLAN, short: "00000000" }, ["plan.short: must be the first 8 hex digits of plan.sessionId"]],
      [{ ...PLAN, domain: "localhost" }, ["plan.domain: must be a lowercase host name"]],
      [{ ...PLAN, initHash: "abc" }, ["plan.initHash: must be a SHA-256 in hex"]],
      [{ ...PLAN, processes: [] }, ["plan.processes: must be an array of 1 to 8 processes"]],
      [withProcess(0, { name: "../x" }), [`plan.processes[0].name: ${NAME_RULE}`]],
      [withProcess(1, { cwd: "../outside" }), [`plan.processes[1].cwd: ${RELATIVE_CWD}`]],
      [withProcess(2, { run: "npm start\nrm -rf /" }), ["plan.processes[2].run: must be a single line"]],
      [withProcess(0, { port: 2019 }), ["plan.processes[0].port: 2019 is reserved; 2019, 5432, 6379 and 9200–9249 are not available"]],
      [withProcess(0, { env: { "BAD-KEY": "x" } }), [`plan.processes[0].env.BAD-KEY: ${ENV_KEY_RULE}`]],
      [{ ...PLAN, env: { "BAD-KEY": "x" } }, [`plan.env.BAD-KEY: ${ENV_KEY_RULE}`]],
      [{ ...PLAN, prepare: [{ ...PLAN.prepare[0], cwd: "a/../.." }] }, [`plan.prepare[0].cwd: ${RELATIVE_CWD}`]],
      [{ ...PLAN, forwards: [{ port: 5432, host: "db.internal" }] }, ["plan.forwards[0].host: must be the name of a service"]],
      [{ ...PLAN, forwards: [{ port: 0, host: "db" }] }, ["plan.forwards[0].port: must be a port number"]],
      [withoutUrls, ["plan.urls: must be an object"]],
      [{ ...PLAN, urls: { main: MAIN_URL, processes: { api: 1 } } }, ["plan.urls.processes.api: must be a string"]],
    ];

    for (const [plan, problems] of cases) {
      expect(planProblemsOf(plan), JSON.stringify(problems)).toEqual(problems);
    }
  });

  it("rejects a process called setup, the name of the steps' log", () => {
    expect(planProblemsOf(withProcess(2, { name: "setup" }))).toEqual(["plan.processes[2].name: setup is reserved for the log of the prepare and init steps"]);
  });
});

describe("planCli", () => {
  function runPlanCli(args: string[], input: string) {
    return spawnSync(process.execPath, [PLAN_CLI, ...args], { input, encoding: "utf8" });
  }

  it("prints the plan of the hunt.json on stdin as one line of JSON", () => {
    const result = runPlanCli(["--session", SESSION_ID, "--domain", DOMAIN, "--with", "ui"], JSON.stringify(COMPLETE));

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout.endsWith("\n")).toBe(true);
    expect(result.stdout.slice(0, -1)).not.toContain("\n");
    expect(JSON.parse(result.stdout)).toEqual(buildPlan(COMPLETE, { ...OPTIONS, withOptional: ["ui"] }));
  });

  it("prints every problem on stderr, one per line, and exits with 1", () => {
    const result = runPlanCli(["--session", SESSION_ID, "--domain", DOMAIN], JSON.stringify(huntJson({ extra: 1 }, { web: { ...WEB, port: 80 } })));

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("preview.extra: unknown field\npreview.processes.web.port: must be an integer from 1024 to 65535\n");
  });

  it("exits with 1 on input that is not JSON and on missing or unknown arguments", () => {
    const valid = JSON.stringify(COMPLETE);

    expect(runPlanCli(["--session", SESSION_ID, "--domain", DOMAIN], "{oops")).toMatchObject({
      status: 1,
      stdout: "",
      stderr: expect.stringMatching(/^hunt\.json is not valid JSON: /),
    });
    expect(runPlanCli(["--session", SESSION_ID], valid)).toMatchObject({ status: 1, stdout: "", stderr: "--session and --domain are required\n" });
    expect(runPlanCli(["--session", SESSION_ID, "--domain"], valid)).toMatchObject({ status: 1, stdout: "", stderr: "--domain needs a value\n" });
    expect(runPlanCli(["--session", SESSION_ID, "--domain", DOMAIN, "--port", "3000"], valid)).toMatchObject({
      status: 1,
      stdout: "",
      stderr: expect.stringContaining("unknown argument --port"),
    });
  });
});
