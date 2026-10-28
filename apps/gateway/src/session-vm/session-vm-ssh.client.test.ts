import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installScript, parseDryRun, parseReadyAnswer, READY_COMMAND, readStagedRelease, shellCommand, shellQuote, sshArgs } from "./session-vm-ssh.client.ts";

describe("shell quoting", () => {
  it("quotes like shell_quote of the desktop", () => {
    expect(shellQuote("refs/hunt/abc")).toBe("refs/hunt/abc");
    expect(shellQuote("two words")).toBe("'two words'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote("")).toBe("''");
    expect(shellCommand("sudo", ["-n", "hunt-ctl", "clone", "id", "--branch", "fix/general/12-fix login"])).toBe("sudo -n hunt-ctl clone id --branch 'fix/general/12-fix login'");
  });
});

describe("sshArgs", () => {
  it("reaches the VM on its internal IP in the gateway's zone and project without prompts, over one shared connection", () => {
    vi.stubEnv("HOME", "/var/lib/hunt-api");
    expect(sshArgs("vm-hunt-s-ab12cd34", { project: "medconomy-hunt", zone: "europe-west3-a" }, "true")).toEqual([
      "compute",
      "ssh",
      "vm-hunt-s-ab12cd34",
      "--internal-ip",
      "--zone=europe-west3-a",
      "--project=medconomy-hunt",
      "--quiet",
      "--ssh-flag=-oServerAliveInterval=30",
      "--ssh-flag=-oConnectTimeout=20",
      "--ssh-flag=-oControlMaster=auto",
      "--ssh-flag=-oControlPath=/var/lib/hunt-api/.ssh/hunt-%C",
      "--ssh-flag=-oControlPersist=60",
      "--command",
      "true",
    ]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });
});

describe("parseDryRun", () => {
  it("takes the ssh command line gcloud prints without its remote command", () => {
    const output =
      "/usr/bin/ssh -T -i /var/lib/hunt-api/.ssh/google_compute_engine -o HostKeyAlias=compute.3783771989286237897 -o StrictHostKeyChecking=no " +
      "-oControlPath=/var/lib/hunt-api/.ssh/hunt-%C sa_110904933408497884651@10.30.16.59 -- true\n";
    expect(parseDryRun(output)).toEqual([
      "/usr/bin/ssh",
      "-T",
      "-i",
      "/var/lib/hunt-api/.ssh/google_compute_engine",
      "-o",
      "HostKeyAlias=compute.3783771989286237897",
      "-o",
      "StrictHostKeyChecking=no",
      "-oControlPath=/var/lib/hunt-api/.ssh/hunt-%C",
      "sa_110904933408497884651@10.30.16.59",
      "--",
    ]);
  });

  it("rejects output that is no ssh command for true or would need quoting", () => {
    expect(parseDryRun("")).toBeNull();
    expect(parseDryRun("/usr/bin/ssh -T sa@10.0.0.1 -- uptime")).toBeNull();
    expect(parseDryRun("/usr/bin/scp -T sa@10.0.0.1 -- true")).toBeNull();
    expect(parseDryRun("/usr/bin/ssh -i '/home/a b/key' sa@10.0.0.1 -- true")).toBeNull();
  });
});

describe("the ready check", () => {
  it("asks for the stamp and the installed hash in one command and reads both from the answer", () => {
    expect(READY_COMMAND).toBe(
      'test -e /var/lib/hunt/session-ready && { echo ready; echo "$(cat /var/lib/hunt/installed-hash 2>/dev/null)"; sudo -n hunt-ctl put-remote-secrets >/dev/null 2>&1 && echo secrets; } || true',
    );
    expect(parseReadyAnswer("")).toBeNull();
    expect(parseReadyAnswer("\n")).toBeNull();
    expect(parseReadyAnswer("ready\n")).toEqual({ installedHash: "", hasSecrets: false });
    expect(parseReadyAnswer("ready\n\nsecrets\n")).toEqual({ installedHash: "", hasSecrets: true });
    expect(parseReadyAnswer("ready\n0123456789abcdef\n")).toEqual({ installedHash: "0123456789abcdef", hasSecrets: false });
    expect(parseReadyAnswer("ready\n0123456789abcdef\nsecrets\n")).toEqual({ installedHash: "0123456789abcdef", hasSecrets: true });
  });
});

describe("installScript", () => {
  it("unpacks the release into a folder of its own, writes its hash and installs it with its own hunt-ctl", () => {
    const incoming = "/srv/hunt/incoming/0000";
    expect(installScript("0123456789abcdef", incoming)).toBe(
      `set -e; mkdir -p -m 0700 ${incoming}; trap 'rm -rf ${incoming}' EXIT; tar -xzf - -C ${incoming}; printf %s 0123456789abcdef > ${incoming}/.hash; ` +
        `find ${incoming}/vm -maxdepth 1 -type f -name 'hunt-*' -exec chmod +x {} +; ${incoming}/vm/hunt-ctl install ${incoming}`,
    );
  });
});

describe("readStagedRelease", () => {
  it("reads hash, version and protocol through the link and refuses a missing or broken release", () => {
    const root = mkdtempSync(join(tmpdir(), "hunt-staged-"));
    try {
      const link = join(root, "session-current");
      expect(() => readStagedRelease(link)).toThrow(`no session release is staged on the gateway (${link} is missing)`);
      const release = join(root, "0123456789abcdef");
      mkdirSync(release);
      symlinkSync(release, link);
      expect(() => readStagedRelease(link)).toThrow("has no valid .hash");
      writeFileSync(join(release, ".hash"), "0123456789abcdef\n");
      writeFileSync(join(release, ".version"), "session@1.4.0\n");
      writeFileSync(join(release, "protocol.json"), '{"protocol": 1}');
      expect(readStagedRelease(link)).toMatchObject({ hash: "0123456789abcdef", info: { version: "session@1.4.0", protocol: 1 } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
