/**
 * `hunt-ctl clone` in a Debian 12 container, the base of the session VMs; skipped without a Docker daemon. GitHub is
 * faked inside the container: git reaches https://github.com/ through `url.<…>.insteadOf` at a busybox httpd that serves
 * bare repositories over Git's dumb HTTP protocol behind Basic authentication with the token, and a `curl` earlier on
 * PATH answers https://api.github.com/user when its configuration on stdin carries the token. A system-wide credential
 * helper with a wrong password proves that the clone uses only the token from stdin. The container runs the built
 * session artifact (`nx build session`).
 */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BUNDLE = fileURLToPath(new URL("../../../dist/apps/session", import.meta.url));
const TOKEN = "github_pat_11TEST0123456789_abcdefghijklmnop";
/** A token in GitHub's format, which hunt-ctl redacts by its pattern. */
const PATTERN_TOKEN = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";
/** A wrong token in no known format, which hunt-ctl redacts because it read it from stdin. */
const PLAIN_TOKEN = "plain.wrong-token";
const DOCKER_TIMEOUT_MS = 600_000;

const DOCKERFILE = `FROM debian:12
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \\
      bash busybox ca-certificates curl git git-lfs jq util-linux \\
    && rm -rf /var/lib/apt/lists/*
RUN groupadd -g 2000 agent && useradd -u 2000 -g 2000 -m -d /home/agent -s /bin/bash agent \\
    && mkdir -p /etc/hunt && echo session >/etc/hunt/role
`;
const IMAGE = `hunt-ctl-test:${createHash("sha256").update(DOCKERFILE).digest("hex").slice(0, 12)}`;

/**
 * Prepares the container: the bundle as the current release, the bare repository acme/app with `main` and the branch
 * `feat/general/7-existing` one commit ahead, the fake GitHub and the misleading system credential helper. Prints the commits of
 * main and of the existing branch.
 */
const SETUP = String.raw`
set -euo pipefail
mkdir -p /srv/hunt
cp -R /bundle /srv/hunt/current
echo 0123456789abcdef >/srv/hunt/current/.hash

mkdir -p /etc/fakegithub /srv/github/acme /var/tmp/seed
printf '%s\n' "$1" >/etc/fakegithub/token
printf '/:x-access-token:%s\n' "$1" >/etc/fakegithub/httpd.conf
git init --quiet --bare --initial-branch=main /srv/github/acme/app.git
cd /var/tmp/seed
git init --quiet --initial-branch=main .
git -c user.name=Seed -c user.email=seed@example.com commit --quiet --allow-empty -m "Initial commit"
echo "# app" >README.md
git add README.md
git -c user.name=Seed -c user.email=seed@example.com commit --quiet -m "Add a README"
git branch feat/general/7-existing
git checkout --quiet feat/general/7-existing
echo "work" >work.txt
git add work.txt
git -c user.name=Seed -c user.email=seed@example.com commit --quiet -m "Earlier work"
git push --quiet /srv/github/acme/app.git main feat/general/7-existing
git -C /srv/github/acme/app.git update-server-info
main=$(git rev-parse main)
existing=$(git rev-parse feat/general/7-existing)
cd /
rm -rf /var/tmp/seed

busybox httpd -p 127.0.0.1:8080 -h /srv/github -c /etc/fakegithub/httpd.conf
git config --system url."http://127.0.0.1:8080/".insteadOf "https://github.com/"
git config --system credential.helper '!f() { echo username=x-access-token; echo password=wrong; }; f'

cat >/usr/local/bin/curl <<'CURL'
#!/bin/bash
# GET https://api.github.com/user for the token in /etc/fakegithub/token, read from the configuration on stdin.
config=$(cat)
if [[ " $* " != *" --config - "* || " $* " != *" https://api.github.com/user "* ]]; then
  echo "fake curl: unexpected arguments: $*" >&2
  exit 2
fi
if [[ $config != "header = \"Authorization: Bearer $(cat /etc/fakegithub/token)\"" ]]; then
  # Quotes the token it got, so that the journal shows hunt-ctl redacting it.
  echo "curl: (22) The requested URL returned error: 401 for the token \"$(sed 's/.*Bearer //' <<<"$config")" >&2
  exit 22
fi
echo '{"login": "hunt-bot", "id": 4242, "name": null}'
CURL
chmod 0755 /usr/local/bin/curl
echo "$main $existing"
`;

function docker(args: string[], input?: string) {
  const result = spawnSync("docker", args, { input, encoding: "utf8", timeout: DOCKER_TIMEOUT_MS });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function hasDocker(): boolean {
  return spawnSync("docker", ["info"], { stdio: "ignore", timeout: 20_000 }).status === 0;
}

describe.skipIf(!hasDocker())("hunt-ctl clone in a Debian container", () => {
  const container = `hunt-ctl-clone-${randomUUID().slice(0, 8)}`;
  let mainCommit = "";
  let existingCommit = "";

  /** Runs `script` with bash in the container as root; `args` become $1… */
  function sh(script: string, args: string[] = [], input?: string) {
    return docker(["exec", "-i", container, "bash", "-c", script, "bash", ...args], input);
  }

  /** Runs `git -C <dir> <args>` as the agent and returns its trimmed output. */
  function agentGit(dir: string, ...args: string[]): string {
    const result = docker(["exec", "-u", "agent", container, "git", "-C", dir, ...args]);
    expect(result.stderr).toBe("");
    return result.stdout.trim();
  }

  function clone(id: string, repo: string, branch: string, token = TOKEN) {
    return docker(["exec", "-i", container, "/srv/hunt/current/vm/hunt-ctl", "clone", id, "--repo", repo, "--branch", branch], `${token}\n`);
  }

  beforeAll(() => {
    if (docker(["image", "inspect", IMAGE]).status !== 0) {
      const built = docker(["build", "--quiet", "--tag", IMAGE, "-"], DOCKERFILE);
      expect(built.stderr + built.stdout).not.toMatch(/ERROR/);
      expect(built.status).toBe(0);
    }
    const started = docker(["run", "--detach", "--rm", "--name", container, "--volume", `${BUNDLE}:/bundle:ro`, IMAGE, "sleep", "infinity"]);
    expect(started.stderr).toBe("");
    const setup = sh(SETUP, [TOKEN]);
    expect(setup.stderr).toBe("");
    [mainCommit, existingCommit] = setup.stdout.trim().split(" ");
  }, DOCKER_TIMEOUT_MS);

  afterAll(() => {
    docker(["rm", "--force", container]);
  });

  it("clones the repository as the agent onto a new branch from the default branch and records the token's user", () => {
    const id = "0c0c6f2e-0000-4000-8000-000000000001";
    const result = clone(id, "acme/app", "fix/general/12-fix-login");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ path: "/home/agent/app" });

    expect(agentGit("/home/agent/app", "symbolic-ref", "--short", "HEAD")).toBe("fix/general/12-fix-login");
    expect(agentGit("/home/agent/app", "rev-parse", "HEAD")).toBe(mainCommit);
    expect(agentGit("/home/agent/app", "config", "remote.origin.url")).toBe("https://github.com/acme/app.git");
    expect(agentGit("/home/agent/app", "symbolic-ref", "refs/remotes/origin/HEAD")).toBe("refs/remotes/origin/main");
    expect(docker(["exec", "-u", "agent", container, "git", "-C", "/home/agent/app", "config", "branch.fix/general/12-fix-login.remote"]).status).toBe(1);

    const files = sh("stat -c %U /home/agent/app /home/agent/app/.git /home/agent/app/README.md; tail -n 1 /home/agent/app/.git/info/exclude; ls /home/agent/app/.git/hooks");
    expect(files.stdout).toMatch(/^agent\nagent\nagent\n\.hunt\/\n[\s\S]*\bpre-push\n/);

    const meta = JSON.parse(sh(`cat /srv/hunt/sessions/${id}/meta.json`).stdout);
    expect(meta).toEqual({
      repo: "acme/app",
      worktree: "/home/agent/app",
      createdAt: expect.any(Number),
      branch: "fix/general/12-fix-login",
      gitName: "hunt-bot",
      gitEmail: "4242+hunt-bot@users.noreply.github.com",
      origin: "swf",
    });

    const leftovers = sh('grep -rlF -- "$1" /home/agent /srv/hunt/sessions /var/tmp /tmp 2>/dev/null || true', [TOKEN]);
    expect(leftovers.stdout).toBe("");
    const withoutToken = docker(["exec", "-u", "agent", container, "git", "ls-remote", "https://github.com/acme/app.git"]);
    expect(withoutToken.status).toBe(128);
    expect(withoutToken.stderr).toContain("Authentication failed");
  }, DOCKER_TIMEOUT_MS);

  it("checks out a branch the origin has already, tracking it", () => {
    const result = clone("0c0c6f2e-0000-4000-8000-000000000002", "acme/app", "feat/general/7-existing");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(agentGit("/home/agent/app", "symbolic-ref", "--short", "HEAD")).toBe("feat/general/7-existing");
    expect(agentGit("/home/agent/app", "rev-parse", "HEAD")).toBe(existingCommit);
    expect(agentGit("/home/agent/app", "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/feat/general/7-existing");
  }, DOCKER_TIMEOUT_MS);

  it("rejects invalid arguments and tokens and reports GitHub's refusals without the token", () => {
    const id = "0c0c6f2e-0000-4000-8000-000000000003";
    const cases: [ReturnType<typeof clone>, string][] = [
      [clone(id, "acme/app", "bad..branch"), "invalid branch: bad..branch"],
      [clone(id, "acme/app", "-x"), "invalid branch: -x"],
      [clone(id, "../etc", "feat/general/1-x"), "invalid repository: ../etc"],
      [clone(id, "acme/app", "feat/general/1-x", "two words"), "invalid GitHub token on stdin"],
      [clone(id, "acme/app", "feat/general/1-x", ""), "invalid GitHub token on stdin"],
      [clone(id, "acme/app", "feat/general/1-x", "github_pat_wrong"), "failed to read the GitHub user of the token"],
      [clone(id, "acme/missing", "feat/general/1-x"), "failed to clone https://github.com/acme/missing.git"],
    ];
    for (const [result, message] of cases) {
      expect(result.status).toBe(3);
      expect(result.stderr).toContain(`hunt-ctl: ${message}`);
      expect(result.stderr).not.toContain(TOKEN);
      expect(result.stdout).toBe("");
    }
    expect(sh('grep -rlF -- "$1" /home/agent /srv/hunt/sessions /var/tmp /tmp 2>/dev/null || true', [TOKEN]).stdout).toBe("");
  }, DOCKER_TIMEOUT_MS);

  it("logs its steps and the end of a failure's stderr to syslog under the identifier hunt-ctl with tokens redacted, and prints the same without a syslog socket", () => {
    const id = "0c0c6f2e-0000-4000-8000-000000000004";
    expect(sh("test -e /dev/log").status).toBe(1);
    const withoutSyslog = clone(id, "acme/app", "feat/general/7-existing");
    expect(withoutSyslog.stderr).toBe("");
    expect(withoutSyslog.status).toBe(0);

    // busybox syslogd stands in for journald: it serves /dev/log and writes `<facility>.<priority> <tag>: <message>`.
    const syslogd = sh("busybox syslogd -O /var/log/messages && for _ in $(seq 50); do test -S /dev/log && exit 0; sleep 0.1; done; exit 1");
    expect(syslogd.status).toBe(0);
    try {
      expect(clone(id, "acme/app", "feat/general/7-existing")).toEqual(withoutSyslog);
      expect(clone(id, "acme/app", "bad..branch").status).toBe(3);
      expect(sh('/srv/hunt/current/vm/hunt-ctl status "$1"', [id]).status).toBe(0);
      expect(clone(id, "acme/app", `bad..${PATTERN_TOKEN}`).status).toBe(3);
      expect(clone(id, "acme/app", "feat/general/1-x", PLAIN_TOKEN).status).toBe(3);
      const lines = sh("sleep 0.5; grep -F ' hunt-ctl: ' /var/log/messages | sed 's/^.* \\([a-z]*\\.[a-z]*\\) hunt-ctl: /\\1 /'").stdout;
      expect(lines).toMatch(
        new RegExp(
          "^" +
            [
              `user\\.info clone ${id}: started`,
              `user\\.info clone ${id}: cloning acme/app onto branch feat/general/7-existing`,
              `user\\.info clone ${id}: finished in \\d+ ms`,
              `user\\.info clone ${id}: started`,
              `user\\.err clone ${id}: failed with exit status 3 after \\d+ ms at cmd_clone:\\d+ < main:\\d+`,
              `user\\.err clone ${id}: stderr: hunt-ctl: invalid branch: bad\\.\\.branch`,
              `user\\.info clone ${id}: started`,
              `user\\.err clone ${id}: failed with exit status 3 after \\d+ ms at cmd_clone:\\d+ < main:\\d+`,
              `user\\.err clone ${id}: stderr: hunt-ctl: invalid branch: bad\\.\\.\\[redacted\\]`,
              `user\\.info clone ${id}: started`,
              `user\\.info clone ${id}: cloning acme/app onto branch feat/general/1-x`,
              `user\\.err clone ${id}: failed with exit status 3 after \\d+ ms: \`identity=\\$\\(github_identity .*\\)\` at cmd_clone:\\d+ < main:\\d+`,
              `user\\.err clone ${id}: stderr: curl: \\(22\\) The requested URL returned error: 401 for the token "\\[redacted\\]"`,
              `user\\.err clone ${id}: stderr: hunt-ctl: failed to read the GitHub user of the token`,
              "",
            ].join("\n") +
            "$",
        ),
      );
      const messages = sh("cat /var/log/messages").stdout;
      for (const token of [TOKEN, PATTERN_TOKEN, PLAIN_TOKEN]) {
        expect(messages).not.toContain(token);
      }
    } finally {
      sh("kill $(cat /var/run/syslogd.pid); rm -f /dev/log");
    }
  }, DOCKER_TIMEOUT_MS);
});
