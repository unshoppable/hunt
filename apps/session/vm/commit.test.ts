/**
 * `hunt-ctl commit` and `hunt-ctl push` in a Debian 12 container, the base of the session VMs; skipped without a Docker
 * daemon. The container holds a prepared session without a handoff: its meta.json names the worktree and the branch, and
 * the agent's repository /home/agent/app has that branch checked out with https://github.com/acme/app.git as origin.
 * GitHub is faked inside the container: git reaches https://github.com/ through `url.<…>.insteadOf` at a busybox httpd
 * whose CGI script /cgi-bin/git runs `git http-backend` on the bare repositories below /srv/git, behind Basic
 * authentication with the token. Unlike the dumb HTTP protocol of clone.test.ts, this smart HTTP protocol receives
 * pushes. A system-wide credential helper with a wrong password proves that the push uses only the token from stdin. A
 * tool in /opt/volta/bin, the first folder of vm/agent.env's PATH, shows that the repository's hooks run with the agent's
 * environment. The container runs the built session artifact (`nx build session`).
 */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const BUNDLE = fileURLToPath(new URL("../../../dist/apps/session", import.meta.url));
const TOKEN = "github_pat_11TEST0123456789_abcdefghijklmnop";
const WRONG_TOKEN = "github_pat_11WRONG0123456789_abcdefghijklmnop";
const ID = "0c0c6f2e-0000-4000-8000-000000000101";
/** A valid session id without meta.json on the VM. */
const UNKNOWN_ID = "0c0c6f2e-0000-4000-8000-000000000102";
/** A session that `init` created and `prepare` did not check out: its meta.json has no branch. */
const UNPREPARED_ID = "0c0c6f2e-0000-4000-8000-000000000103";
const BRANCH = "feat/general/9-commit";
const WORKTREE = "/home/agent/app";
const NAME = "Ada Lovelace";
const EMAIL = "ada@example.com";
/** The PATH of the agent's environment, which `agent_run` gives git and the hooks. */
const AGENT_PATH = /^PATH=(.*)$/m.exec(readFileSync(new URL("./agent.env", import.meta.url), "utf8"))![1];
const DOCKER_TIMEOUT_MS = 600_000;
/** How long a hunt-ctl call that must fail at once may take before the test gives up on it. */
const QUICK_TIMEOUT_MS = 30_000;

/** The image of clone.test.ts, which this test shares. */
const DOCKERFILE = `FROM debian:12
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \\
      bash busybox ca-certificates curl git git-lfs jq util-linux \\
    && rm -rf /var/lib/apt/lists/*
RUN groupadd -g 2000 agent && useradd -u 2000 -g 2000 -m -d /home/agent -s /bin/bash agent \\
    && mkdir -p /etc/hunt && echo session >/etc/hunt/role
`;
const IMAGE = `hunt-ctl-test:${createHash("sha256").update(DOCKERFILE).digest("hex").slice(0, 12)}`;

/**
 * Prepares the container: the bundle as the current release, the tool in /opt/volta/bin, the bare repository acme/app with
 * `main`, the fake GitHub with token $1 and the misleading system credential helper, and session $2 with the agent's
 * worktree on branch $3 from main. Prints the commit of main.
 */
const SETUP = String.raw`
set -euo pipefail
mkdir -p /srv/hunt
cp -R /bundle /srv/hunt/current
echo 0123456789abcdef >/srv/hunt/current/.hash

install -d -m 0755 /opt/volta/bin
printf '#!/bin/sh\necho volta-tool\n' >/opt/volta/bin/hunt-hook-tool
chmod 0755 /opt/volta/bin/hunt-hook-tool

mkdir -p /etc/fakegithub /srv/github/cgi-bin /srv/git/acme /var/tmp/seed
printf '/cgi-bin:x-access-token:%s\n' "$1" >/etc/fakegithub/httpd.conf
cat >/srv/github/cgi-bin/git <<'CGI'
#!/bin/sh
GIT_PROJECT_ROOT=/srv/git GIT_HTTP_EXPORT_ALL=1 exec git http-backend
CGI
chmod 0755 /srv/github/cgi-bin/git
git init --quiet --bare --initial-branch=main /srv/git/acme/app.git
git -C /srv/git/acme/app.git config http.receivepack true
cd /var/tmp/seed
git init --quiet --initial-branch=main .
mkdir src
echo "# app" >README.md
echo old >old.txt
echo staged >staged.txt
echo a >src/a.txt
git add .
git -c user.name=Seed -c user.email=seed@example.com commit --quiet -m "Initial commit"
git push --quiet /srv/git/acme/app.git main
cd /
cp -R /var/tmp/seed /home/agent/app
rm -rf /var/tmp/seed
chown -R agent:agent /home/agent/app
runuser -u agent -- git -C /home/agent/app remote add origin https://github.com/acme/app.git
runuser -u agent -- git -C /home/agent/app checkout --quiet -b "$3"

busybox httpd -p 127.0.0.1:8080 -h /srv/github -c /etc/fakegithub/httpd.conf
git config --system url."http://127.0.0.1:8080/cgi-bin/git/".insteadOf "https://github.com/"
git config --system credential.helper '!f() { echo username=x-access-token; echo password=wrong; }; f'

install -d -m 0700 /srv/hunt/sessions "/srv/hunt/sessions/$2"
jq -n --arg branch "$3" \
  '{repo: "acme/app", worktree: "/home/agent/app", createdAt: 1, branch: $branch, gitName: "hunt-bot", gitEmail: "4242+hunt-bot@users.noreply.github.com"}' \
  >"/srv/hunt/sessions/$2/meta.json"
runuser -u agent -- git -C /home/agent/app rev-parse main
`;

/** Resets the worktree, as the agent, to branch $2 at commit $1 without hooks, the ref of session $3 or the hook's log. */
const RESET = String.raw`
git checkout --quiet --force -B "$2" "$1"
git clean --quiet --force -d -x
git config --unset core.hooksPath || true
git update-ref -d "refs/hunt/$3/commit"
rm -f /home/agent/hook.log
`;

/**
 * A commit-msg hook that logs who runs it with which PATH, tools and stdin, and git's stdin ($PPID is git), prints on
 * stdout and appends the output of the tool in /opt/volta/bin to the message.
 */
const LOGGING_HOOK = String.raw`#!/bin/sh
{
  printf 'user=%s\n' "$(id -un)"
  printf 'path=%s\n' "$PATH"
  printf 'tool=%s\n' "$(command -v hunt-hook-tool)"
  printf 'home=%s\n' "$HOME"
  printf 'volta=%s\n' "$VOLTA_HOME"
  printf 'leak=%s\n' "$(printenv LEAK_CHECK || echo unset)"
  printf 'stdin=%s\n' "$(readlink /proc/self/fd/0)"
  printf 'parent=%s\n' "$(cat /proc/$PPID/comm)"
  printf 'git-stdin=%s\n' "$(readlink /proc/$PPID/fd/0)"
} >/home/agent/hook.log
echo "commit-msg hook output on stdout"
printf '\nHook-Tool: %s\n' "$(hunt-hook-tool)" >>"$1"
`;

const REJECTING_HOOK = "#!/bin/sh\necho 'pre-commit: lint failed' >&2\nexit 1\n";

/** Runs the docker CLI; `status` is null when it did not finish within `timeout`. */
function docker(args: string[], input?: string, timeout = DOCKER_TIMEOUT_MS) {
  const result = spawnSync("docker", args, { input, encoding: "utf8", timeout });
  return { status: result.error ? null : result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function hasDocker(): boolean {
  return spawnSync("docker", ["info"], { stdio: "ignore", timeout: 20_000 }).status === 0;
}

/** Stdin of `hunt-ctl commit`: the author's name and email, the message and the paths, each ending with NUL. */
function commitInput(message: string, paths: string[], name = NAME, email = EMAIL): string {
  return [name, email, message, ...paths].map((field) => `${field}\0`).join("");
}

describe.skipIf(!hasDocker())("hunt-ctl commit and push in a Debian container", () => {
  const container = `hunt-ctl-commit-${randomUUID().slice(0, 8)}`;
  let baseCommit = "";

  /** Runs `script` with bash in the container as root; `args` become $1… */
  function sh(script: string, args: string[] = [], input?: string) {
    return docker(["exec", "-i", container, "bash", "-c", script, "bash", ...args], input);
  }

  /** Runs `script` with bash as the agent in the worktree and expects it to succeed silently. */
  function agentSh(script: string, args: string[] = [], input?: string) {
    const result = docker(["exec", "-i", "-u", "agent", "-w", WORKTREE, container, "bash", "-c", `set -euo pipefail\n${script}`, "bash", ...args], input);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  }

  /** Runs `git <args>` as the agent in the worktree and returns its output without the trailing newline. */
  function agentGit(...args: string[]): string {
    const result = docker(["exec", "-u", "agent", container, "git", "-C", WORKTREE, ...args]);
    expect(result.stderr).toBe("");
    return result.stdout.trimEnd();
  }

  /** Runs `git <args>` in the bare repository of the fake GitHub. */
  function originGit(...args: string[]) {
    return docker(["exec", container, "git", "-C", "/srv/git/acme/app.git", ...args]);
  }

  /** Runs `hunt-ctl <command> <id>` as root with `input` on stdin and `variables` (NAME=value) in its environment. */
  function huntCtl(command: "commit" | "push", id: string, input: string, variables: string[] = [], timeout = DOCKER_TIMEOUT_MS) {
    const environment = variables.flatMap((variable) => ["--env", variable]);
    return docker(["exec", "-i", ...environment, container, "/srv/hunt/current/vm/hunt-ctl", command, id], input, timeout);
  }

  function push(token: string) {
    return huntCtl("push", ID, `${token}\n`);
  }

  function installHook(name: string, content: string) {
    agentSh('mkdir -p .githooks && cat >".githooks/$1" && chmod 0755 ".githooks/$1" && git config core.hooksPath .githooks', [name], content);
  }

  /** The files below /home/agent, /srv/hunt, /var/tmp and /tmp that hold `secret`, one per line. */
  function filesHolding(secret: string): string {
    return sh('grep -rlF -- "$1" /home/agent /srv/hunt /var/tmp /tmp 2>/dev/null || true', [secret]).stdout;
  }

  beforeAll(() => {
    if (docker(["image", "inspect", IMAGE]).status !== 0) {
      const built = docker(["build", "--quiet", "--tag", IMAGE, "-"], DOCKERFILE);
      expect(built.stderr + built.stdout).not.toMatch(/ERROR/);
      expect(built.status).toBe(0);
    }
    const started = docker(["run", "--detach", "--rm", "--name", container, "--volume", `${BUNDLE}:/bundle:ro`, IMAGE, "sleep", "infinity"]);
    expect(started.stderr).toBe("");
    const setup = sh(SETUP, [TOKEN, ID, BRANCH]);
    expect(setup.stderr).toBe("");
    expect(setup.status).toBe(0);
    baseCommit = setup.stdout.trim();
  }, DOCKER_TIMEOUT_MS);

  beforeEach(() => {
    agentSh(RESET, [baseCommit, BRANCH, ID]);
  }, DOCKER_TIMEOUT_MS);

  afterAll(() => {
    docker(["rm", "--force", container]);
  });

  it("commits exactly the given paths as the author on stdin and keeps what the agent staged", () => {
    agentSh(String.raw`
      echo more >>README.md
      mkdir docs
      echo new >"docs/new file.md"
      rm old.txt
      echo literal >"notes-*.txt"
      echo other >notes-1.txt
      echo "staged change" >>staged.txt
      git add staged.txt
      echo "unstaged change" >>src/a.txt`);

    const paths = ["README.md", "docs/new file.md", "old.txt", "notes-*.txt"];
    const result = huntCtl("commit", ID, commitInput("Update the README\n\nWith a body.", paths));
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const head = agentGit("rev-parse", "HEAD");
    expect(JSON.parse(result.stdout)).toEqual({ commit: head, committed: true });

    expect(agentGit("rev-parse", "HEAD~1")).toBe(baseCommit);
    expect(agentGit("rev-parse", `refs/hunt/${ID}/commit`)).toBe(head);
    expect(agentGit("symbolic-ref", "--short", "HEAD")).toBe(BRANCH);
    expect(agentGit("log", "-1", "--format=%an <%ae>%n%cn <%ce>%n%B")).toBe(
      `${NAME} <${EMAIL}>\n${NAME} <${EMAIL}>\nUpdate the README\n\nWith a body.`,
    );
    // `notes-*.txt` is a literal path: notes-1.txt stays untracked.
    expect(agentGit("diff-tree", "--no-commit-id", "--name-status", "-r", "HEAD")).toBe(
      "M\tREADME.md\nA\tdocs/new file.md\nA\tnotes-*.txt\nD\told.txt",
    );
    expect(agentGit("status", "--porcelain")).toBe(" M src/a.txt\nM  staged.txt\n?? notes-1.txt");
    expect(sh("find /home/agent/app -not -user agent").stdout).toBe("");
  }, DOCKER_TIMEOUT_MS);

  it("runs the repository's hooks as the agent with the agent's environment, without hunt-ctl's stdin and stdout", () => {
    installHook("commit-msg", LOGGING_HOOK);
    agentSh("echo hooked >hooked.txt");

    const result = huntCtl("commit", ID, commitInput("Add a hooked file", ["hooked.txt"]), ["LEAK_CHECK=from-root"]);
    expect(result.status).toBe(0);
    const head = agentGit("rev-parse", "HEAD");
    expect(result.stdout).toBe(`${JSON.stringify({ commit: head, committed: true })}\n`);
    expect(result.stderr).toBe("commit-msg hook output on stdout\n");

    expect(sh("cat /home/agent/hook.log").stdout).toBe(
      [
        "user=agent",
        // git puts its exec path in front of the PATH it runs hooks with.
        `path=/usr/lib/git-core:${AGENT_PATH}`,
        "tool=/opt/volta/bin/hunt-hook-tool",
        "home=/home/agent",
        "volta=/opt/volta",
        "leak=unset",
        "stdin=/dev/null",
        "parent=git",
        "git-stdin=/dev/null",
        "",
      ].join("\n"),
    );
    expect(agentGit("log", "-1", "--format=%B")).toBe("Add a hooked file\n\nHook-Tool: volta-tool");
    expect(agentGit("rev-parse", `refs/hunt/${ID}/commit`)).toBe(head);
  }, DOCKER_TIMEOUT_MS);

  it("fails without a commit when a hook rejects it", () => {
    installHook("pre-commit", REJECTING_HOOK);
    agentSh("echo more >>README.md");

    const result = huntCtl("commit", ID, commitInput("Update the README", ["README.md"]));
    expect(result.status).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("pre-commit: lint failed\nhunt-ctl: failed to commit the files on the VM\n");
    expect(agentGit("rev-parse", "HEAD")).toBe(baseCommit);
    expect(docker(["exec", "-u", "agent", container, "git", "-C", WORKTREE, "rev-parse", "--verify", "--quiet", `refs/hunt/${ID}/commit`]).status).toBe(1);
  }, DOCKER_TIMEOUT_MS);

  it("commits nothing for paths the branch has committed already, also for a deletion neither in the worktree nor the index", () => {
    agentSh(String.raw`
      echo more >>README.md
      git rm --quiet old.txt
      git -c user.name=Agent -c user.email=agent@example.com commit --quiet -am "The agent's own commit"`);
    const agentCommit = agentGit("rev-parse", "HEAD");

    for (const paths of [["README.md", "old.txt"], ["old.txt"]]) {
      const result = huntCtl("commit", ID, commitInput("Commit again", paths));
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ commit: agentCommit, committed: false });
    }
    expect(agentGit("rev-parse", "HEAD")).toBe(agentCommit);
    expect(agentGit("rev-parse", `refs/hunt/${ID}/commit`)).toBe(agentCommit);
    expect(agentGit("status", "--porcelain")).toBe("");
  }, DOCKER_TIMEOUT_MS);

  it("rejects invalid input and a detached HEAD without committing", () => {
    agentSh("echo more >>README.md");
    const cases: [ReturnType<typeof huntCtl>, string][] = [
      [huntCtl("commit", ID, commitInput("Escape", ["../x"])), "invalid path: ../x"],
      [huntCtl("commit", ID, commitInput("Escape", ["src/../../x"])), "invalid path: src/../../x"],
      [huntCtl("commit", ID, commitInput("Absolute", ["/etc/passwd"])), "invalid path: /etc/passwd"],
      [huntCtl("commit", ID, commitInput(" \n\t ", ["README.md"])), "invalid commit message: expected text"],
      [huntCtl("commit", ID, commitInput("No paths", [])), "no paths on stdin"],
      [huntCtl("commit", ID, commitInput("No name", ["README.md"], "")), "invalid git name: expected one non-empty line"],
      [huntCtl("commit", ID, commitInput("Two lines", ["README.md"], NAME, `${EMAIL}\nx`)), "invalid git email: expected one non-empty line"],
      [huntCtl("commit", "not-a-session", commitInput("Bad id", ["README.md"])), "invalid session id: not-a-session"],
    ];
    for (const [result, message] of cases) {
      expect(result).toEqual({ status: 3, stdout: "", stderr: `hunt-ctl: ${message}\n` });
    }
    expect(agentGit("rev-parse", "HEAD")).toBe(baseCommit);

    agentSh("git checkout --quiet --detach");
    const detached = huntCtl("commit", ID, commitInput("Detached", ["README.md"]));
    expect(detached.status).toBe(3);
    expect(detached.stdout).toBe("");
    expect(detached.stderr).toBe("the worktree on the VM has no branch checked out\nhunt-ctl: failed to commit the files on the VM\n");
    expect(agentGit("rev-parse", "HEAD")).toBe(baseCommit);
    expect(agentGit("status", "--porcelain")).toBe(" M README.md");
  }, DOCKER_TIMEOUT_MS);

  it("rejects invalid and wrong tokens and a detached HEAD without the token in its output or files", () => {
    const cases: [ReturnType<typeof push>, string][] = [
      [push(""), "invalid GitHub token on stdin"],
      [push("two words"), "invalid GitHub token on stdin"],
      [push(WRONG_TOKEN), "failed to push the branch from the VM"],
    ];
    for (const [result, message] of cases) {
      expect(result.status).toBe(3);
      expect(result.stderr).toContain(`hunt-ctl: ${message}`);
      expect(result.stdout).toBe("");
      for (const token of [TOKEN, WRONG_TOKEN]) {
        expect(result.stderr).not.toContain(token);
      }
    }
    expect(cases[2][0].stderr).toContain("Authentication failed");

    agentSh("git checkout --quiet --detach");
    const detached = push(TOKEN);
    expect(detached.status).toBe(3);
    expect(detached.stdout).toBe("");
    expect(detached.stderr).toBe("the worktree on the VM has no branch checked out\nhunt-ctl: failed to push the branch from the VM\n");

    expect(originGit("rev-parse", "--verify", "--quiet", `refs/heads/${BRANCH}`).status).toBe(1);
    expect(filesHolding(TOKEN)).toBe("");
    expect(filesHolding(WRONG_TOKEN)).toBe("");
    expect(sh("find /var/tmp -mindepth 1").stdout).toBe("");
  }, DOCKER_TIMEOUT_MS);

  it("pushes the branch to its origin with the token from stdin and makes that its upstream", () => {
    agentSh("echo pushed >pushed.txt");
    expect(huntCtl("commit", ID, commitInput("Add a pushed file", ["pushed.txt"])).status).toBe(0);
    const head = agentGit("rev-parse", "HEAD");
    expect(docker(["exec", "-u", "agent", container, "git", "-C", WORKTREE, "config", `branch.${BRANCH}.remote`]).status).toBe(1);

    const result = push(TOKEN);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({});

    expect(originGit("rev-parse", `refs/heads/${BRANCH}`).stdout.trim()).toBe(head);
    expect(agentGit("config", `branch.${BRANCH}.remote`)).toBe("origin");
    expect(agentGit("config", `branch.${BRANCH}.merge`)).toBe(`refs/heads/${BRANCH}`);
    expect(agentGit("rev-parse", "@{upstream}")).toBe(head);

    expect(filesHolding(TOKEN)).toBe("");
    expect(sh("find /var/tmp -mindepth 1").stdout).toBe("");
    const withoutToken = docker(["exec", "-u", "agent", container, "git", "-C", WORKTREE, "ls-remote", "origin"]);
    expect(withoutToken.status).toBe(128);
    expect(withoutToken.stderr).toContain("Authentication failed");
  }, DOCKER_TIMEOUT_MS);

  // Last, so that a hunt-ctl that hangs here leaves no scratch folder in /var/tmp for the tests above.
  it("rejects a session that is not initialized or not prepared on the VM", () => {
    const meta = '{"repo": "acme/app", "worktree": "/home/agent/app", "createdAt": 1}';
    expect(sh('install -d -m 0700 "/srv/hunt/sessions/$1" && printf "%s\\n" "$2" >"/srv/hunt/sessions/$1/meta.json"', [UNPREPARED_ID, meta]).status).toBe(0);
    const sessions: [string, string][] = [
      [UNKNOWN_ID, `session ${UNKNOWN_ID} is not initialized on this VM; run hunt-ctl init first`],
      [UNPREPARED_ID, `meta.json of session ${UNPREPARED_ID} has no branch`],
    ];
    for (const [id, message] of sessions) {
      for (const [command, input] of [["commit", commitInput("Unprepared", ["README.md"])], ["push", `${TOKEN}\n`]] as const) {
        expect(huntCtl(command, id, input, [], QUICK_TIMEOUT_MS)).toEqual({ status: 3, stdout: "", stderr: `hunt-ctl: ${message}\n` });
      }
    }
  }, DOCKER_TIMEOUT_MS);
});
