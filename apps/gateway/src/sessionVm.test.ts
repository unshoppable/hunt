import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installScript, readStagedRelease, shellCommand, shellQuote, sshArgs } from "./sessionVm.ts";

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
      "--ssh-flag=-oControlPath=~/.ssh/hunt-%C",
      "--ssh-flag=-oControlPersist=60",
      "--command",
      "true",
    ]);
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
