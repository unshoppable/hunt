import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSessionConfig,
  ConfigError,
  envFile,
  parsePreviewConfig,
  proxyConfig,
  sessionEnv,
  type CaddyRoute,
  type PreviewConfig,
  type SessionHost,
} from "./config.ts";

const CONFIG_CLI = fileURLToPath(new URL("./configCli.ts", import.meta.url));
const HOST: SessionHost = { short: "7c0c6f2e", domain: "hunt.example.com" };
const MAIN_URL = "https://7c0c6f2e.hunt.example.com";
const PORT_RULE = "must be an integer from 1024 to 65535";
const PREFIX_RULE = 'must be a path prefix such as "/api/": starting and ending with /, segments of letters, digits, ".", "_", "~" and "-", none . or ..';
const IAP_HEADERS = ["X-Goog-Iap-Jwt-Assertion", "X-Goog-Authenticated-User-Email", "X-Goog-Authenticated-User-Id"];

/** A hunt.json with a section of another contract and every field of the preview section. */
const COMPLETE = {
  environment: { node: "24" },
  preview: {
    version: 2,
    env: { BACKEND_DOMAIN: "${HUNT_PREVIEW_URL_3000}", APP_URL: "${HUNT_PREVIEW_URL}/app", PLAIN: "x" },
    main: 4200,
    routes: { "/api/": 3000, "/admin-api/": 3000, "/api/v2/": 3100 },
    tls: [3000, 4400],
  },
};

const COMPLETE_CONFIG: PreviewConfig = {
  env: { BACKEND_DOMAIN: "${HUNT_PREVIEW_URL_3000}", APP_URL: "${HUNT_PREVIEW_URL}/app", PLAIN: "x" },
  main: 4200,
  routes: [
    { prefix: "/api/", port: 3000 },
    { prefix: "/admin-api/", port: 3000 },
    { prefix: "/api/v2/", port: 3100 },
  ],
  tls: [3000, 4400],
};

function problemsOf(huntJson: unknown, host: SessionHost = HOST): string[] {
  try {
    buildSessionConfig(huntJson, host);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  return [];
}

function preview(fields: Record<string, unknown>): Record<string, unknown> {
  return { preview: { version: 2, ...fields } };
}

describe("parsePreviewConfig", () => {
  it("reads every field of the preview section and ignores the other sections", () => {
    expect(parsePreviewConfig(COMPLETE)).toEqual(COMPLETE_CONFIG);
  });

  it("gives a repository without hunt.json or without its preview section no variables, main port or routes", () => {
    const empty: PreviewConfig = { env: {}, main: null, routes: [], tls: [] };

    expect(parsePreviewConfig(undefined)).toEqual(empty);
    expect(parsePreviewConfig({ environment: { node: "24" } })).toEqual(empty);
    expect(parsePreviewConfig({ preview: { version: 2 } })).toEqual(empty);
  });

  it("reports every problem with the path of the offending value", () => {
    const cases: [unknown, string[]][] = [
      [[], ["hunt.json: must be an object"]],
      [{ preview: "x" }, ["preview: must be an object"]],
      [{ preview: {} }, ["preview.version: must be 2"]],
      [
        { preview: { services: {}, processes: { web: { run: "npm start", port: 3000, main: true } } } },
        ["preview.services: unknown field", "preview.processes: unknown field", "preview.version: must be 2"],
      ],
      [{ preview: { version: "2" } }, ["preview.version: must be 2"]],
      [preview({ extra: 1, "two words": 2 }), ["preview.extra: unknown field", 'preview["two words"]: unknown field']],
      [preview({ env: [] }), ["preview.env: must be an object"]],
      [preview({ env: { lower: "x" } }), ["preview.env.lower: invalid name, must match ^[A-Z_][A-Z0-9_]*$"]],
      [preview({ env: { "BAD-KEY": "x" } }), ["preview.env.BAD-KEY: invalid name, must match ^[A-Z_][A-Z0-9_]*$"]],
      [preview({ env: { "1A": "x" } }), ['preview.env["1A"]: invalid name, must match ^[A-Z_][A-Z0-9_]*$']],
      [preview({ env: { HUNT_URL: "x" } }), ["preview.env.HUNT_URL: reserved: names starting with CLAUDE_ or HUNT_ belong to Hunt"]],
      [preview({ env: { CLAUDE_X: "x" } }), ["preview.env.CLAUDE_X: reserved: names starting with CLAUDE_ or HUNT_ belong to Hunt"]],
      [preview({ env: { A: 1, B: null } }), ["preview.env.A: must be a string", "preview.env.B: must be a string"]],
      [
        preview({ env: { A: "x\ny", B: "x\ry", C: "x\0y" } }),
        ["preview.env.A: must be a single line", "preview.env.B: must be a single line", "preview.env.C: must be a single line"],
      ],
      [
        preview({ env: { A: "${HUNT_SECRET}", B: "${HUNT_PREVIEW_URL_TEMPLATE}" } }),
        [
          "preview.env.A: unknown placeholder ${HUNT_SECRET}, only ${HUNT_PREVIEW_URL} and ${HUNT_PREVIEW_URL_<port>} are possible",
          "preview.env.B: unknown placeholder ${HUNT_PREVIEW_URL_TEMPLATE}, only ${HUNT_PREVIEW_URL} and ${HUNT_PREVIEW_URL_<port>} are possible",
        ],
      ],
      [
        preview({ env: { A: "${HUNT_PREVIEW_URL_80}", B: "${HUNT_PREVIEW_URL_65536}", C: "${HUNT_PREVIEW_URL_03000}", D: "${HUNT_PREVIEW_URL_8080}" } }),
        [
          `preview.env.A: \${HUNT_PREVIEW_URL_80}: the port ${PORT_RULE}`,
          `preview.env.B: \${HUNT_PREVIEW_URL_65536}: the port ${PORT_RULE}`,
          `preview.env.C: \${HUNT_PREVIEW_URL_03000}: the port ${PORT_RULE}`,
          "preview.env.D: ${HUNT_PREVIEW_URL_8080}: the port 8080 is reserved for the session VM's preview proxy",
        ],
      ],
      [preview({ main: "4200" }), [`preview.main: ${PORT_RULE}`]],
      [preview({ main: 4200.5 }), [`preview.main: ${PORT_RULE}`]],
      [preview({ main: 1023 }), [`preview.main: ${PORT_RULE}`]],
      [preview({ main: 65536 }), [`preview.main: ${PORT_RULE}`]],
      [preview({ main: 2019 }), ["preview.main: 2019 is reserved for Caddy's admin API"]],
      [preview({ main: 2375 }), ["preview.main: 2375 is reserved for the Docker API"]],
      [preview({ main: 2376 }), ["preview.main: 2376 is reserved for the Docker API over TLS"]],
      [preview({ main: 8080 }), ["preview.main: 8080 is reserved for the session VM's preview proxy"]],
      [preview({ routes: ["/api/"] }), ["preview.routes: must be an object"]],
      [
        preview({ routes: { "api/": 3000, "/api": 3000, "/": 3000, "/a b/": 3000, "/../": 3000, "/a/./": 3000, "/a//": 3000, "/api/*": 3000 } }),
        [
          `preview.routes["api/"]: ${PREFIX_RULE}`,
          `preview.routes["/api"]: ${PREFIX_RULE}`,
          `preview.routes["/"]: ${PREFIX_RULE}`,
          `preview.routes["/a b/"]: ${PREFIX_RULE}`,
          `preview.routes["/../"]: ${PREFIX_RULE}`,
          `preview.routes["/a/./"]: ${PREFIX_RULE}`,
          `preview.routes["/a//"]: ${PREFIX_RULE}`,
          `preview.routes["/api/*"]: ${PREFIX_RULE}`,
        ],
      ],
      [
        preview({ routes: { "/api/": "3000", "/admin/": 2376 } }),
        [`preview.routes["/api/"]: ${PORT_RULE}`, 'preview.routes["/admin/"]: 2376 is reserved for the Docker API over TLS'],
      ],
      [preview({ tls: 3000 }), ["preview.tls: must be an array of ports"]],
      [preview({ tls: [3000, "4400", 8080] }), [`preview.tls[1]: ${PORT_RULE}`, "preview.tls[2]: 8080 is reserved for the session VM's preview proxy"]],
      [preview({ tls: [3000, 4400, 3000] }), ["preview.tls[2]: 3000 is listed already"]],
    ];

    for (const [huntJson, problems] of cases) {
      expect(problemsOf(huntJson), JSON.stringify(huntJson)).toEqual(problems);
    }
  });

  it("accepts the edges of the port range and every allowed prefix character", () => {
    expect(parsePreviewConfig(preview({ main: 1024, routes: { "/a.b_c~d-e/F9/": 65535 } }))).toEqual({
      env: {},
      main: 1024,
      routes: [{ prefix: "/a.b_c~d-e/F9/", port: 65535 }],
      tls: [],
    });
  });

  it("rejects an invalid short ID or domain together with the problems of hunt.json", () => {
    expect(problemsOf(preview({ main: 1 }), { short: "7C0C6F2E", domain: "localhost" })).toEqual([
      "short: must be the first 8 hex digits of the session ID, in lowercase",
      "domain: must be a lowercase host name with at least two labels",
      `preview.main: ${PORT_RULE}`,
    ]);
    expect(problemsOf(undefined, { short: "7c0c6f2", domain: "Hunt.Example.com" })).toHaveLength(2);
  });
});

describe("sessionEnv", () => {
  it("puts the preview URLs first and resolves the placeholders of the repository's variables", () => {
    const env = sessionEnv(
      { ...COMPLETE_CONFIG, env: { ...COMPLETE_CONFIG.env, BOTH: "${HUNT_PREVIEW_URL};${HUNT_PREVIEW_URL_4400}", OTHER: "${HOME}" } },
      HOST,
    );

    expect(Object.keys(env)).toEqual(["HUNT_PREVIEW_URL", "HUNT_PREVIEW_URL_TEMPLATE", "BACKEND_DOMAIN", "APP_URL", "PLAIN", "BOTH", "OTHER"]);
    expect(env).toEqual({
      HUNT_PREVIEW_URL: MAIN_URL,
      HUNT_PREVIEW_URL_TEMPLATE: "https://7c0c6f2e-{port}.hunt.example.com",
      BACKEND_DOMAIN: "https://7c0c6f2e-3000.hunt.example.com",
      APP_URL: `${MAIN_URL}/app`,
      PLAIN: "x",
      BOTH: `${MAIN_URL};https://7c0c6f2e-4400.hunt.example.com`,
      OTHER: "${HOME}",
    });
  });

  it("is what buildSessionConfig returns", () => {
    expect(buildSessionConfig(COMPLETE, HOST).env).toEqual(sessionEnv(COMPLETE_CONFIG, HOST));
  });
});

describe("envFile", () => {
  const TRICKY = {
    QUOTES: `say "hi" and 'bye'`,
    BACKSLASHES: "C:\\path\\ and a trailing \\",
    DOLLARS: "$HOME ${HOME} $(id) `id`",
    SPACES: "  padded  ",
    HASH: "#not a comment ;nor this",
    EMPTY: "",
    UNICODE: "Grüße 🚀",
  };

  it("writes one double-quoted assignment per line and escapes \\, \", ` and $", () => {
    expect(envFile({ A: "x", B: 'a"b\\c`d$e' })).toBe(
      "# The session's environment from the preview section of the repository's hunt.json.\n" + 'A="x"\nB="a\\"b\\\\c\\`d\\$e"\n',
    );
  });

  it("reads back verbatim in a shell, which unquotes like systemd's EnvironmentFile", () => {
    const dir = mkdtempSync(join(tmpdir(), "hunt-env-"));
    try {
      const file = join(dir, "session.env");
      writeFileSync(file, envFile(TRICKY));
      const keys = Object.keys(TRICKY);
      const script = `set -a; . "$1"; for key in ${keys.join(" ")}; do printf '%s\\0' "\${!key}"; done`;
      const result = spawnSync("bash", ["--noprofile", "--norc", "-c", script, "bash", file], { encoding: "utf8", env: {} });

      expect(result.stderr).toBe("");
      expect(result.stdout.split("\0").slice(0, -1)).toEqual(Object.values(TRICKY));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("proxyConfig", () => {
  const config = proxyConfig(COMPLETE_CONFIG, HOST);
  const server = config.apps.http.servers.preview;
  const sessionRoutes = server.routes[2].handle[0].routes as CaddyRoute[];
  const portPattern = (server.routes[2].match![1].vars_regexp as Record<string, { name: string; pattern: string }>)["{http.request.host}"];

  function upstreamOf(route: CaddyRoute) {
    return route.handle[0] as { handler: string; upstreams: { dial: string }[]; transport?: unknown };
  }

  it("listens on :8080 in plain HTTP behind the gateway, with the admin API on a socket", () => {
    expect(config.admin).toEqual({ listen: "unix//run/hunt-proxy/admin.sock", config: { persist: false } });
    expect(server.listen).toEqual([":8080"]);
    expect(server.protocols).toEqual(["h1"]);
    expect(server.automatic_https).toEqual({ disable: true });
    expect(server.trusted_proxies).toEqual({ source: "static", ranges: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"] });
  });

  it("logs every request but the health check as JSON to the access log the idle check reads, and nothing else there", () => {
    expect(server.logs).toEqual({ default_logger_name: "preview" });
    expect(config.logging.logs.access).toEqual({
      writer: { output: "file", filename: "/var/log/hunt-proxy/access.log", roll_size_mb: 20, roll_keep: 2 },
      encoder: { format: "json" },
      include: ["http.log.access.preview"],
    });
    expect(config.logging.logs.default).toEqual({ level: "WARN", exclude: ["http.log.access.preview"] });
    expect(server.routes[0].handle[0]).toEqual({ handler: "vars", log_skip: true });
  });

  it("answers the health check, refuses the reserved ports and sends the session's hosts to its subroute", () => {
    expect(server.routes.map((route) => route.match)).toEqual([
      [{ path: ["/hunt-healthz"] }],
      [{ host: ["7c0c6f2e-2019.hunt.example.com", "7c0c6f2e-2375.hunt.example.com", "7c0c6f2e-2376.hunt.example.com", "7c0c6f2e-8080.hunt.example.com"] }],
      [{ host: ["7c0c6f2e.hunt.example.com"] }, { vars_regexp: { "{http.request.host}": portPattern } }],
      undefined,
    ]);
    expect(server.routes[0].handle[1]).toEqual({ handler: "static_response", status_code: 200, body: "ok" });
    expect(server.routes[1].handle).toEqual([{ handler: "static_response", status_code: 403, body: "This port is not served.\n" }]);
    expect(server.routes[2].handle[0].handler).toBe("subroute");
    expect(server.routes[3].handle).toEqual([{ handler: "static_response", status_code: 404 }]);
    expect(server.routes.slice(0, 3).every((route) => route.terminal)).toBe(true);
  });

  it("routes the path prefixes first, longest first, then the main host, the HTTPS ports and every other port, all on localhost", () => {
    expect(sessionRoutes.map((route) => route.match)).toEqual([
      [{ path: ["/admin-api/*"] }],
      [{ path: ["/api/v2/*"] }],
      [{ path: ["/api/*"] }],
      [{ host: ["7c0c6f2e.hunt.example.com"] }],
      [{ host: ["7c0c6f2e-3000.hunt.example.com"] }],
      [{ host: ["7c0c6f2e-4400.hunt.example.com"] }],
      [{ vars_regexp: { "{http.request.host}": portPattern } }],
    ]);
    expect(sessionRoutes.map((route) => upstreamOf(route).upstreams[0].dial)).toEqual([
      "localhost:3000",
      "localhost:3100",
      "localhost:3000",
      "localhost:4200",
      "localhost:3000",
      "localhost:4400",
      "localhost:{http.regexp.port.1}",
    ]);
    expect(sessionRoutes.every((route) => route.terminal)).toBe(true);
  });

  it("reaches the ports in tls over HTTPS without checking their certificates", () => {
    const tls = { protocol: "http", tls: { insecure_skip_verify: true } };

    expect(sessionRoutes.map((route) => upstreamOf(route).transport)).toEqual([tls, undefined, tls, undefined, tls, tls, undefined]);
    const mainOverTls = proxyConfig({ ...COMPLETE_CONFIG, tls: [4200] }, HOST).apps.http.servers.preview.routes[2].handle[0].routes as CaddyRoute[];
    expect(upstreamOf(mainOverTls[3]).transport).toEqual(tls);
  });

  it("keeps the Host header, removes IAP's headers and cookies and flushes every response at once", () => {
    for (const route of sessionRoutes) {
      expect(route.handle[0]).toMatchObject({
        handler: "reverse_proxy",
        flush_interval: -1,
        headers: {
          request: {
            set: { Host: ["{http.request.hostport}"] },
            delete: IAP_HEADERS,
            replace: { Cookie: [{ search_regexp: "(^|;\\s*)(__Host-)?GCP_IAP[^=]*=[^;]*", replace: "" }] },
          },
        },
      });
    }
    const cookie = new RegExp("(^|;\\s*)(__Host-)?GCP_IAP[^=]*=[^;]*", "g");
    expect("a=1; GCP_IAP_UID=u; __Host-GCP_IAP_AUTH_TOKEN_x=t; b=2".replace(cookie, "")).toBe("a=1; b=2");
  });

  it("takes the port of a port host from its name, from 1024 to 65535 only", () => {
    const pattern = new RegExp(portPattern.pattern);
    const portOf = (host: string) => pattern.exec(host)?.[1] ?? null;

    expect(portPattern.name).toBe("port");
    for (const port of [1024, 1029, 1030, 1099, 1100, 1999, 2000, 9999, 10000, 59999, 60000, 64999, 65000, 65499, 65500, 65529, 65530, 65535]) {
      expect(portOf(`7c0c6f2e-${port}.hunt.example.com`)).toBe(String(port));
    }
    for (const port of ["80", "1023", "65536", "70000", "99999", "03000", "100000"]) {
      expect(portOf(`7c0c6f2e-${port}.hunt.example.com`), port).toBeNull();
    }
    expect(portOf("7c0c6f2e.hunt.example.com")).toBeNull();
    expect(portOf("8d1d7a3f-3000.hunt.example.com")).toBeNull();
    expect(portOf("7c0c6f2e-3000.huntxexample.com")).toBeNull();
    expect(portOf("7c0c6f2e-3000.hunt.example.com.evil.com")).toBeNull();
    expect(portOf("x7c0c6f2e-3000.hunt.example.com")).toBeNull();
  });

  it("answers the main host with 404 and an explanation when hunt.json sets no main port", () => {
    const routes = proxyConfig({ env: {}, main: null, routes: [], tls: [] }, HOST).apps.http.servers.preview.routes[2].handle[0].routes as CaddyRoute[];

    expect(routes.map((route) => route.handle[0].handler)).toEqual(["static_response", "reverse_proxy"]);
    expect(routes[0]).toMatchObject({ match: [{ host: ["7c0c6f2e.hunt.example.com"] }], handle: [{ status_code: 404 }] });
  });
});

describe("configCli", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** A worktree holding `files` and an empty output folder. */
  function setup(files: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), "hunt-config-"));
    dirs.push(dir);
    const worktree = join(dir, "worktree");
    mkdirSync(worktree);
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(join(worktree, name), text);
    }
    return { dir, worktree, envOut: join(dir, "session.env"), caddyOut: join(dir, "caddy.json") };
  }

  function runCli(worktree: string, envOut: string, caddyOut: string, extra: string[] = []) {
    const args = ["--worktree", worktree, "--short", HOST.short, "--domain", HOST.domain, "--env-out", envOut, "--caddy-out", caddyOut, ...extra];
    const result = spawnSync(process.execPath, [CONFIG_CLI, ...args], { encoding: "utf8" });
    return { status: result.status, stderr: result.stderr, output: JSON.parse(result.stdout) as unknown, lines: result.stdout.split("\n").length };
  }

  it("writes the environment and the proxy configuration and prints the text of HUNT.md", () => {
    const { worktree, envOut, caddyOut } = setup({ "hunt.json": JSON.stringify(COMPLETE), "HUNT.md": "\n# Preview\nStart the UIs with DEV_BACKEND_ORIGIN.\n\n" });
    const result = runCli(worktree, envOut, caddyOut);

    expect(result).toEqual({
      status: 0,
      stderr: "",
      output: { ok: true, main: COMPLETE_CONFIG.main, tls: COMPLETE_CONFIG.tls, hunt_md: "# Preview\nStart the UIs with DEV_BACKEND_ORIGIN." },
      lines: 2,
    });
    const expected = buildSessionConfig(COMPLETE, HOST);
    expect(readFileSync(envOut, "utf8")).toBe(envFile(expected.env));
    expect(JSON.parse(readFileSync(caddyOut, "utf8"))).toEqual(expected.proxy);
    expect(statSync(envOut).mode & 0o777).toBe(0o644);
    expect(statSync(caddyOut).mode & 0o777).toBe(0o644);
  });

  it("configures a repository without hunt.json and HUNT.md with the preview URLs only", () => {
    const { worktree, envOut, caddyOut } = setup({});

    expect(runCli(worktree, envOut, caddyOut).output).toEqual({ ok: true, main: null, tls: [] });
    expect(readFileSync(envOut, "utf8")).toContain(`HUNT_PREVIEW_URL="${MAIN_URL}"\nHUNT_PREVIEW_URL_TEMPLATE="https://7c0c6f2e-{port}.hunt.example.com"\n`);
  });

  it("prints every problem, writes nothing and exits with 1", () => {
    const { worktree, envOut, caddyOut } = setup({ "hunt.json": JSON.stringify(preview({ main: 80, extra: 1 })), "HUNT.md": "x".repeat(20 * 1024 + 1) });
    const result = runCli(worktree, envOut, caddyOut);

    expect(result).toMatchObject({
      status: 1,
      output: { ok: false, problems: ["HUNT.md: is larger than 20480 bytes", "preview.extra: unknown field", `preview.main: ${PORT_RULE}`] },
    });
    expect(() => statSync(envOut)).toThrow();
    expect(() => statSync(caddyOut)).toThrow();
  });

  it("reports hunt.json that is no JSON, a symlink or no file", () => {
    const invalid = setup({ "hunt.json": "{oops" });
    expect(runCli(invalid.worktree, invalid.envOut, invalid.caddyOut).output).toEqual({
      ok: false,
      problems: [expect.stringMatching(/^hunt\.json: not valid JSON: /)],
    });

    const linked = setup({ "secret.json": JSON.stringify(COMPLETE) });
    symlinkSync(join(linked.worktree, "secret.json"), join(linked.worktree, "hunt.json"));
    symlinkSync("/etc/hosts", join(linked.worktree, "HUNT.md"));
    expect(runCli(linked.worktree, linked.envOut, linked.caddyOut).output).toEqual({
      ok: false,
      problems: ["hunt.json: must be a file, not a symlink", "HUNT.md: must be a file, not a symlink"],
    });

    const folder = setup({});
    mkdirSync(join(folder.worktree, "hunt.json"));
    expect(runCli(folder.worktree, folder.envOut, folder.caddyOut).output).toEqual({ ok: false, problems: ["hunt.json: must be a file"] });
  });

  it("reports invalid host names and missing or unknown arguments", () => {
    const { worktree, envOut, caddyOut } = setup({});

    expect(runCli(worktree, envOut, caddyOut, ["--short", "XYZ"]).output).toEqual({
      ok: false,
      problems: ["short: must be the first 8 hex digits of the session ID, in lowercase"],
    });
    const missing = spawnSync(process.execPath, [CONFIG_CLI, "--worktree", worktree, "--short", HOST.short], { encoding: "utf8" });
    expect(missing.status).toBe(1);
    expect(JSON.parse(missing.stdout)).toEqual({ ok: false, problems: [expect.stringMatching(/^missing --domain, --env-out, --caddy-out; usage: /)] });
    const unknown = spawnSync(process.execPath, [CONFIG_CLI, "--port", "3000"], { encoding: "utf8" });
    expect(JSON.parse(unknown.stdout)).toEqual({ ok: false, problems: [expect.stringMatching(/^unknown argument --port; usage: /)] });
    const valueless = spawnSync(process.execPath, [CONFIG_CLI, "--worktree"], { encoding: "utf8" });
    expect(JSON.parse(valueless.stdout)).toEqual({ ok: false, problems: ["--worktree needs a value"] });
  });
});
