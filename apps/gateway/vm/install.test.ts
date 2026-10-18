/**
 * `hunt-ctl install --domain` and `stage-session` on a gateway in a Debian 12 container, the base of the VMs; skipped
 * without a Docker daemon. The container runs the built gateway artifact (`nx build gateway`) with openssh-server, sudo
 * and iptables, so that the sshd and sudo rules of the gateway API are checked by the real tools, and busybox, whose
 * syslogd stands in for the journal. A `curl` earlier on
 * PATH answers the metadata server from /srv/fakemeta; `systemctl` and `docker` only log, and `node` reports who runs
 * it (`fixtures/`).
 */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import protocolFile from "../../../libs/domain/protocol.json" with { type: "json" };

const ARTIFACT = fileURLToPath(new URL("../../../dist/apps/gateway", import.meta.url));
const FIXTURES = fileURLToPath(new URL("./fixtures", import.meta.url));
const FIREWALL_UNIT = fileURLToPath(new URL("./systemd/hunt-firewall.service", import.meta.url));
const DOCKER_TIMEOUT_MS = 600_000;

const DOCKERFILE = `FROM debian:12
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \\
      bash busybox ca-certificates iptables jq openssh-server sudo util-linux \\
    && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /etc/hunt && echo gateway >/etc/hunt/role
`;
const IMAGE = `hunt-ctl-test:${createHash("sha256").update(DOCKERFILE).digest("hex").slice(0, 12)}`;

function docker(args: string[], input?: string) {
  const result = spawnSync("docker", args, { input, encoding: "utf8", timeout: DOCKER_TIMEOUT_MS });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function hasDocker(): boolean {
  return spawnSync("docker", ["info"], { stdio: "ignore", timeout: 20_000 }).status === 0;
}

describe.skipIf(!hasDocker())("hunt-ctl install and stage-session on a gateway in a Debian container", () => {
  const container = `hunt-ctl-install-${randomUUID().slice(0, 8)}`;

  /** Runs `script` with bash in the container as root; `args` become $1… */
  function sh(script: string, args: string[] = []) {
    return docker(["exec", container, "bash", "-c", script, "bash", ...args]);
  }

  /** The folder of the CI release `version` of `role`. */
  function release(role: "gateway" | "session", version: string): string {
    const laidOut = sh('/fixtures/release.sh "$1" "$2"', [role, version]);
    expect(laidOut.stderr).toBe("");
    return laidOut.stdout.trim();
  }

  function hashOf(dir: string): string {
    return sh('cat "$1/.hash"', [dir]).stdout.trim();
  }

  /** Runs `command` as `user`. */
  function asUser(user: string, command: string[]) {
    return sh('user=$1; shift; runuser -u "$user" -- "$@"', [user, ...command]);
  }

  /** Runs `hunt-api` as `user` as sshd's ForceCommand does, with `forced` as SSH_ORIGINAL_COMMAND. */
  function forcedHuntApi(user: string, forced: string) {
    return asUser(user, ["env", `SSH_ORIGINAL_COMMAND=${forced}`, "/usr/local/bin/hunt-api"]);
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
      "--cap-add",
      "NET_ADMIN",
      "--name",
      container,
      "--volume",
      `${ARTIFACT}:/artifact:ro`,
      "--volume",
      `${FIXTURES}:/fixtures:ro`,
      IMAGE,
      "sleep",
      "infinity",
    ]);
    expect(started.stderr).toBe("");
    expect(sh("/fixtures/setup.sh").stderr).toBe("");
  }, DOCKER_TIMEOUT_MS);

  afterAll(() => {
    docker(["rm", "--force", container]);
  });

  it("installs a CI release with its preview domain, removes the update units and swf.json and starts the gateway's services", () => {
    sh("touch /etc/systemd/system/hunt-update.timer /etc/systemd/system/hunt-update.service /etc/hunt/swf.json");
    const dir = release("gateway", "gateway@1.0.0");
    const result = sh('/artifact/vm/hunt-ctl install "$1" --domain hunt.example.com', [dir]);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({ hash: hashOf(dir) });

    expect(sh("cat /srv/hunt/current/.version /etc/hunt/preview-domain").stdout).toBe("gateway@1.0.0\nhunt.example.com\n");
    expect(sh("test -e /etc/hunt/swf.json").status).toBe(1);
    expect(sh("readlink /usr/local/bin/hunt-ctl /usr/local/bin/hunt-api").stdout).toBe("/srv/hunt/current/vm/hunt-ctl\n/srv/hunt/current/vm/hunt-api\n");
    expect(sh("ls /etc/systemd/system").stdout.split("\n").filter((unit) => unit.startsWith("hunt-"))).toEqual([
      "hunt-api.service",
      "hunt-firewall.service",
      "hunt-swf.service",
      "hunt-wake.service",
    ]);
    const calls = sh("cat /var/log/fake.log").stdout;
    expect(calls).toContain("systemctl disable --quiet --now hunt-update.timer\n");
    expect(calls).toContain("systemctl enable --quiet hunt-swf.service hunt-api.service\n");
    expect(calls).toContain("systemctl reload-or-restart hunt-swf.service hunt-api.service\n");
    expect(calls).toContain("systemctl try-reload-or-restart ssh.service\n");
    expect(JSON.parse(sh("hunt-ctl version").stdout)).toEqual({ version: "gateway@1.0.0", hash: hashOf(dir), protocol: protocolFile.protocol });
    expect(sh("hunt-ctl update").status).toBe(2);
  });

  it("configures the edge with a server behind IAP that wakes VMs and an open one for services without IAP that does not", () => {
    interface Route {
      match?: { vars_regexp?: Record<string, { pattern: string }> }[];
      handle: unknown[];
    }
    interface Server {
      listen: string[];
      routes: Route[];
      errors: { routes: { handle: unknown[] }[] };
    }
    const servers: Record<string, Server> = JSON.parse(sh("cat /etc/hunt-edge/caddy.json").stdout).apps.http.servers;
    expect(Object.keys(servers)).toEqual(["edge", "open"]);
    const [edge, open] = [servers.edge, servers.open];
    expect(edge.listen).toEqual([":8080"]);
    expect(open.listen).toEqual([":8081"]);

    const sessionRoute = (server: Server) => server.routes.find((route) => route.match?.[0]?.vars_regexp)!;
    const hostPattern = (server: Server) => new RegExp(sessionRoute(server).match![0].vars_regexp!["{http.request.host}"].pattern);
    for (const [host, isGuarded, isOpen] of [
      ["7c0c6f2e.hunt.example.com", true, false],
      ["7c0c6f2e-4200.hunt.example.com", true, false],
      ["7c0c6f2e-3000-open.hunt.example.com", false, true],
      ["7c0c6f2e-open.hunt.example.com", false, false],
      ["7c0c6f2e-3000-open.hunt.example.org", false, false],
      ["7c0c6f2e-3000-open.x.hunt.example.com", false, false],
    ] as const) {
      expect(hostPattern(edge).test(host), host).toBe(isGuarded);
      expect(hostPattern(open).test(host), host).toBe(isOpen);
    }
    // The session VM in the first of the gateway region's zones of hunt-session-zones that resolves.
    expect(sh("cat /etc/hunt/session-zones").stdout).toBe("europe-west1-c\neurope-west1-b\neurope-west1-d\n");
    expect(sh("stat -c %a /etc/hunt/session-zones").stdout).toBe("644\n");
    const proxy = (sessionRoute(open).handle as Record<string, unknown>[])[0];
    expect(proxy.load_balancing).toEqual({ selection_policy: { policy: "first" } });
    expect(proxy.dynamic_upstreams).toEqual({
      source: "multi",
      sources: ["europe-west1-c", "europe-west1-b", "europe-west1-d"].map((zone) => ({
        source: "a",
        name: `vm-hunt-s-{http.regexp.session.1}.${zone}.c.medconomy-hunt.internal.`,
        port: "8080",
      })),
    });
    // Health check, the load balancer's ranges, the forward with IAP's headers and cookies removed, and 404 for the rest.
    expect(open.routes.map((route) => route.handle)).toEqual(edge.routes.map((route) => route.handle));

    expect(edge.errors.routes.map((route) => route.handle)).toEqual([[{ handler: "reverse_proxy", upstreams: [{ dial: "127.0.0.1:9180" }] }]]);
    expect(open.errors.routes.map((route) => route.handle)).toEqual([
      [{ handler: "static_response", status_code: 503, headers: { "Content-Type": ["text/plain; charset=utf-8"] }, body: "The preview is not running.\n" }],
    ]);
  });

  it("runs the gateway's services as the system user hunt-gw", () => {
    expect(sh("getent passwd hunt-gw | cut -d: -f6,7").stdout).toBe("/nonexistent:/usr/sbin/nologin\n");
    expect(Number(sh("id -u hunt-gw").stdout)).toBeLessThan(1000);
    for (const unit of ["hunt-api", "hunt-swf", "hunt-wake"]) {
      const text = sh('cat "/etc/systemd/system/$1.service"', [unit]).stdout;
      expect(text, unit).toContain("\nUser=hunt-gw\n");
      expect(text, unit).not.toContain("DynamicUser");
    }
  });

  it("forces hunt-api on users outside google-sudoers and lets it run only the forwarder as hunt-gw", () => {
    expect(sh("sshd -t").status).toBe(0);
    const alice = sh("sshd -T -C user=alice,host=client,addr=10.0.0.2").stdout;
    expect(alice).toContain("forcecommand /usr/local/bin/hunt-api\n");
    for (const setting of ["allowtcpforwarding no", "allowstreamlocalforwarding no", "permittty no", "x11forwarding no", "allowagentforwarding no", "permituserrc no"]) {
      expect(alice).toContain(`${setting}\n`);
    }
    const bob = sh("sshd -T -C user=bob,host=client,addr=10.0.0.3").stdout;
    expect(bob).toContain("forcecommand none\n");
    expect(bob).toContain("permittty yes\n");
    expect(bob).toMatch(/^subsystem sftp /m);

    expect(sh("visudo -c -q").status).toBe(0);
    expect(forcedHuntApi("alice", "hunt-api sessions.provision")).toMatchObject({
      status: 0,
      stdout: "hunt-gw alice /srv/hunt/current/gateway/apiClient.mjs sessions.provision\n",
    });
    expect(asUser("bob", ["/usr/local/bin/hunt-api", "hello"]).stdout).toBe("hunt-gw bob /srv/hunt/current/gateway/apiClient.mjs hello\n");
    for (const command of ["bash", "hunt-api", "hunt-api hello world", "hunt-api ../x", "hunt-api Hello", "hunt-api hello\nid"]) {
      const refused = forcedHuntApi("alice", command);
      expect(refused.status, command).toBe(1);
      expect(JSON.parse(refused.stdout), command).toMatchObject({ type: "error", code: "forbidden" });
    }
    expect(asUser("alice", ["/usr/local/bin/hunt-api"]).status).toBe(1);
    expect(asUser("alice", ["sudo", "-n", "-u", "hunt-gw", "/bin/true"]).status).not.toBe(0);
    expect(asUser("alice", ["sudo", "-n", "/opt/hunt/node/bin/node", "/srv/hunt/current/gateway/apiClient.mjs", "hello"]).status).not.toBe(0);
  });

  it("lets an admin outside google-sudoers keep the command it asked for, but no one else", () => {
    const deploy = 'sudo -n sh -c "echo deployed"';
    expect(forcedHuntApi("carol", deploy)).toMatchObject({ status: 0, stdout: "deployed\n" });
    expect(forcedHuntApi("carol", "echo '{}' | hunt-api hello").stdout).toBe("hunt-gw carol /srv/hunt/current/gateway/apiClient.mjs hello\n");
    const refused = forcedHuntApi("alice", deploy);
    expect(refused.status).toBe(1);
    expect(JSON.parse(refused.stdout)).toMatchObject({ type: "error", code: "forbidden" });
    expect(forcedHuntApi("alice", "hunt-api vms.get").stdout).toBe("hunt-gw alice /srv/hunt/current/gateway/apiClient.mjs vms.get\n");
    expect(forcedHuntApi("carol", "hunt-api vms.get").stdout).toBe("hunt-gw carol /srv/hunt/current/gateway/apiClient.mjs vms.get\n");
  });

  it("keeps everyone but root and hunt-gw off the metadata server, except DNS", () => {
    const commands = readFileSync(FIREWALL_UNIT, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("ExecStart="))
      .map((line) => line.slice("ExecStart=".length));
    for (let round = 0; round < 2; round++) {
      for (const command of commands) {
        const ran = sh(command.replace(/^-/, ""));
        expect(ran.status === 0 || command.startsWith("-"), `${command}: ${ran.stderr}`).toBe(true);
      }
    }
    const uid = sh("id -u hunt-gw").stdout.trim();
    expect(sh("iptables -S HUNT-METADATA").stdout).toBe(
      [
        "-N HUNT-METADATA",
        "-A HUNT-METADATA -m owner --uid-owner 0 -j RETURN",
        `-A HUNT-METADATA -m owner --uid-owner ${uid} -j RETURN`,
        "-A HUNT-METADATA -p udp -m udp --dport 53 -j RETURN",
        "-A HUNT-METADATA -p tcp -m tcp --dport 53 -j RETURN",
        "-A HUNT-METADATA -p udp -m udp --dport 123 -j RETURN",
        "-A HUNT-METADATA -p tcp -j REJECT --reject-with tcp-reset",
        "-A HUNT-METADATA -j REJECT --reject-with icmp-port-unreachable",
        "",
      ].join("\n"),
    );
    expect(sh("iptables -S OUTPUT | grep -c HUNT-METADATA").stdout).toBe("1\n");
  });

  it("keeps the stored preview domain on a later install and refuses an install without one", () => {
    const dir = release("gateway", "gateway@1.1.0");
    const result = sh('hunt-ctl install "$1"', [dir]);
    expect(result.stderr).toBe("");
    expect(sh("cat /srv/hunt/current/.version /etc/hunt/preview-domain").stdout).toBe("gateway@1.1.0\nhunt.example.com\n");

    const invalid = sh('hunt-ctl install "$1" --domain "Not A Domain"', [dir]);
    expect(invalid.status).toBe(3);
    expect(invalid.stderr).toContain("invalid or missing preview domain");
    const missing = sh('mv /etc/hunt/preview-domain /tmp/domain; hunt-ctl install "$1"; status=$?; mv /tmp/domain /etc/hunt/preview-domain; exit $status', [dir]);
    expect(missing.status).toBe(3);
    expect(missing.stderr).toContain("run hunt-ctl install <dir> --domain <domain>");
  });

  it("stages session releases for the session VMs, readable by hunt-gw, and keeps the current and the one before", () => {
    const releases = ["session@1.0.0", "session@1.1.0", "session@1.2.0"].map((version) => release("session", version));
    for (const [index, dir] of releases.entries()) {
      const staged = sh('hunt-ctl stage-session "$1"', [dir]);
      expect(staged.stderr).toBe("");
      expect(JSON.parse(staged.stdout)).toEqual({ version: `session@1.${index}.0`, hash: hashOf(dir) });
    }
    const [, previous, current] = releases.map(hashOf);
    expect(sh("readlink /srv/hunt/session-current").stdout).toBe(`/srv/hunt/session-releases/${current}\n`);
    expect(sh("ls /srv/hunt/session-releases").stdout).toBe([previous, current].sort().join("\n") + "\n");
    expect(sh("runuser -u hunt-gw -- tar -czf /dev/null -C /srv/hunt/session-current . && echo packed").stdout).toBe("packed\n");
  });

  it("refuses to stage what is no CI session release, and on a session VM", () => {
    const gatewayRelease = release("gateway", "gateway@9.0.0");
    expect(sh('hunt-ctl stage-session "$1"', [gatewayRelease]).stderr).toContain("is not a Hunt session release");
    const unversioned = release("session", "session@9.0.0");
    sh('rm "$1/.version"', [unversioned]);
    expect(sh('hunt-ctl stage-session "$1"', [unversioned]).stderr).toContain("is no CI release (it has no .version)");
    const onSessionVm = sh('echo session >/etc/hunt/role; hunt-ctl stage-session "$1"; status=$?; echo gateway >/etc/hunt/role; exit $status', [unversioned]);
    expect(onSessionVm.stderr).toContain("runs on the gateway only");
  });

  it("refuses a bundle that is no CI release, as older Hunt apps push", () => {
    const result = sh("rm -rf /tmp/old && cp -R /artifact /tmp/old && rm /tmp/old/.version && hunt-ctl install /tmp/old --domain hunt.example.com");
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("/tmp/old is no CI release (it has no .version); update Hunt");
    expect(sh("cat /srv/hunt/current/.version").stdout).toBe("gateway@1.1.0\n");
  });

  it("logs the steps of install and stage-session to syslog under the identifier hunt-ctl", () => {
    // busybox syslogd stands in for journald: it serves /dev/log and writes `<facility>.<priority> <tag>: <message>`.
    const syslogd = sh("busybox syslogd -O /var/log/messages && for _ in $(seq 50); do test -S /dev/log && exit 0; sleep 0.1; done; exit 1");
    expect(syslogd.status).toBe(0);
    try {
      const previous = sh("cat /srv/hunt/current/.hash").stdout.trim();
      const gateway = release("gateway", "gateway@2.0.0");
      expect(sh('hunt-ctl install "$1"', [gateway]).stderr).toBe("");
      const session = release("session", "session@2.0.0");
      expect(sh('hunt-ctl stage-session "$1"', [session]).stderr).toBe("");
      const lines = sh("sleep 0.5; grep -F ' hunt-ctl: ' /var/log/messages | sed 's/^.* \\([a-z]*\\.[a-z]*\\) hunt-ctl: /\\1 /'").stdout;
      expect(lines).toMatch(
        new RegExp(
          "^" +
            [
              "user\\.info install: started",
              `user\\.info install: installing gateway release ${hashOf(gateway)} \\(gateway@2\\.0\\.0\\)`,
              `user\\.info install: switched to release ${hashOf(gateway)} \\(previous: ${previous}\\); installing the units`,
              "user\\.info install: finished in \\d+ ms",
              "user\\.info stage-session: started",
              `user\\.info stage-session: staging session release ${hashOf(session)} \\(session@2\\.0\\.0\\)`,
              "user\\.info stage-session: finished in \\d+ ms",
              "",
            ].join("\n") +
            "$",
        ),
      );
    } finally {
      sh("kill $(cat /var/run/syslogd.pid); rm -f /dev/log");
    }
  });
});
