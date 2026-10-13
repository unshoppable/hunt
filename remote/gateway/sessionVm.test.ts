import { describe, expect, it } from "vitest";
import { installScript, shellCommand, shellQuote, sshArgs } from "./sessionVm.ts";

describe("shell quoting", () => {
  it("quotes like shell_quote of the desktop", () => {
    expect(shellQuote("refs/hunt/abc")).toBe("refs/hunt/abc");
    expect(shellQuote("two words")).toBe("'two words'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote("")).toBe("''");
    expect(shellCommand("sudo", ["-n", "hunt-ctl", "clone", "id", "--branch", "hunt/12-fix login"])).toBe("sudo -n hunt-ctl clone id --branch 'hunt/12-fix login'");
  });
});

describe("sshArgs", () => {
  it("reaches the VM on its internal IP in the gateway's zone and project without prompts", () => {
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
      "--command",
      "true",
    ]);
  });
});

describe("installScript", () => {
  it("unpacks the bundle into a folder of its own, writes its hash and installs it with its own hunt-ctl, as bundle.rs does", () => {
    const incoming = "/srv/hunt/incoming/0000";
    expect(installScript("0123456789abcdef", incoming)).toBe(
      `set -e; mkdir -p ${incoming}; trap 'rm -rf ${incoming}' EXIT; tar -xzf - -C ${incoming}; printf %s 0123456789abcdef > ${incoming}/.hash; ` +
        `find ${incoming}/vm -maxdepth 1 -type f -name 'hunt-*' -exec chmod +x {} +; ${incoming}/vm/hunt-ctl install ${incoming}`,
    );
  });
});
