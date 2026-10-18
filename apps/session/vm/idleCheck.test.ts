import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./hunt-idle-check", import.meta.url));
const NOW_MS = 1_800_000_000_000;
const MINUTE_MS = 60_000;

/**
 * Commands the script runs that read the machine, replaced by scripts that read the fixture: `date` prints NOW_MS,
 * `stat -c %Y` reads the real mtime on GNU and BSD alike, `w` prints the fixture's logins, `pgrep` reports the
 * fixture's hunt-ctl and `systemctl` records its arguments.
 */
const SHIMS: Record<string, string> = {
  date: `#!/bin/sh\necho ${NOW_MS}\n`,
  stat: `#!/bin/sh\nexec "${process.execPath}" -e 'process.stdout.write(Math.floor(require("fs").statSync(process.argv[1]).mtimeMs / 1000) + "\\n")' "$3"\n`,
  w: '#!/bin/sh\nif [ -f "$HUNT_TEST_DIR/w.txt" ]; then cat "$HUNT_TEST_DIR/w.txt"; fi\n',
  pgrep: '#!/bin/sh\n[ -f "$HUNT_TEST_DIR/hunt-ctl-running" ]\n',
  systemctl: '#!/bin/sh\necho "$*" >>"$HUNT_TEST_DIR/systemctl.log"\n',
};

/** A relay's status.json; times given as minutes before now. */
type RelayStatus = { heartbeat?: number; turn?: "running" | "idle"; turnEnded?: number; clientActivity?: number; permission?: number };

interface Fixture {
  uptimeMinutes?: number;
  config?: string;
  /** Minutes since hunt-ctl last ran; no activity file without it. */
  huntCtlMinutesAgo?: number;
  isHuntCtlRunning?: boolean;
  /** The relay's status.json. */
  status?: RelayStatus;
  /** Access log lines: minutes before now, method and Sec-Fetch-Mode. */
  requests?: { minutesAgo: number; method: string; mode?: string }[];
  /** The `w` output after its header. */
  logins?: string[];
}

describe("hunt-idle-check", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function ago(minutes: number | undefined): number | null {
    return minutes === undefined ? null : NOW_MS - minutes * MINUTE_MS;
  }

  function writeStatus(file: string, { heartbeat = 0, turn = "idle", turnEnded, clientActivity, permission }: RelayStatus) {
    const status = {
      heartbeatAt: ago(heartbeat),
      state: "ready",
      turn,
      lastTurnEndedAt: ago(turnEnded),
      lastClientActivityAt: ago(clientActivity),
      pendingPermissionSince: ago(permission),
    };
    writeFileSync(file, JSON.stringify(status));
  }

  function run(fixture: Fixture, args = ["--dry-run"]) {
    const dir = mkdtempSync(join(tmpdir(), "hunt-idle-"));
    dirs.push(dir);
    for (const [name, text] of Object.entries(SHIMS)) {
      writeFileSync(join(dir, name), text);
      chmodSync(join(dir, name), 0o755);
    }
    writeFileSync(join(dir, "uptime"), `${(fixture.uptimeMinutes ?? 600) * 60}.42 1234.56\n`);
    if (fixture.config !== undefined) {
      writeFileSync(join(dir, "idle.conf"), fixture.config);
    }
    if (fixture.huntCtlMinutesAgo !== undefined) {
      writeFileSync(join(dir, "activity"), "");
      const time = (NOW_MS - fixture.huntCtlMinutesAgo * MINUTE_MS) / 1000;
      utimesSync(join(dir, "activity"), time, time);
    }
    if (fixture.isHuntCtlRunning) {
      writeFileSync(join(dir, "hunt-ctl-running"), "");
    }
    if (fixture.status) {
      writeStatus(join(dir, "status.json"), fixture.status);
    }
    const lines = (fixture.requests ?? []).map(({ minutesAgo, method, mode }) =>
      JSON.stringify({ ts: (NOW_MS - minutesAgo * MINUTE_MS) / 1000, request: { method, headers: mode ? { "Sec-Fetch-Mode": [mode] } : {} } }),
    );
    writeFileSync(join(dir, "access.log"), ["not json", ...lines].join("\n") + "\n");
    if (fixture.logins) {
      writeFileSync(join(dir, "w.txt"), ["USER     TTY      FROM             LOGIN@   IDLE   JCPU   PCPU WHAT", ...fixture.logins].join("\n") + "\n");
    }
    const env = {
      ...process.env,
      PATH: `${dir}${delimiter}${process.env.PATH ?? ""}`,
      HUNT_TEST_DIR: dir,
      HUNT_IDLE_CONFIG: join(dir, "idle.conf"),
      HUNT_IDLE_STATUS_FILE: join(dir, "status.json"),
      HUNT_IDLE_ACTIVITY_FILE: join(dir, "activity"),
      HUNT_IDLE_UPTIME_FILE: join(dir, "uptime"),
      HUNT_IDLE_PROXY_LOG: join(dir, "access.log"),
    };
    const result = spawnSync("bash", [SCRIPT, ...args], { env, encoding: "utf8" });
    let systemctl = "";
    try {
      systemctl = readFileSync(join(dir, "systemctl.log"), "utf8");
    } catch {
      systemctl = "";
    }
    return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr, systemctl };
  }

  function decision(fixture: Fixture): string {
    const result = run(fixture);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    return result.stdout;
  }

  const POWEROFF = "poweroff: no turn, client, permission request, preview page view, login or hunt-ctl activity for 30 min";

  it("keeps a VM up within the boot grace period", () => {
    expect(decision({ uptimeMinutes: 10 })).toBe("keep: booted 10 min ago, within the grace period of 15 min");
  });

  it("powers an idle VM off", () => {
    expect(decision({})).toBe(POWEROFF);
  });

  it("keeps the VM up while hunt-ctl runs or ran within the idle time", () => {
    expect(decision({ huntCtlMinutesAgo: 12 })).toBe("keep: hunt-ctl ran 12 min ago");
    expect(decision({ huntCtlMinutesAgo: 31 })).toBe(POWEROFF);
    expect(decision({ isHuntCtlRunning: true })).toBe("keep: hunt-ctl is running");
  });

  it("keeps the VM up for the relay's turns, clients and permission requests, unless its heartbeat is stale", () => {
    expect(decision({ status: { turn: "running" } })).toBe("keep: a turn is running");
    expect(decision({ status: { turnEnded: 29 } })).toBe("keep: a turn ended within 30 min");
    expect(decision({ status: { clientActivity: 5, turnEnded: 40 } })).toBe("keep: a client sent something within 30 min");
    expect(decision({ status: { permission: 20 } })).toBe("keep: a permission request arrived within 30 min");
    expect(decision({ status: { permission: 31, turnEnded: 45 } })).toBe(POWEROFF);
    expect(decision({ status: { heartbeat: 3, turn: "running" } })).toBe(POWEROFF);
  });

  it("counts preview page loads and other than GET requests only while the agent was active within two hours", () => {
    const active = { turnEnded: 90 };
    expect(decision({ status: active, requests: [{ minutesAgo: 4, method: "GET", mode: "navigate" }] })).toBe("keep: a preview page was used 4 min ago");
    expect(decision({ status: active, requests: [{ minutesAgo: 10, method: "POST", mode: "cors" }] })).toBe("keep: a preview page was used 10 min ago");
    expect(decision({ status: active, requests: [{ minutesAgo: 2, method: "GET", mode: "cors" }, { minutesAgo: 1, method: "HEAD" }] })).toBe(POWEROFF);
    expect(decision({ status: active, requests: [{ minutesAgo: 35, method: "GET", mode: "navigate" }] })).toBe(POWEROFF);
    expect(decision({ status: { turnEnded: 121 }, requests: [{ minutesAgo: 1, method: "GET", mode: "navigate" }] })).toBe(POWEROFF);
    expect(decision({ requests: [{ minutesAgo: 1, method: "GET", mode: "navigate" }] })).toBe(POWEROFF);
  });

  it("keeps the VM up while an interactive login had input within the idle time", () => {
    const login = (idle: string) => `agent    pts/0    35.235.240.1     10:00   ${idle}  0.10s  0.01s tmux`;
    expect(decision({ logins: [login("3days"), login("4:05")] })).toBe("keep: an interactive login had input 4 min ago");
    expect(decision({ logins: [login("12.00s")] })).toBe("keep: an interactive login had input 0 min ago");
    expect(decision({ logins: [login("1:05m")] })).toBe(POWEROFF);
  });

  it("reads its times from idle.conf and ignores malformed lines", () => {
    const config = "# times\nIDLE_MINUTES = 60\nBOOT_GRACE_MINUTES=abc\nPREVIEW_MAX_MINUTES='30'\nOTHER=1";
    expect(decision({ config, status: { turnEnded: 45 } })).toBe("keep: a turn ended within 60 min");
    expect(decision({ config, uptimeMinutes: 14 })).toBe("keep: booted 14 min ago, within the grace period of 15 min");
    expect(decision({ config, status: { turnEnded: 61 }, requests: [{ minutesAgo: 1, method: "GET", mode: "navigate" }] })).toBe(
      "poweroff: no turn, client, permission request, preview page view, login or hunt-ctl activity for 60 min",
    );
  });

  it("powers off through systemctl only without --dry-run and refuses other arguments", () => {
    expect(run({}, [])).toMatchObject({ status: 0, stdout: `${POWEROFF.slice("poweroff: ".length)}; powering off`, systemctl: "poweroff\n" });
    expect(run({ status: { turn: "running" } }, [])).toMatchObject({ status: 0, stdout: "", systemctl: "" });
    expect(run({}, ["--now"])).toMatchObject({ status: 2, stderr: "usage: hunt-idle-check [--dry-run]\n", systemctl: "" });
  });
});
