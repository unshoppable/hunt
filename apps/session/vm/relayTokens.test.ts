/**
 * The tokens a session's relay stores (`hunt-ctl start <id> [--keep-stored]`, /etc/hunt/secrets.env and
 * /etc/hunt/github-token, which `hunt-ctl github-token` replaces and gh's wrapper vm/hunt-gh reads) and the restart of a
 * running relay with another Claude Code token, in a Debian 12 container with Node 24, the base of the session VMs;
 * skipped without a Docker daemon. The container runs
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
const OTHER_ID = "7c0c6f2e-0000-4000-8000-0000000000bb";

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
 * Resets the VM to the prepared session $1 with the hunt-session.json $2 and the tokens `start` stored, without units
 * or relay states.
 */
const SEED = String.raw`
set -euo pipefail
rm -rf /srv/hunt/sessions /home/agent/app /home/agent/.claude /etc/hunt/secrets.env /etc/hunt/github-token \
  /var/lib/hunt/activity /run/fake-systemd /run/hunt /var/log/systemctl.log
install -d -m 0700 /srv/hunt/sessions "/srv/hunt/sessions/$1"
install -d -o agent -g agent /home/agent/app
printf '{"repo": "acme/app", "worktree": "/home/agent/app", "branch": "feat/general/x", "createdAt": 1, "gitName": "Agent", "gitEmail": "agent@example.com"}\n' \
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

function docker(args: string[], input?: string) {
  const result = spawnSync("docker", args, { input, encoding: "utf8", timeout: DOCKER_TIMEOUT_MS });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function hasDocker(): boolean {
  return spawnSync("docker", ["info"], { stdio: "ignore", timeout: 20_000 }).status === 0;
}

describe.skipIf(!hasDocker())("the tokens of a session's relay in a Debian container", () => {
  const container = `hunt-ctl-relay-tokens-${randomUUID().slice(0, 8)}`;

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

  /** Writes the relay's status.json with a fresh heartbeat and `fields`. */
  function writeStatus(fields: Record<string, unknown>) {
    const script = String.raw`
      install -d -o agent -g agent /run/hunt
      jq -n --argjson now "$(date +%s%3N)" --argjson fields "$1" '{heartbeatAt: $now} + $fields' >/run/hunt/status.json`;
    expect(sh(script, [JSON.stringify(fields)])).toMatchObject({ status: 0, stderr: "" });
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

  /** The token lines of the relay's secrets file (never a GH_TOKEN) followed by the GitHub token file's line, if any. */
  function storedTokens(): string[] {
    const secrets = sh("cat /etc/hunt/secrets.env").stdout;
    expect(secrets).not.toContain("GH_TOKEN");
    const claude = secrets.split("\n").filter((line) => line.startsWith("CLAUDE_CODE_OAUTH_TOKEN="));
    const github = sh("cat /etc/hunt/github-token 2>/dev/null || true").stdout.split("\n").filter((line) => line !== "");
    return [...claude, ...github];
  }

  it("starts the session's relay with the tokens on stdin, which with --keep-stored only fill what the VM has not stored", () => {
    expect(huntCtlJson(["start", ID, "--keep-stored"], "sk-ant-new\ngithub_pat_1\n")).toEqual({ relay: "running" });
    expect(storedTokens()).toEqual(['CLAUDE_CODE_OAUTH_TOKEN="token"', "github_pat_1"]);
    expect(systemctlCalls()).toEqual([
      "systemctl is-active --quiet hunt-relay.service",
      "systemctl enable --quiet hunt-relay.service",
      "systemctl restart hunt-relay.service",
    ]);
    // The agent reads the GitHub token through gh's wrapper; only root writes it.
    expect(sh('stat -c "%a %U %G" /etc/hunt/github-token').stdout).toBe("640 root agent\n");
    expect(sh("stat -c %a /etc/hunt/secrets.env").stdout).toBe("600\n");

    // Without the flag a given token replaces the stored one and an empty line keeps it.
    setState("hunt-relay.service", "inactive");
    expect(huntCtlJson(["start", ID], "sk-ant-new\n\n")).toEqual({ relay: "running" });
    expect(storedTokens()).toEqual(['CLAUDE_CODE_OAUTH_TOKEN="sk-ant-new"', "github_pat_1"]);
    setState("hunt-relay.service", "inactive");
    expect(huntCtlJson(["start", ID], "\ngithub_pat_3\n")).toEqual({ relay: "running" });
    expect(storedTokens()).toEqual(['CLAUDE_CODE_OAUTH_TOKEN="sk-ant-new"', "github_pat_3"]);

    // A VM that lost its secrets takes both tokens even with the flag.
    setState("hunt-relay.service", "inactive");
    sh("rm /etc/hunt/secrets.env /etc/hunt/github-token");
    expect(huntCtlJson(["start", ID, "--keep-stored"], "sk-ant-other\ngithub_pat_2\n")).toEqual({ relay: "running" });
    expect(storedTokens()).toEqual(['CLAUDE_CODE_OAUTH_TOKEN="sk-ant-other"', "github_pat_2"]);

    for (const args of [["stop", ID, "--keep-stored"], ["start", ID, "--keep-stored", "extra"], ["start", ID, "--sub", OTHER_ID]]) {
      expect(huntCtl(args).stderr, args.join(" ")).toContain("usage: hunt-ctl");
    }
  });

  it("replaces the GitHub token with github-token without touching the relay, and does not count that as activity", () => {
    huntCtlJson(["start", ID], "sk-ant-new\ngithub_pat_1\n");
    systemctlCalls();
    sh("rm -f /var/lib/hunt/activity");
    expect(huntCtlJson(["github-token", ID], "ghs_new\n")).toEqual({});
    expect(storedTokens()).toEqual(['CLAUDE_CODE_OAUTH_TOKEN="sk-ant-new"', "ghs_new"]);
    expect(sh('stat -c "%a %U %G" /etc/hunt/github-token').stdout).toBe("640 root agent\n");
    expect(systemctlCalls()).toEqual([]);
    expect(sh("test -e /var/lib/hunt/activity || echo none").stdout).toBe("none\n");

    expect(huntCtl(["github-token", ID], "two words\n")).toMatchObject({
      status: 3,
      stdout: "",
      stderr: expect.stringContaining("hunt-ctl: invalid GitHub token on stdin"),
    });
    expect(storedTokens()).toEqual(['CLAUDE_CODE_OAUTH_TOKEN="sk-ant-new"', "ghs_new"]);
    expect(huntCtl(["github-token", OTHER_ID], "ghs_other\n").stderr).toContain(`hunt-ctl: session ${OTHER_ID} is not initialized on this VM`);
    expect(huntCtl(["github-token", ID, "extra"], "ghs_other\n").stderr).toContain("usage: hunt-ctl");
  });

  it("runs gh through the wrapper vm/hunt-gh, which exports the token file as GH_TOKEN at every invocation", () => {
    // The real gh is a script that prints GH_TOKEN and its arguments.
    const fakeGh = '#!/bin/sh\nprintf "%s|%s\\n" "${GH_TOKEN-unset}" "$*"\n';
    const installed = sh(
      "install -m 0755 /srv/hunt/current/vm/hunt-gh /usr/local/bin/gh && install -d -m 0755 /usr/local/libexec/hunt && " +
        'printf "%s" "$1" >/usr/local/libexec/hunt/gh && chmod 0755 /usr/local/libexec/hunt/gh',
      [fakeGh],
    );
    expect(installed).toMatchObject({ status: 0, stderr: "" });
    huntCtlJson(["start", ID], "sk-ant-new\ngithub_pat_1\n");
    const asAgent = (...args: string[]) => docker(["exec", "-u", "agent", container, "env", ...args]);
    expect(asAgent("gh", "auth", "git-credential", "get")).toMatchObject({ status: 0, stdout: "github_pat_1|auth git-credential get\n" });
    huntCtlJson(["github-token", ID], "ghs_new\n");
    // A stale GH_TOKEN of a relay started before the refresh loses to the file.
    expect(asAgent("GH_TOKEN=old", "gh", "pr", "list")).toMatchObject({ status: 0, stdout: "ghs_new|pr list\n" });
    sh("rm /etc/hunt/github-token");
    expect(asAgent("GH_TOKEN=old", "gh", "x")).toMatchObject({ status: 0, stdout: "old|x\n" });
    expect(asAgent("gh", "x")).toMatchObject({ status: 0, stdout: "unset|x\n" });
  });

  it("restarts a running relay with another Claude token between turns and keeps its token while a turn runs or with --keep-stored", () => {
    huntCtlJson(["start", ID], "sk-ant-one\ngithub_pat_1\n");
    systemctlCalls();
    // The same token, or none, leaves the running relay alone.
    expect(huntCtlJson(["start", ID], "sk-ant-one\n\n")).toEqual({ relay: "running" });
    expect(huntCtlJson(["start", ID], "\ngithub_pat_2\n")).toEqual({ relay: "running" });
    expect(storedTokens()).toEqual(['CLAUDE_CODE_OAUTH_TOKEN="sk-ant-one"', "github_pat_1"]);
    expect(systemctlCalls()).toEqual(["systemctl is-active --quiet hunt-relay.service", "systemctl is-active --quiet hunt-relay.service"]);

    // Another token waits while a turn runs, and loses to the stored one with --keep-stored.
    writeStatus({ state: "ready", acpSessionId: "acp-session", turn: "running" });
    expect(huntCtlJson(["start", ID], "sk-ant-two\ngithub_pat_2\n")).toEqual({ relay: "running" });
    writeStatus({ state: "ready", acpSessionId: "acp-session", turn: "idle" });
    expect(huntCtlJson(["start", ID, "--keep-stored"], "sk-ant-two\ngithub_pat_2\n")).toEqual({ relay: "running" });
    expect(storedTokens()).toEqual(['CLAUDE_CODE_OAUTH_TOKEN="sk-ant-one"', "github_pat_1"]);
    expect(systemctlCalls()).toEqual(["systemctl is-active --quiet hunt-relay.service", "systemctl is-active --quiet hunt-relay.service"]);

    // Between turns the relay restarts with the token given, and the GitHub token comes along.
    expect(huntCtlJson(["start", ID], "sk-ant-two\ngithub_pat_2\n")).toEqual({ relay: "running" });
    expect(storedTokens()).toEqual(['CLAUDE_CODE_OAUTH_TOKEN="sk-ant-two"', "github_pat_2"]);
    expect(systemctlCalls()).toEqual([
      "systemctl is-active --quiet hunt-relay.service",
      "systemctl enable --quiet hunt-relay.service",
      "systemctl restart hunt-relay.service",
    ]);
  });

  it("removes the template unit of the sub chats' relays, which once ran on the VM, with install-units", () => {
    expect(sh("touch /etc/systemd/system/hunt-relay@.service && mkdir -p /run/fake-systemd && echo active >/run/fake-systemd/hunt-relay@x.service").status).toBe(0);
    systemctlCalls();
    expect(docker(["exec", container, "/srv/hunt/current/vm/hunt-ctl", "install-units"])).toMatchObject({ status: 0, stderr: "" });
    expect(sh("test -e /etc/systemd/system/hunt-relay@.service || echo removed").stdout).toBe("removed\n");
    expect(sh("cat /run/fake-systemd/hunt-relay@x.service").stdout).toBe("inactive\n");
    expect(systemctlCalls().slice(0, 2)).toEqual(["systemctl stop hunt-relay@*.service", "systemctl disable --quiet --now hunt-relay@.service"]);
  });
});
