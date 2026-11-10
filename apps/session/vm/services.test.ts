/**
 * The services of hunt.json on a session VM, in a Debian 12 container with Node 24, the base of the session VMs;
 * skipped without a Docker daemon. `hunt-ctl install-units` installs the unit, the run script and the sudo rule of the
 * built session artifact (`nx build session`), `session-config` runs its configCli on a worktree, and `service`,
 * `preview-status`, `stop` and `destroy` act on the units; `check` runs a check of hunt.json in the worktree. A fake
 * `systemctl` earlier on PATH (`fixtures/systemctl`) logs its calls to /var/log/systemctl.log and keeps each unit's
 * state in a file, so that `systemctl show` reports what the calls did; enable and disable add and remove the unit's
 * link in multi-user.target.wants as systemd does. Real sudo checks the agent's rule.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const BUNDLE = fileURLToPath(new URL("../../../dist/apps/session", import.meta.url));
const FIXTURES = fileURLToPath(new URL("./fixtures", import.meta.url));
const DOCKER_TIMEOUT_MS = 600_000;
const ID = "7c0c6f2e-0000-4000-8000-000000000001";
const DOMAIN = "hunt.example.com";

const DOCKERFILE = `FROM node:24-bookworm-slim
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \\
      bash ca-certificates curl iproute2 jq sudo tmux util-linux \\
    && rm -rf /var/lib/apt/lists/*
RUN groupadd -g 2000 agent && useradd -u 2000 -g 2000 -m -d /home/agent -s /bin/bash agent \\
    && mkdir -p /etc/hunt /etc/systemd/system /opt/hunt/node/bin && echo session >/etc/hunt/role \\
    && ln -s /usr/local/bin/node /opt/hunt/node/bin/node
`;
const IMAGE = `hunt-ctl-test:${createHash("sha256").update(DOCKERFILE).digest("hex").slice(0, 12)}`;

/** The container's setup: the bundle as the current release and the fake systemctl. */
const SETUP = String.raw`
set -euo pipefail
mkdir -p /srv/hunt
cp -R /bundle /srv/hunt/current
echo 0123456789abcdef >/srv/hunt/current/.hash
install -m 0755 /fixtures/systemctl /usr/local/bin/systemctl
`;

/**
 * Resets the VM to a session ID whose worktree /home/agent/app holds the hunt.json and hunt.agent.md given ($2, $3;
 * none when empty) and the skill file `.claude/skills/<name>/SKILL.md` of each name in $4 (separated by spaces), without
 * units, services or logs.
 */
const SEED = String.raw`
set -euo pipefail
rm -rf /srv/hunt/sessions /etc/hunt/services /etc/hunt/session.env /etc/hunt/caddy.json /etc/hunt/remote-secrets.json /home/agent/app /home/agent/logs \
  /run/fake-systemd /etc/systemd/system/multi-user.target.wants /var/log/systemctl.log
install -d -m 0700 /srv/hunt/sessions "/srv/hunt/sessions/$1"
install -d -o agent -g agent /home/agent/app /home/agent/app/admin
printf '{"repo": "acme/app", "worktree": "/home/agent/app", "createdAt": 1}\n' >"/srv/hunt/sessions/$1/meta.json"
if [[ -n $2 ]]; then
  printf '%s' "$2" | runuser -u agent -- tee /home/agent/app/hunt.json >/dev/null
fi
if [[ -n $3 ]]; then
  printf '%s' "$3" | runuser -u agent -- tee /home/agent/app/hunt.agent.md >/dev/null
fi
for skill in $4; do
  runuser -u agent -- mkdir -p "/home/agent/app/.claude/skills/$skill"
  printf -- '---\nname: %s\n---\n' "$skill" | runuser -u agent -- tee "/home/agent/app/.claude/skills/$skill/SKILL.md" >/dev/null
done
`;

const HUNT_JSON = {
  version: 3,
  swf: {
    model: "claude-opus-5-5",
    // Accepted and validated, never printed: the repository's scorer workflow reads the paths, not Hunt.
    humanReviewPaths: ["**/migrations/**"],
    skills: { plan: "swf-plan", implement: "swf-implement", verify: "swf-verify", review: "acme-review", pr: "swf-pr" },
  },
  services: {
    api: { command: "node server.js", port: 3000, guarded: false, env: { ADMIN_URL: "${services.admin.publicUrl}" } },
    admin: { command: "npm start", cwd: "admin", port: 4200, env: { API_URL: "${services.api.publicUrl}" } },
    ui: { command: "npm run ui", port: 4400, tls: true },
  },
  checks: {
    good: { command: "echo ok-output", cwd: "admin" },
    bad: { command: "echo bad-output; exit 3" },
  },
};
const AGENT_MD = "# Services\nStart api and admin together.\n";
/** The skill of every agent step as HUNT_JSON names them under `swf.skills`. */
const SKILLS = HUNT_JSON.swf.skills;

/** The services of HUNT_JSON as meta.json records them. */
const DECLARED = {
  api: { port: 3000, tls: false, guarded: false, uses: ["admin"] },
  admin: { port: 4200, tls: false, guarded: true, uses: ["api"] },
  ui: { port: 4400, tls: true, guarded: true, uses: [] },
};

/** The InvocationID the fake systemctl reports for the service `name` while it runs or starts. */
function invocationOf(name: string): string {
  return createHash("md5").update(`hunt-service@${name}.service`).digest("hex");
}

/** A service as `hunt-ctl service` reports it, from its declaration and state. */
function reported(name: keyof typeof DECLARED, state: Partial<{ enabled: boolean; state: string; responds: boolean; uses: string[] }> = {}) {
  const declared = DECLARED[name];
  const host = declared.guarded ? `7c0c6f2e-${declared.port}` : `7c0c6f2e-${declared.port}-open`;
  const report = { name, ...declared, url: `https://${host}.${DOMAIN}`, enabled: false, state: "stopped", responds: false, ...state };
  return { ...report, invocation: report.state === "running" || report.state === "starting" ? invocationOf(name) : null };
}

function docker(args: string[], input?: string) {
  const result = spawnSync("docker", args, { input, encoding: "utf8", timeout: DOCKER_TIMEOUT_MS });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function hasDocker(): boolean {
  return spawnSync("docker", ["info"], { stdio: "ignore", timeout: 20_000 }).status === 0;
}

describe.skipIf(!hasDocker())("the services of hunt.json in a Debian container", () => {
  const container = `hunt-ctl-services-${randomUUID().slice(0, 8)}`;

  /** Runs `script` with bash in the container as root; `args` become $1… */
  function sh(script: string, args: string[] = []) {
    return docker(["exec", container, "bash", "-c", script, "bash", ...args]);
  }

  function huntCtl(...args: string[]) {
    return docker(["exec", container, "hunt-ctl", ...args]);
  }

  /** Runs `hunt-ctl` with `input` on stdin. */
  function huntCtlWithInput(input: string, ...args: string[]) {
    return docker(["exec", "--interactive", container, "hunt-ctl", ...args], input);
  }

  /** Runs `hunt-ctl` and returns its JSON result, failing on any stderr or exit status. */
  function huntCtlJson(...args: string[]) {
    const result = huntCtl(...args);
    expect(result.stderr, args.join(" ")).toBe("");
    expect(result.status, args.join(" ")).toBe(0);
    return JSON.parse(result.stdout);
  }

  /** The fake systemctl's calls since the last call of this function. */
  function systemctlCalls(): string[] {
    const calls = sh("cat /var/log/systemctl.log 2>/dev/null; rm -f /var/log/systemctl.log").stdout;
    return calls.split("\n").filter((line) => line !== "");
  }

  function seed(huntJson: unknown = HUNT_JSON, agentMd = AGENT_MD, skills: readonly string[] = Object.values(SKILLS)) {
    const seeded = sh(SEED, [ID, huntJson ? JSON.stringify(huntJson) : "", agentMd, skills.join(" ")]);
    expect(seeded.stderr).toBe("");
    expect(seeded.status).toBe(0);
  }

  function sessionConfig() {
    return huntCtlJson("session-config", ID, "--domain", DOMAIN);
  }

  /** Waits until the log `name` holds `count` lines with `text` and returns the log. */
  function waitForLog(name: string, text: string, count = 1) {
    return sh(`for _ in $(seq 100); do [ "$(grep -c -- "$2" "$1" 2>/dev/null)" -ge "$3" ] && break; sleep 0.1; done; cat "$1"`, [
      `/home/agent/logs/${name}.log`,
      text,
      String(count),
    ]).stdout;
  }

  beforeAll(() => {
    if (docker(["image", "inspect", IMAGE]).status !== 0) {
      const built = docker(["build", "--quiet", "--tag", IMAGE, "-"], DOCKERFILE);
      expect(built.stderr + built.stdout).not.toMatch(/ERROR/);
      expect(built.status).toBe(0);
    }
    const started = docker([
      "run",
      "--detach",
      "--rm",
      "--name",
      container,
      "--volume",
      `${BUNDLE}:/bundle:ro`,
      "--volume",
      `${FIXTURES}:/fixtures:ro`,
      IMAGE,
      "sleep",
      "infinity",
    ]);
    expect(started.stderr).toBe("");
    const setup = sh(SETUP);
    expect(setup.stderr).toBe("");
    expect(setup.status).toBe(0);
    expect(docker(["exec", container, "/srv/hunt/current/vm/hunt-ctl", "install-units"])).toMatchObject({ status: 0, stderr: "" });
    // A dev server on the port of admin, which the probes find answering.
    const server = "require('http').createServer((_, res) => res.end('ok')).listen(4200)";
    expect(docker(["exec", "--detach", "--user", "agent", container, "node", "-e", server]).status).toBe(0);
    // The ports of the VM's system services, which preview-status leaves out.
    const systemServers = "for (const port of [5355, 20201, 20202]) require('net').createServer().listen(port)";
    expect(docker(["exec", "--detach", container, "node", "-e", systemServers]).status).toBe(0);
  }, DOCKER_TIMEOUT_MS);

  afterAll(() => {
    docker(["rm", "--force", container]);
  });

  beforeEach(() => {
    seed();
  });

  it("installs the unit, the run script and the agent's sudo rule without restarting running services", () => {
    expect(sh("stat -c '%a %U' /etc/sudoers.d/hunt-service; test -x /srv/hunt/current/vm/hunt-service && echo runnable").stdout).toBe("440 root\nrunnable\n");
    const unit = sh("cat /etc/systemd/system/hunt-service@.service").stdout;
    expect(unit).toContain("\nUser=agent\n");
    expect(unit).toContain("\nExecStart=/srv/hunt/current/vm/hunt-service %i\nRuntimeDirectory=hunt-service-%i\n");
    expect(unit).toContain("\nRestart=on-failure\nSuccessExitStatus=130 SIGINT\n");
    expect(unit).toContain(
      "\nEnvironmentFile=/srv/hunt/current/vm/agent.env\nEnvironmentFile=-/etc/hunt/session.env\nEnvironmentFile=/etc/hunt/services/%i.env\n",
    );

    sh("mkdir -p /run/fake-systemd && echo active >/run/fake-systemd/hunt-service@api.service");
    expect(huntCtl("install-units")).toMatchObject({ status: 0, stderr: "" });
    const calls = systemctlCalls();
    expect(calls).toContain("systemctl daemon-reload");
    expect(calls.filter((call) => call.includes("hunt-service"))).toEqual([]);
    expect(sh("visudo -c -q && echo valid").stdout).toBe("valid\n");
  });

  it("logs every tmux window of the agent to ~/logs, through a pipe-pane -o and a grouped session, and rotates a big log", () => {
    expect(sh("stat -c '%a %U' /etc/tmux.conf").stdout).toBe("644 root\n");
    const tmux = (args: string) => sh(`runuser -u agent -- tmux ${args}`);
    const isLogging = (window: string) => tmux(`display-message -p -t app:${window} '#{pane_pipe}'`).stdout;
    sh("install -d -o agent -g agent /home/agent/logs && truncate -s 21M /home/agent/logs/web.log && chown agent:agent /home/agent/logs/web.log");

    expect(tmux(`new-session -d -s app -n web 'while :; do echo tick; sleep 0.1; done'`)).toMatchObject({ status: 0, stderr: "" });
    expect(waitForLog("web", "tick")).toMatch(/^tick\r\n/);
    expect(sh("stat -c %s /home/agent/logs/web.log.1").stdout).toBe(`${21 * 1024 * 1024}\n`);
    expect(tmux("new-session -d -t =app -s hunt-view-1")).toMatchObject({ status: 0, stderr: "" });
    expect(isLogging("web")).toBe("1\n");
    expect(tmux("pipe-pane -o -t app:web 'cat >/dev/null'")).toMatchObject({ status: 0, stderr: "" });
    expect(isLogging("web")).toBe("1\n");
    const ticks = waitForLog("web", "tick").split("tick").length;
    expect(waitForLog("web", "tick", ticks + 2).split("tick").length).toBeGreaterThan(ticks);

    tmux("new-window -d -t =app: -n build 'exec sleep 2147483647' ';' set-option -w -t app:build remain-on-exit on");
    tmux("respawn-pane -k -t app:build 'echo first; exit 3'");
    expect(waitForLog("build", "first")).toBe("first\r\n");
    tmux("respawn-pane -k -t app:build 'echo second; exit 4' ';' pipe-pane -t app:build");
    expect(waitForLog("build", "second")).toBe("first\r\nsecond\r\n");
    const ended = sh(
      `for _ in $(seq 50); do s=$(runuser -u agent -- tmux display-message -p -t app:build '#{pane_dead} #{pane_dead_status}'); [ "$s" = "1 4" ] && break; sleep 0.1; done; echo "$s"`,
    );
    expect(ended.stdout).toBe("1 4\n");
    tmux("kill-server");
  });

  it("lets the agent run only `hunt-ctl service`, `hunt-ctl clear <id> --keep-stored` and `hunt-ctl set-branch` through sudo", () => {
    sessionConfig();
    const listed = sh("sudo -l -U agent").stdout;
    const commands = listed.slice(listed.indexOf("may run the following commands")).split("\n").slice(1).join(" ").replace(/\s+/g, " ").trim();
    expect(commands).toBe(
      "(root) NOPASSWD: /usr/local/bin/hunt-ctl service start *, /usr/local/bin/hunt-ctl service stop *, " +
        "/usr/local/bin/hunt-ctl service restart *, /usr/local/bin/hunt-ctl service status, /usr/local/bin/hunt-ctl service status *, " +
        "/usr/local/bin/hunt-ctl clear * --keep-stored, /usr/local/bin/hunt-ctl set-branch *",
    );

    const asAgent = (...args: string[]) => docker(["exec", "--user", "agent", container, "sudo", "-n", ...args]);
    const status = asAgent("hunt-ctl", "service", "status");
    expect(status.stderr).toBe("");
    expect(JSON.parse(status.stdout).services.map((service: { name: string }) => service.name)).toEqual(["api", "admin", "ui"]);
    expect(asAgent("hunt-ctl", "service", "start", "api")).toMatchObject({ status: 0, stderr: "" });
    // sudo lets `clear --keep-stored` through; hunt-ctl then refuses the session, which has no branch here.
    expect(asAgent("hunt-ctl", "clear", ID, "--keep-stored")).toMatchObject({ status: 3, stderr: `hunt-ctl: meta.json of session ${ID} has no branch\n` });
    // sudo lets `set-branch` through too; hunt-ctl then refuses the branch name (clone.test.ts covers the names it takes).
    expect(asAgent("hunt-ctl", "set-branch", ID, "bad..branch")).toMatchObject({ status: 3, stderr: "hunt-ctl: invalid branch: bad..branch\n" });
    for (const command of [["hunt-ctl", "clear", ID], ["hunt-ctl", "destroy", ID], ["hunt-ctl", "service"], ["hunt-ctl", "session-config", ID, "--domain", DOMAIN], ["/bin/true"]]) {
      const refused = asAgent(...command);
      expect(refused.status, command.join(" ")).toBe(1);
      expect(refused.stderr, command.join(" ")).toMatch(/sudo: a password is required|is not allowed/);
    }
  });

  it("writes each service's environment, records the services and prints the prompt's services, hunt.agent.md and the swf settings", () => {
    sh("mkdir -p /etc/hunt/services && touch /etc/hunt/services/gone.env");
    const result = sessionConfig();
    expect(result).toEqual({
      agent_md: AGENT_MD.trim(),
      services_prompt: expect.stringMatching(/^### The repository's services\n/),
      swf_steps: {
        maxGateRuns: 5,
        questionPrefix: "❓ RÜCKFRAGE",
        projectStatus: { inProgress: "In Progress", inReview: "In Review", done: "Done" },
        mergeMethod: "squash",
        steps: {
          plan: { skill: "swf-plan", model: "claude-opus-5-5", effort: null, maxReturns: null, minSeverity: null, gate: [] },
          implement: { skill: "swf-implement", model: "claude-opus-5-5", effort: null, maxReturns: null, minSeverity: null, gate: ["good", "bad"] },
          verify: { skill: "swf-verify", model: "claude-opus-5-5", effort: null, maxReturns: 5, minSeverity: 3, gate: [] },
          review: { skill: "acme-review", model: "claude-opus-5-5", effort: null, maxReturns: 3, minSeverity: 3, gate: [] },
          pr: { skill: "swf-pr", model: "claude-opus-5-5", effort: null, maxReturns: null, minSeverity: null, gate: [] },
          "pr-gate": { skill: null, model: null, effort: null, maxReturns: 3, minSeverity: null, gate: [] },
          merge: { skill: null, model: null, effort: null, maxReturns: 2, minSeverity: null, gate: [] },
        },
      },
    });
    expect(result.services_prompt).toContain("https://7c0c6f2e-3000-open.hunt.example.com");

    expect(sh("ls /etc/hunt/services").stdout).toBe("admin.env\napi.env\nui.env\n");
    const admin = sh("cat /etc/hunt/services/admin.env").stdout;
    expect(admin).toContain('\nAPI_URL="https://7c0c6f2e-3000-open.hunt.example.com"\n');
    expect(admin).toContain('\nHUNT_SERVICE_DIR="/home/agent/app/admin"\n');
    expect(admin).toContain('\nHUNT_SERVICE_COMMAND="npm start"\n');
    expect(sh("cat /etc/hunt/services/api.env").stdout).toContain('\nADMIN_URL="https://7c0c6f2e-4200.hunt.example.com"\n');

    expect(JSON.parse(sh(`cat /srv/hunt/sessions/${ID}/meta.json`).stdout).preview).toEqual({
      domain: DOMAIN,
      services: Object.entries(DECLARED).map(([name, declared]) => ({ name, ...declared })),
    });
    expect(systemctlCalls()).toEqual(["systemctl enable --quiet hunt-proxy.service", "systemctl reload-or-restart hunt-proxy.service"]);
  });

  it("gives a service the remote secrets its hunt.json names from the file the gateway put there, which only root reads", () => {
    seed({ version: 3, services: { api: { command: "node server.js", port: 3000, remoteSecrets: { OPENAI_API_KEY: "$MED_OPENAI_API_KEY" } } } });
    const put = huntCtlWithInput(JSON.stringify({ MED_OPENAI_API_KEY: 'sk-test-"1234"', OTHER: "o" }), "put-remote-secrets");
    expect(put).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(put.stdout)).toEqual({ count: 2 });
    expect(sh("stat -c '%a %U' /etc/hunt/remote-secrets.json").stdout).toBe("600 root\n");

    sessionConfig();
    const api = sh("cat /etc/hunt/services/api.env").stdout;
    expect(api).toContain('\nOPENAI_API_KEY="sk-test-\\"1234\\""\n');
    expect(api).not.toContain("OTHER");
    expect(sh("stat -c '%a %U' /etc/hunt/services/api.env").stdout).toBe("600 root\n");

    for (const input of ['{"A": "sk-bad\\nvalue"}', '{"A": 1}', '["sk-bad"]', "sk-bad"]) {
      const refused = huntCtlWithInput(input, "put-remote-secrets");
      expect(refused.status, input).not.toBe(0);
      expect(refused.stderr, input).toContain("hunt-ctl: invalid remote secrets on stdin: expected a JSON object of single-line strings");
      expect(refused.stderr, input).not.toContain("sk-bad");
    }
    expect(sh("cat /etc/hunt/remote-secrets.json").stdout).toContain("MED_OPENAI_API_KEY");

    expect(huntCtlJson("destroy", ID)).toEqual({});
    expect(sh("test -e /etc/hunt/remote-secrets.json || echo removed").stdout).toBe("removed\n");
    seed({ version: 3, services: { api: { command: "node server.js", port: 3000, remoteSecrets: { OPENAI_API_KEY: "$MED_OPENAI_API_KEY" } } } });
    const missing = huntCtl("session-config", ID, "--domain", DOMAIN);
    expect(missing.status).toBe(3);
    expect(missing.stderr).toContain(
      "services.api.remoteSecrets.OPENAI_API_KEY: no remote secret MED_OPENAI_API_KEY; set it in Hunt under Settings → Remote VM",
    );
  });

  it("prints null for a repository without hunt.agent.md, no services and no swf settings without hunt.json", () => {
    seed(null, "", []);
    expect(sessionConfig()).toEqual({
      agent_md: null,
      services_prompt: expect.stringContaining("declares no services"),
      swf_steps: null,
    });
    expect(sh("ls -A /etc/hunt/services 2>/dev/null").stdout).toBe("");
    expect(JSON.parse(sh(`cat /srv/hunt/sessions/${ID}/meta.json`).stdout).preview).toEqual({ domain: DOMAIN, services: [] });
    expect(huntCtlJson("service", "status")).toEqual({ services: [] });
  });

  it("refuses an invalid hunt.json with its problems and changes nothing", () => {
    seed({ version: 3, services: { Bad: { command: "x", port: 3000 } } });
    const result = huntCtl("session-config", ID, "--domain", DOMAIN);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("services.Bad");
    expect(result.stderr).toContain("hunt-ctl: hunt.json or hunt.agent.md is not valid (see above)");
    expect(result.stdout).toBe("");
    expect(JSON.parse(sh(`cat /srv/hunt/sessions/${ID}/meta.json`).stdout).preview).toBeUndefined();
  });

  it("refuses a swf section whose skill files the worktree lacks, one problem per step, and checks none without the section", () => {
    seed(HUNT_JSON, AGENT_MD, ["swf-plan", "swf-implement", "swf-verify"]);
    const result = huntCtl("session-config", ID, "--domain", DOMAIN);
    expect(result.status).toBe(3);
    for (const [step, name] of [["review", "acme-review"], ["pr", "swf-pr"]]) {
      expect(result.stderr).toContain(
        `swf.steps.${step}.skill: no skill file .claude/skills/${name}/SKILL.md; Hunt offers to create it when a session of the repository opens`,
      );
    }
    expect(result.stderr).not.toContain("swf.steps.plan.skill");
    expect(result.stderr).toContain("hunt-ctl: hunt.json or hunt.agent.md is not valid (see above)");
    expect(JSON.parse(sh(`cat /srv/hunt/sessions/${ID}/meta.json`).stdout).preview).toBeUndefined();

    seed({ version: 3, services: HUNT_JSON.services }, AGENT_MD, []);
    expect(sessionConfig()).toMatchObject({ swf_steps: null });
  });

  it("refuses a swf section that names no skill for an agent step, since Hunt has no default skill", () => {
    seed({ ...HUNT_JSON, swf: { model: "claude-opus-5-5" } }, AGENT_MD, Object.values(SKILLS));
    const withoutSkills = huntCtl("session-config", ID, "--domain", DOMAIN);
    expect(withoutSkills.status).toBe(3);
    expect(withoutSkills.stderr).toContain(
      "swf.steps: must name the skill of every agent step (plan, implement, verify, review, pr); Hunt asks to add them when a session of the repository opens",
    );

    seed({ ...HUNT_JSON, swf: { skills: { plan: "swf-plan", review: "acme-review" } } }, AGENT_MD, Object.values(SKILLS));
    const withoutSteps = huntCtl("session-config", ID, "--domain", DOMAIN);
    expect(withoutSteps.status).toBe(3);
    for (const step of ["implement", "verify", "pr"]) {
      expect(withoutSteps.stderr).toContain(`swf.steps.${step}.skill: must name the skill of the step; Hunt asks to add it when a session of the repository opens`);
    }
    expect(withoutSteps.stderr).not.toContain("no skill file");
    expect(JSON.parse(sh(`cat /srv/hunt/sessions/${ID}/meta.json`).stdout).preview).toBeUndefined();
  });

  it("stops and disables the enabled services that hunt.json no longer declares", () => {
    seed({ version: 3, services: { admin: { command: "npm start", cwd: "admin", port: 4200 } } });
    sh("mkdir -p /run/fake-systemd /etc/systemd/system/multi-user.target.wants && cd /etc/systemd/system/multi-user.target.wants && " +
      "for name in api admin; do ln -s ../hunt-service@.service hunt-service@$name.service; echo active >/run/fake-systemd/hunt-service@$name.service; done");
    sessionConfig();
    expect(systemctlCalls()).toEqual([
      "systemctl disable --quiet --now hunt-service@api.service",
      "systemctl reset-failed hunt-service@api.service",
      "systemctl enable --quiet hunt-proxy.service",
      "systemctl reload-or-restart hunt-proxy.service",
    ]);
    expect(sh("ls /etc/hunt/services").stdout).toBe("admin.env\n");
    expect(huntCtlJson("service", "status").services).toEqual([reported("admin", { enabled: true, state: "running", responds: true, uses: [] })]);
  });

  it("reports no used services for a meta.json that session-config wrote before it recorded them", () => {
    sessionConfig();
    sh(`f=/srv/hunt/sessions/${ID}/meta.json; jq 'del(.preview.services[].uses)' "$f" >"$f.tmp" && mv "$f.tmp" "$f"`);
    expect(huntCtlJson("service", "status").services).toEqual([reported("api", { uses: [] }), reported("admin", { responds: true, uses: [] }), reported("ui")]);
  });

  it("starts, restarts and stops services and reports every service with its URL, state and answer", () => {
    sessionConfig();
    systemctlCalls();
    expect(huntCtlJson("service", "start", "api", "admin")).toEqual({
      services: [reported("api", { enabled: true, state: "running" }), reported("admin", { enabled: true, state: "running", responds: true }), reported("ui")],
    });
    expect(systemctlCalls()).toEqual([
      "systemctl reset-failed hunt-service@api.service hunt-service@admin.service",
      "systemctl enable --quiet --now hunt-service@api.service hunt-service@admin.service",
      "systemctl show --property Id,ActiveState,SubState,UnitFileState,InvocationID hunt-service@api.service hunt-service@admin.service hunt-service@ui.service",
    ]);

    sh("echo failed >/run/fake-systemd/hunt-service@api.service; echo activating >/run/fake-systemd/hunt-service@ui.service");
    expect(huntCtlJson("service", "status").services).toEqual([
      reported("api", { enabled: true, state: "failed" }),
      reported("admin", { enabled: true, state: "running", responds: true }),
      reported("ui", { state: "starting" }),
    ]);
    expect(huntCtlJson("service", "status", "ui", "api").services).toEqual([
      reported("api", { enabled: true, state: "failed" }),
      reported("ui", { state: "starting" }),
    ]);
    systemctlCalls();

    expect(huntCtlJson("service", "restart", "api").services[0]).toEqual(reported("api", { enabled: true, state: "running" }));
    expect(systemctlCalls().slice(0, 3)).toEqual([
      "systemctl enable --quiet hunt-service@api.service",
      "systemctl reset-failed hunt-service@api.service",
      "systemctl restart hunt-service@api.service",
    ]);

    expect(huntCtlJson("service", "stop", "admin").services[1]).toEqual(reported("admin", { responds: true }));
    expect(systemctlCalls().slice(0, 2)).toEqual([
      "systemctl disable --quiet --now hunt-service@admin.service",
      "systemctl reset-failed hunt-service@admin.service",
    ]);
  });

  it("counts start, stop and restart as activity and keeps status out of it and the journal", () => {
    sessionConfig();
    sh("rm -f /var/lib/hunt/activity");
    huntCtlJson("service", "status");
    expect(sh("test -e /var/lib/hunt/activity").status).toBe(1);
    huntCtlJson("service", "start", "ui");
    expect(sh("test -e /var/lib/hunt/activity").status).toBe(0);
  });

  it("rejects invalid and unknown names, a missing action and a VM without exactly one configured session", () => {
    sessionConfig();
    const cases: [string[], number, string][] = [
      [["service"], 2, "usage: hunt-ctl"],
      [["service", "start"], 2, "usage: hunt-ctl"],
      [["service", "reload", "api"], 2, "usage: hunt-ctl"],
      [["service", "start", "Bad_Name"], 3, "hunt-ctl: invalid service name: Bad_Name"],
      [["service", "start", "api", "../x"], 3, "hunt-ctl: invalid service name: ../x"],
      [["service", "stop", "nope"], 3, "hunt-ctl: hunt.json declares no service nope; it declares: api admin ui"],
      [["service", "status", "nope"], 3, "hunt-ctl: hunt.json declares no service nope"],
    ];
    for (const [args, status, message] of cases) {
      const result = huntCtl(...args);
      expect(result.status, args.join(" ")).toBe(status);
      expect(result.stderr, args.join(" ")).toContain(message);
      expect(result.stdout, args.join(" ")).toBe("");
    }
    expect(systemctlCalls().filter((call) => !call.includes("hunt-proxy"))).toEqual([]);

    seed();
    expect(huntCtl("service", "status").stderr).toContain(`hunt-ctl: session ${ID} has no services yet; run hunt-ctl session-config first`);
    sh("rm -rf /srv/hunt/sessions/*");
    expect(huntCtl("service", "status").stderr).toContain("hunt-ctl: no session on this VM");
    seed();
    sh(`cp -R /srv/hunt/sessions/${ID} /srv/hunt/sessions/7c0c6f2e-0000-4000-8000-000000000002`);
    expect(huntCtl("service", "status").stderr).toContain("hunt-ctl: this VM holds 2 sessions; hunt-ctl service needs exactly one");
  });

  it("reports the services' state and the listening ports for the preview", () => {
    sessionConfig();
    huntCtlJson("service", "start", "admin");
    const expected = {
      services: [
        { name: "api", port: 3000, tls: false, guarded: false, uses: ["admin"], enabled: false, state: "stopped", responds: false, invocation: null },
        { name: "admin", port: 4200, tls: false, guarded: true, uses: ["api"], enabled: true, state: "running", responds: true, invocation: invocationOf("admin") },
        { name: "ui", port: 4400, tls: true, guarded: true, uses: [], enabled: false, state: "stopped", responds: false, invocation: null },
      ],
      listening: [4200],
    };
    expect(huntCtlJson("preview-status", ID)).toEqual(expected);
    expect(huntCtlJson("preview-status")).toEqual(expected);
    sh(`rm -rf /srv/hunt/sessions/${ID}`);
    expect(huntCtlJson("preview-status")).toEqual({ services: [], listening: [4200] });
  });

  it("stops and disables every service on stop, and on destroy removes their environments too", () => {
    sessionConfig();
    huntCtlJson("service", "start", "api", "admin");
    systemctlCalls();
    expect(huntCtlJson("stop", ID)).toEqual({});
    expect(systemctlCalls()).toEqual([
      "systemctl disable --quiet --now hunt-relay.service",
      "systemctl disable --quiet hunt-service@admin.service hunt-service@api.service",
      "systemctl stop hunt-service@*.service",
      "systemctl reset-failed hunt-service@*.service",
      "systemctl disable --quiet --now hunt-proxy.service hunt-review.service hunt-desktop.service",
    ]);
    expect(huntCtlJson("service", "status").services.map((service: { enabled: boolean; state: string }) => [service.enabled, service.state])).toEqual([
      [false, "stopped"],
      [false, "stopped"],
      [false, "stopped"],
    ]);
    expect(sh("ls /etc/hunt/services").stdout).toBe("admin.env\napi.env\nui.env\n");

    huntCtlJson("service", "start", "ui");
    // A service that runs without being enabled stops as well.
    sh("echo active >/run/fake-systemd/hunt-service@api.service");
    systemctlCalls();
    expect(huntCtlJson("destroy", ID)).toEqual({});
    expect(systemctlCalls()).toEqual([
      "systemctl disable --quiet --now hunt-relay.service",
      "systemctl reset-failed hunt-relay.service",
      "systemctl disable --quiet hunt-service@ui.service",
      "systemctl stop hunt-service@*.service",
      "systemctl reset-failed hunt-service@*.service",
      "systemctl disable --quiet --now hunt-proxy.service hunt-review.service",
    ]);
    expect(sh("cat /run/fake-systemd/hunt-service@api.service /run/fake-systemd/hunt-service@ui.service").stdout).toBe("inactive\ninactive\n");
    expect(sh("ls -A /etc/systemd/system/multi-user.target.wants").stdout).toBe("");
    expect(sh(`test -e /etc/hunt/services || test -e /srv/hunt/sessions/${ID} || echo removed`).stdout).toBe("removed\n");
  });

  it("runs a service's command as the agent in a tmux server of its own, in its folder, without the HUNT_SERVICE_ variables, logging to ~/logs", () => {
    const runtime = "/run/hunt-service-admin";
    const environment = ["HOME=/home/agent", `RUNTIME_DIRECTORY=${runtime}`, "HUNT_SERVICE_DIR=/home/agent/app/admin", "API_URL=http://api"];
    const run = (command: string) =>
      docker([
        "exec",
        "--user",
        "agent",
        ...[...environment, `HUNT_SERVICE_COMMAND=${command}`].flatMap((variable) => ["--env", variable]),
        container,
        "/srv/hunt/current/vm/hunt-service",
        "admin",
      ]);
    /**
     * Starts the service with `command` in the background, waits until its log shows `started`, prints the session and
     * window of its tmux server, runs the tmux command `action` there and prints the service's exit status.
     */
    const interrupted = (command: string, action: string) =>
      sh(
        String.raw`
          command=$1 action=$2
          shift 2
          runuser -u agent -- env "$@" HUNT_SERVICE_COMMAND="$command" /srv/hunt/current/vm/hunt-service admin &
          service=$!
          for _ in $(seq 100); do grep -q '^started' /home/agent/logs/admin.log 2>/dev/null && break; sleep 0.1; done
          runuser -u agent -- tmux -S /run/hunt-service-admin/tmux list-windows -a -F '#{session_name}:#{window_name} #{pane_pipe}'
          runuser -u agent -- tmux -S /run/hunt-service-admin/tmux $action
          status=0
          wait "$service" || status=$?
          echo "status=$status"`,
        [command, action, ...environment],
      );
    sh(`rm -rf ${runtime} && install -d -o agent -g agent ${runtime} /home/agent/logs`);
    sh("truncate -s 21M /home/agent/logs/admin.log && chown agent:agent /home/agent/logs/admin.log");

    const command = 'echo "$(id -un) in $PWD: [${HUNT_SERVICE_DIR-}${HUNT_SERVICE_COMMAND-}${RUNTIME_DIRECTORY-}${TMUX-}] api=$API_URL"; ' +
      'tty -s && echo "terminal ${TERM%%-*}"; shopt -q login_shell || echo plain';
    expect(run(command)).toEqual({ status: 0, stdout: "", stderr: "" });
    expect(sh("stat -c %s /home/agent/logs/admin.log.1").stdout).toBe(`${21 * 1024 * 1024}\n`);
    const log = waitForLog("admin", "plain");
    expect(log).toMatch(/^==== \d{4}-\d\d-\d\d \d\d:\d\d:\d\d \S+: starting echo .* in \/home\/agent\/app\/admin\r\n/);
    expect(log.slice(log.indexOf("\n") + 1)).toMatch(/^agent in \/home\/agent\/app\/admin: \[\] api=http:\/\/api\r\nterminal (tmux|screen)\r\nplain\r\n$/);
    expect(sh(`cat ${runtime}/exit`).stdout).toBe("0\n");

    expect(run("exit 3")).toEqual({ status: 3, stdout: "", stderr: "" });
    expect(run("echo bye; exit 130").status).toBe(130);
    expect(waitForLog("admin", "^==== ", 3).match(/^==== /gm)).toHaveLength(3);

    // Ctrl-C typed into the terminal ends the command, which exits with 130.
    expect(interrupted("echo started; sleep 30", "send-keys -t =admin: C-c")).toMatchObject({ status: 0, stdout: "admin:admin 1\nstatus=130\n", stderr: "" });
    sh("rm -f /home/agent/logs/admin.log");
    // A tmux server that ends leaves no exit code; the service fails.
    expect(interrupted("echo started; sleep 30", "kill-server")).toMatchObject({
      status: 0,
      stdout: "admin:admin 1\nstatus=1\n",
      stderr: "hunt-service: the tmux server of admin ended before the command\n",
    });

    const invalid = docker(["exec", "--user", "agent", container, "/srv/hunt/current/vm/hunt-service", "../x"]);
    expect(invalid).toMatchObject({ status: 2, stderr: "usage: hunt-service <name>\n" });
  });

  it("runs a check of hunt.json in the worktree, passes its output through and exits with its status", () => {
    sh("install -d -o agent -g agent /home/agent/app/.git");
    expect(huntCtl("check", "/home/agent/app", "good")).toEqual({ status: 0, stdout: "ok-output\n", stderr: "" });
    expect(huntCtl("check", "/home/agent/app/", "bad")).toEqual({ status: 3, stdout: "bad-output\n", stderr: "" });

    const missing = huntCtl("check", "/home/agent/app", "lint");
    expect(missing).toMatchObject({ status: 3, stdout: "" });
    expect(missing.stderr).toBe("checks.lint: no such check\nhunt-ctl: hunt.json is not valid or declares no check lint (see above)\n");
    expect(huntCtl("check", "/home/agent/app", "Bad")).toMatchObject({ status: 3, stdout: "", stderr: "hunt-ctl: invalid check name: Bad\n" });
    expect(huntCtl("check", "/home/agent/other", "good")).toMatchObject({ status: 3, stderr: "hunt-ctl: not a session repository: /home/agent/other\n" });
    expect(huntCtl("check", "/home/agent/app").status).toBe(2);
  });

  it("runs a check as the agent in a login shell with the session's variables, in color and without stdin", () => {
    const command = 'echo "$(id -un) in $PWD color=$FORCE_COLOR url=${HUNT_PREVIEW_URL_TEMPLATE-}"; shopt -q login_shell && echo login; ' +
      "read -r line || echo no-input; echo to-stderr >&2; exit 1";
    seed({ version: 3, checks: { env: { command, cwd: "admin" } } }, "");
    sh("install -d -o agent -g agent /home/agent/app/.git");
    sessionConfig();
    expect(huntCtlWithInput("typed\n", "check", "/home/agent/app", "env")).toEqual({
      status: 1,
      stdout: "agent in /home/agent/app/admin color=1 url=https://7c0c6f2e-{port}.hunt.example.com\nlogin\nno-input\n",
      stderr: "to-stderr\n",
    });

    seed({ version: 3, checks: { env: { command: "true", cwd: "missing" } } }, "");
    sh("install -d -o agent -g agent /home/agent/app/.git");
    expect(huntCtl("check", "/home/agent/app", "env")).toMatchObject({
      status: 3,
      stderr: "hunt-ctl: the folder missing of the check env does not exist in the worktree\n",
    });
  });

  it("records the software factory's pipeline and a step's result in .hunt/swf of the worktree as the agent, which status reports", () => {
    expect(huntCtlJson("status", ID).swf).toBeNull();
    const pipeline = { step: "implement", runs: [{ n: 1, step: "plan", outcome: "passed" }, { n: 2, step: "implement", outcome: "running" }] };
    const body = "## Plan\n\n1. Fix the login.\n<!-- hunt:step {\"step\":\"plan\"} -->";
    sh("rm -f /var/lib/hunt/activity");
    const recorded = huntCtlWithInput(JSON.stringify({ pipeline, step: { n: 1, step: "plan", body } }), "swf-record", ID);
    expect(recorded).toEqual({ status: 0, stdout: "{}\n", stderr: "" });
    expect(sh("test -e /var/lib/hunt/activity").status).toBe(1);
    expect(JSON.parse(sh("cat /home/agent/app/.hunt/swf/pipeline.json").stdout)).toEqual(pipeline);
    expect(sh("cat /home/agent/app/.hunt/swf/steps/01-plan.md").stdout).toBe(`${body}\n`);
    expect(sh("stat -c %U /home/agent/app/.hunt/swf /home/agent/app/.hunt/swf/steps /home/agent/app/.hunt/swf/pipeline.json /home/agent/app/.hunt/swf/steps/01-plan.md").stdout).toBe("agent\nagent\nagent\nagent\n");
    expect(huntCtlJson("status", ID).swf).toEqual(pipeline);

    const later = { ...pipeline, step: "verify" };
    expect(huntCtlWithInput(JSON.stringify({ pipeline: later }), "swf-record", ID).status).toBe(0);
    expect(huntCtlJson("status", ID).swf).toEqual(later);
    expect(sh("ls /home/agent/app/.hunt/swf/steps").stdout).toBe("01-plan.md\n");

    expect(huntCtlWithInput("[]", "swf-record", ID)).toMatchObject({ status: 3, stderr: "hunt-ctl: swf-record: stdin holds no JSON object with a pipeline object\n" });
    expect(huntCtlWithInput(JSON.stringify({ pipeline, step: { n: "x", step: "plan" } }), "swf-record", ID)).toMatchObject({
      status: 3,
      stderr: "hunt-ctl: swf-record: the step needs a number n and a step name\n",
    });
    expect(huntCtlJson("status", ID).swf).toEqual(later);
  });

  it("puts a message for the swf runner into .hunt/swf/inbox of the worktree as the agent, complete when it appears, and counts it as no activity", () => {
    sh("rm -f /var/lib/hunt/activity");
    const first = huntCtlWithInput(JSON.stringify({ kind: "answers", comments: [] }), "swf-inbox", ID);
    expect(first).toMatchObject({ status: 0, stderr: "" });
    const { name } = JSON.parse(first.stdout);
    expect(name).toMatch(/^\d{13}-\d+\.json$/);
    expect(sh("test -e /var/lib/hunt/activity").status).toBe(1);
    expect(sh(`stat -c '%U %a' /home/agent/app/.hunt/swf /home/agent/app/.hunt/swf/inbox "/home/agent/app/.hunt/swf/inbox/${name}"`).stdout).toBe("agent 755\nagent 755\nagent 644\n");
    expect(JSON.parse(sh(`cat "/home/agent/app/.hunt/swf/inbox/${name}"`).stdout)).toEqual({ kind: "answers", comments: [] });

    const second = huntCtlWithInput(JSON.stringify({ kind: "pipeline", pipeline: { step: "implement" } }), "swf-inbox", ID);
    expect(second.status).toBe(0);
    expect(sh("ls /home/agent/app/.hunt/swf/inbox").stdout.split("\n").filter(Boolean)).toEqual([name, JSON.parse(second.stdout).name].sort());
    expect(huntCtlWithInput("[1, 2]", "swf-inbox", ID)).toMatchObject({ status: 3, stderr: "hunt-ctl: swf-inbox: stdin holds no JSON object\n" });
    expect(huntCtlWithInput("", "swf-inbox", ID)).toMatchObject({ status: 3, stderr: "hunt-ctl: swf-inbox: stdin holds no JSON object\n" });
  });
});
