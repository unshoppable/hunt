/**
 * `hunt-ctl plan-usage <id>`, which prints the plan limits of the Claude account the session's relay runs with, in a
 * Debian 12 container with Node 24, the base of the session VMs; skipped without a Docker daemon. The container runs the
 * built session artifact (`nx build session`) with a stub in place of `session/planUsage.mjs` that prints the token it
 * got in its environment and its arguments, so no request leaves the container.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BUNDLE = fileURLToPath(new URL("../../../dist/apps/session", import.meta.url));
const FIXTURES = fileURLToPath(new URL("./fixtures", import.meta.url));
const DOCKER_TIMEOUT_MS = 600_000;
const ID = "7c0c6f2e-0000-4000-8000-000000000001";

/** The image of services.test.ts. */
const DOCKERFILE = `FROM node:24-bookworm-slim
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \\
      bash ca-certificates curl iproute2 jq sudo tmux util-linux \\
    && rm -rf /var/lib/apt/lists/*
RUN groupadd -g 2000 agent && useradd -u 2000 -g 2000 -m -d /home/agent -s /bin/bash agent \\
    && mkdir -p /etc/hunt /etc/systemd/system /opt/hunt/node/bin && echo session >/etc/hunt/role \\
    && ln -s /usr/local/bin/node /opt/hunt/node/bin/node
`;
const IMAGE = `hunt-ctl-test:${createHash("sha256").update(DOCKERFILE).digest("hex").slice(0, 12)}`;

/** The artifact with the stub in place of planUsage.mjs, and an initialized session with a worktree. */
const SETUP = String.raw`
set -euo pipefail
mkdir -p /srv/hunt
cp -R /bundle /srv/hunt/current
echo 0123456789abcdef >/srv/hunt/current/.hash
install -m 0755 /fixtures/systemctl /usr/local/bin/systemctl
cat >/srv/hunt/current/session/planUsage.mjs <<'STUB'
process.stdout.write(JSON.stringify({ token: process.env.CLAUDE_CODE_OAUTH_TOKEN, argv: process.argv.slice(2) }));
STUB
install -d -m 0700 /srv/hunt/sessions "/srv/hunt/sessions/$1"
install -d -o agent -g agent /home/agent/app
printf '{"repo": "acme/app", "worktree": "/home/agent/app", "branch": "feat/general/x", "createdAt": 1, "gitName": "Agent", "gitEmail": "agent@example.com"}\n' \
  >"/srv/hunt/sessions/$1/meta.json"
`;

function docker(args: string[], input?: string) {
  const result = spawnSync("docker", args, { input, encoding: "utf8", timeout: DOCKER_TIMEOUT_MS });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function hasDocker(): boolean {
  return spawnSync("docker", ["info"], { stdio: "ignore", timeout: 20_000 }).status === 0;
}

describe.skipIf(!hasDocker())("the plan usage of a session's Claude account in a Debian container", () => {
  const container = `hunt-ctl-plan-usage-${randomUUID().slice(0, 8)}`;

  /** Runs `script` with bash in the container as root; `args` become $1… */
  function sh(script: string, args: string[] = []) {
    return docker(["exec", container, "bash", "-c", script, "bash", ...args]);
  }

  beforeAll(() => {
    if (docker(["image", "inspect", IMAGE]).status !== 0) {
      const built = docker(["build", "--quiet", "--tag", IMAGE, "-"], DOCKERFILE);
      expect(built.stderr + built.stdout).not.toMatch(/ERROR/);
      expect(built.status).toBe(0);
    }
    const started = docker(["run", "--detach", "--rm", "--name", container, "--volume", `${BUNDLE}:/bundle:ro`, "--volume", `${FIXTURES}:/fixtures:ro`, IMAGE, "sleep", "infinity"]);
    expect(started.stderr).toBe("");
    expect(sh(SETUP, [ID])).toMatchObject({ status: 0, stderr: "" });
    expect(docker(["exec", container, "/srv/hunt/current/vm/hunt-ctl", "install-units"])).toMatchObject({ status: 0, stderr: "" });
  }, DOCKER_TIMEOUT_MS);

  afterAll(() => {
    docker(["rm", "--force", container]);
  });

  it("fails while the VM stores no Claude token", () => {
    expect(sh("rm -f /etc/hunt/secrets.env").status).toBe(0);
    const result = docker(["exec", container, "hunt-ctl", "plan-usage", ID]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`no Claude Code OAuth token stored for session ${ID}`);
  });

  it("hands the stored token to planUsage.mjs in its environment, not as an argument, and prints its JSON", () => {
    // env_line escapes \, ", ` and $; hunt-ctl undoes it.
    expect(sh(String.raw`(umask 077 && printf '%s\n' 'CLAUDE_CODE_OAUTH_TOKEN="sk-ant-\$x"' 'HUNT_SESSION_ID="id"' >/etc/hunt/secrets.env && rm -f /var/lib/hunt/activity)`).status).toBe(0);
    const result = docker(["exec", container, "hunt-ctl", "plan-usage", ID]);
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({ token: "sk-ant-$x", argv: [] });
    // Reading the usage is no activity that keeps the VM awake.
    expect(sh("test -e /var/lib/hunt/activity").status).not.toBe(0);
  });
});
