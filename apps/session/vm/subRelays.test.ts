/**
 * The relays of a session's sub chats (`hunt-ctl start|wait|clear|stop <id> --sub <sub id>`, hunt-relay@.service) in a
 * Debian 12 container with Node 24, the base of the session VMs; skipped without a Docker daemon. The container runs
 * the built session artifact (`nx build session`) with the fake `systemctl` of `fixtures/systemctl`, which logs its
 * calls to /var/log/systemctl.log and keeps each unit's state in /run/fake-systemd/<unit>. No relay runs: the tests write
 * the status.json a relay would write.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const BUNDLE = fileURLToPath(new URL("../../../dist/apps/session", import.meta.url));
const FIXTURES = fileURLToPath(new URL("./fixtures", import.meta.url));
const DOCKER_TIMEOUT_MS = 600_000;
const ID = "7c0c6f2e-0000-4000-8000-000000000001";
const SUB = "7c0c6f2e-0000-4000-8000-0000000000aa";
const OTHER_SUB = "7c0c6f2e-0000-4000-8000-0000000000bb";
const UNIT = `hunt-relay@${SUB}.service`;
const SUB_CONFIG = `/home/agent/.claude/hunt-subs/${SUB}.json`;

/** The image of services.test.ts. */
const DOCKERFILE = `FROM node:24-bookworm-slim
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \\
      bash ca-certificates curl iproute2 jq sudo util-linux \\
    && rm -rf /var/lib/apt/lists/*
RUN groupadd -g 2000 agent && useradd -u 2000 -g 2000 -m -d /home/agent -s /bin/bash agent \\
    && mkdir -p /etc/hunt /etc/systemd/system /opt/hunt/node/bin && echo session >/etc/hunt/role \\
    && ln -s /usr/local/bin/node /opt/hunt/node/bin/node
`;
const IMAGE = `hunt-ctl-test:${createHash("sha256").update(DOCKERFILE).digest("hex").slice(0, 12)}`;

const SETUP = String.raw`
set -euo pipefail
mkdir -p /srv/hunt
cp -R /bundle /srv/hunt/current
echo 0123456789abcdef >/srv/hunt/current/.hash
install -m 0755 /fixtures/systemctl /usr/local/bin/systemctl
`;

/**
 * Resets the VM to the prepared session $1 with the hunt-session.json $2 and the tokens `start` stored, without units,
 * relay states or sub chats.
 */
const SEED = String.raw`
set -euo pipefail
rm -rf /srv/hunt/sessions /home/agent/app /home/agent/.claude /etc/hunt/secrets.env /run/fake-systemd /run/hunt-sub \
  /var/log/systemctl.log
install -d -m 0700 /srv/hunt/sessions "/srv/hunt/sessions/$1"
install -d -o agent -g agent /home/agent/app
printf '{"repo": "acme/app", "worktree": "/home/agent/app", "branch": "feat/general/x", "createdAt": 1}\n' \
  >"/srv/hunt/sessions/$1/meta.json"
install -d -o agent -g agent -m 0700 /home/agent/.claude
printf '%s' "$2" | runuser -u agent -- tee /home/agent/.claude/hunt-session.json >/dev/null
(umask 077 && printf 'CLAUDE_CODE_OAUTH_TOKEN="token"\n' >/etc/hunt/secrets.env)
`;

/** The session's hunt-session.json as the handoff writes it, plus a field the relay keeps without knowing it. */
const SESSION_CONFIG = {
  huntSessionId: ID,
  acpSessionId: "acp-session",
  cwd: "/home/agent/app",
  systemPromptAppend: "## Remote\nYou run on a VM.",
  modeId: "bypassPermissions",
  configOptions: { model: "opus" },
  extra: true,
};

const SELECTION_PROMPT = '\n## Selected code\nThe user opened this chat from a selection in `src/a.ts` (lines 3-4).\n```\nconst a = "$HOME";\n```\n';

function docker(args: string[], input?: string) {
  const result = spawnSync("docker", args, { input, encoding: "utf8", timeout: DOCKER_TIMEOUT_MS });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function hasDocker(): boolean {
  return spawnSync("docker", ["info"], { stdio: "ignore", timeout: 20_000 }).status === 0;
}

describe.skipIf(!hasDocker())("the relays of a session's sub chats in a Debian container", () => {
  const container = `hunt-ctl-sub-relays-${randomUUID().slice(0, 8)}`;

  /** Runs `script` with bash in the container as root; `args` become $1… */
  function sh(script: string, args: string[] = []) {
    return docker(["exec", container, "bash", "-c", script, "bash", ...args]);
  }

  /** Runs `hunt-ctl` with `input` on stdin (none without it). */
  function huntCtl(args: string[], input?: string) {
    return docker(["exec", ...(input === undefined ? [] : ["--interactive"]), container, "hunt-ctl", ...args], input);
  }

  /** Runs `hunt-ctl` and returns its JSON result, failing on any stderr or exit status. */
  function huntCtlJson(args: string[], input?: string) {
    const result = huntCtl(args, input);
    expect(result.stderr, args.join(" ")).toBe("");
    expect(result.status, args.join(" ")).toBe(0);
    return JSON.parse(result.stdout);
  }

  /** The fake systemctl's calls since the last call of this function. */
  function systemctlCalls(): string[] {
    const calls = sh("cat /var/log/systemctl.log 2>/dev/null; rm -f /var/log/systemctl.log").stdout;
    return calls.split("\n").filter((line) => line !== "");
  }

  function setState(unit: string, state: string) {
    expect(sh('mkdir -p /run/fake-systemd && echo "$2" >"/run/fake-systemd/$1"', [unit, state]).status).toBe(0);
  }

  function readJson(path: string) {
    const result = sh('cat "$1"', [path]);
    expect(result.status, path).toBe(0);
    return JSON.parse(result.stdout);
  }

  /** Writes the status.json of the sub chat's relay with a fresh heartbeat and `fields`. */
  function writeSubStatus(fields: Record<string, unknown>) {
    const script = String.raw`
      install -d -o agent -g agent "/run/hunt-sub/$1"
      jq -n --argjson now "$(date +%s%3N)" --argjson fields "$2" '{heartbeatAt: $now} + $fields' >"/run/hunt-sub/$1/status.json"`;
    expect(sh(script, [SUB, JSON.stringify(fields)])).toMatchObject({ status: 0, stderr: "" });
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
  }, DOCKER_TIMEOUT_MS);

  afterAll(() => {
    docker(["rm", "--force", container]);
  });

  beforeEach(() => {
    const seeded = sh(SEED, [ID, JSON.stringify(SESSION_CONFIG)]);
    expect(seeded.stderr).toBe("");
    expect(seeded.status).toBe(0);
  });

  it("installs the template unit of the sub chats' relays", () => {
    expect(sh("cat /etc/systemd/system/hunt-relay@.service").stdout).toContain(
      "ExecStart=/usr/bin/env HUNT_CONFIG=/home/agent/.claude/hunt-subs/%i.json HUNT_SOCKET_DIR=/run/hunt-sub/%i",
    );
  });

  it("starts a sub chat's relay with the session's configuration and the text on stdin appended to its system prompt", () => {
    expect(huntCtlJson(["start", ID, "--sub", SUB], SELECTION_PROMPT)).toEqual({ relay: "running" });
    expect(readJson(SUB_CONFIG)).toEqual({
      ...SESSION_CONFIG,
      huntSessionId: SUB,
      acpSessionId: null,
      systemPromptAppend: `${SESSION_CONFIG.systemPromptAppend}\n\n${SELECTION_PROMPT}`,
    });
    expect(sh('stat -c "%a %U" /home/agent/.claude/hunt-subs "$1"', [SUB_CONFIG]).stdout).toBe("700 agent\n600 agent\n");
    expect(systemctlCalls()).toEqual([`systemctl is-active --quiet ${UNIT}`, `systemctl start ${UNIT}`]);
    // The session's relay and its configuration stay as they are.
    expect(readJson("/home/agent/.claude/hunt-session.json")).toEqual(SESSION_CONFIG);

    // Without text the system prompt is the session's.
    expect(huntCtlJson(["start", ID, "--sub", OTHER_SUB], "")).toEqual({ relay: "running" });
    expect(readJson(`/home/agent/.claude/hunt-subs/${OTHER_SUB}.json`).systemPromptAppend).toBe(SESSION_CONFIG.systemPromptAppend);
  });

  it("keeps a sub chat's configuration and its conversation on later starts and leaves a running relay alone", () => {
    huntCtlJson(["start", ID, "--sub", SUB], SELECTION_PROMPT);
    sh(`runuser -u agent -- sh -c 'jq ".acpSessionId = \\"acp-sub\\"" "$1" >"$1.tmp" && mv "$1.tmp" "$1"' sh ${SUB_CONFIG}`);
    const config = readJson(SUB_CONFIG);
    systemctlCalls();

    expect(huntCtlJson(["start", ID, "--sub", SUB], "other text")).toEqual({ relay: "running" });
    expect(systemctlCalls()).toEqual([`systemctl is-active --quiet ${UNIT}`]);
    setState(UNIT, "inactive");
    expect(huntCtlJson(["start", ID, "--sub", SUB], "other text")).toEqual({ relay: "running" });
    expect(systemctlCalls()).toEqual([`systemctl is-active --quiet ${UNIT}`, `systemctl start ${UNIT}`]);
    expect(readJson(SUB_CONFIG)).toEqual({ ...config, acpSessionId: "acp-sub" });
  });

  it("refuses a sub chat's relay without the session's tokens or configuration, and invalid arguments", () => {
    sh("rm /etc/hunt/secrets.env");
    expect(huntCtl(["start", ID, "--sub", SUB], SELECTION_PROMPT)).toMatchObject({
      status: 3,
      stdout: "",
      stderr: expect.stringContaining(`hunt-ctl: session ${ID} has no tokens on this VM; run hunt-ctl start ${ID} first`),
    });
    sh("rm /home/agent/.claude/hunt-session.json");
    expect(huntCtl(["start", ID, "--sub", SUB], SELECTION_PROMPT).stderr).toContain(`hunt-ctl: session ${ID} has no hunt-session.json`);
    expect(sh("test -e /home/agent/.claude/hunt-subs || echo none").stdout).toBe("none\n");

    const cases: [string[], number, string][] = [
      [["start", ID, "--sub", "../x"], 3, "hunt-ctl: invalid sub chat id: ../x"],
      [["start", ID, "--sub"], 2, "usage: hunt-ctl"],
      [["start", ID, "--other", SUB], 2, "usage: hunt-ctl"],
      [["stop", ID, "--sub", "X"], 3, "hunt-ctl: invalid sub chat id: X"],
      [["clear", ID, "--sub", SUB, "extra"], 2, "usage: hunt-ctl"],
      [["wait", ID, "--sub"], 3, "hunt-ctl: invalid sub chat id: "],
    ];
    for (const [args, status, message] of cases) {
      const result = huntCtl(args);
      expect(result.status, args.join(" ")).toBe(status);
      expect(result.stderr, args.join(" ")).toContain(message);
    }
    expect(systemctlCalls()).toEqual([]);
  });

  it("waits for the sub chat's relay and prints its status", () => {
    setState(UNIT, "active");
    writeSubStatus({ state: "ready", acpSessionId: "acp-sub", clientConnected: true, turn: "idle" });
    const status = huntCtlJson(["wait", ID, "--sub", SUB, "--timeout", "5"]);
    expect(status).toMatchObject({ state: "ready", acpSessionId: "acp-sub" });

    writeSubStatus({ state: "failed", error: "no token" });
    expect(huntCtl(["wait", ID, "--sub", SUB, "--timeout", "5"])).toMatchObject({
      status: 3,
      stderr: expect.stringContaining(`hunt-ctl: the agent failed to start: no token\nlast log lines of ${UNIT}:`),
    });
    sh(`rm -rf /run/hunt-sub/${SUB}`);
    setState(UNIT, "inactive");
    expect(huntCtl(["wait", ID, "--sub", SUB, "--timeout", "5"]).stderr).toContain("hunt-ctl: the relay is inactive; run hunt-ctl start first");
  });

  it("clears a sub chat's conversation and waits for the new one", () => {
    huntCtlJson(["start", ID, "--sub", SUB], SELECTION_PROMPT);
    sh(`runuser -u agent -- sh -c 'jq ".acpSessionId = \\"acp-sub\\"" "$1" >"$1.tmp" && mv "$1.tmp" "$1"' sh ${SUB_CONFIG}`);
    writeSubStatus({ state: "ready", acpSessionId: "acp-new", clientConnected: true });
    systemctlCalls();

    expect(huntCtlJson(["clear", ID, "--sub", SUB])).toMatchObject({ acpSessionId: "acp-new" });
    expect(readJson(SUB_CONFIG).acpSessionId).toBeNull();
    expect(systemctlCalls()).toEqual([`systemctl stop ${UNIT}`, `systemctl is-active --quiet ${UNIT}`, `systemctl start ${UNIT}`]);
    expect(readJson("/home/agent/.claude/hunt-session.json")).toEqual(SESSION_CONFIG);
    expect(sh("cat /etc/hunt/secrets.env").stdout).toBe('CLAUDE_CODE_OAUTH_TOKEN="token"\n');
  });

  it("stops a deleted sub chat's relay and removes its configuration", () => {
    huntCtlJson(["start", ID, "--sub", SUB], SELECTION_PROMPT);
    huntCtlJson(["start", ID, "--sub", OTHER_SUB], "");
    systemctlCalls();

    expect(huntCtlJson(["stop", ID, "--sub", SUB])).toEqual({});
    expect(systemctlCalls()).toEqual([`systemctl stop ${UNIT}`, `systemctl reset-failed ${UNIT}`]);
    expect(sh("ls /home/agent/.claude/hunt-subs").stdout).toBe(`${OTHER_SUB}.json\n`);
    expect(sh(`cat /run/fake-systemd/${UNIT} /run/fake-systemd/hunt-relay@${OTHER_SUB}.service`).stdout).toBe("inactive\nactive\n");
  });

  it("stops every sub chat's relay with the session's, keeping their configurations, and destroy removes them", () => {
    huntCtlJson(["start", ID, "--sub", SUB], SELECTION_PROMPT);
    huntCtlJson(["start", ID, "--sub", OTHER_SUB], "");

    expect(huntCtlJson(["stop", ID])).toEqual({});
    expect(sh(`cat /run/fake-systemd/${UNIT} /run/fake-systemd/hunt-relay@${OTHER_SUB}.service`).stdout).toBe("inactive\ninactive\n");
    expect(sh("ls /home/agent/.claude/hunt-subs").stdout).toBe(`${SUB}.json\n${OTHER_SUB}.json\n`);

    huntCtlJson(["start", ID, "--sub", SUB]);
    systemctlCalls();
    expect(huntCtlJson(["destroy", ID])).toEqual({});
    expect(systemctlCalls()).toContain("systemctl stop hunt-relay@*.service");
    expect(sh(`cat /run/fake-systemd/${UNIT}`).stdout).toBe("inactive\n");
    expect(sh("test -e /home/agent/.claude || echo removed").stdout).toBe("removed\n");
  });
});
