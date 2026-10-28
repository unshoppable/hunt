import { describe, expect, it } from "vitest";
import { ServiceConfig } from "./service-config.value-object.ts";
import { SessionHost } from "./session-host.value-object.ts";

const HOST = new SessionHost({ short: "7c0c6f2e", domain: "hunt.example.com" });

describe("ServiceConfig", () => {
  it("defaults to the worktree, plain HTTP behind IAP with the review widget, and no variables or ignored files", () => {
    expect(new ServiceConfig({ name: "web", command: "npm start", port: 3000 }).toJSON()).toEqual({
      name: "web",
      command: "npm start",
      cwd: null,
      port: 3000,
      tls: false,
      guarded: true,
      review: true,
      env: {},
      remoteSecrets: {},
      worktreeInclude: [],
    });
  });

  it("answers at its port host when guarded and at its open host otherwise", () => {
    expect(new ServiceConfig({ name: "ui", command: "npm start", port: 4200 }).publicUrl(HOST)).toBe("https://7c0c6f2e-4200.hunt.example.com");
    expect(new ServiceConfig({ name: "api", command: "npm start", port: 3000, guarded: false }).publicUrl(HOST)).toBe("https://7c0c6f2e-3000-open.hunt.example.com");
  });

  it("names the services its variables refer to and resolves their URLs, leaving every other placeholder", () => {
    const service = new ServiceConfig({
      name: "web",
      command: "npm start",
      port: 3000,
      env: { BOTH: "${services.ui.publicUrl};${services.api.publicUrl}", UI: "${services.ui.publicUrl}/app", HOME_DIR: "${HOME}", PLAIN: "x" },
    });

    expect(service.referencedServices).toEqual(["ui", "api"]);
    expect(service.resolveEnv(new Map([["ui", "https://ui.example"]]))).toEqual({
      BOTH: "https://ui.example;${services.api.publicUrl}",
      UI: "https://ui.example/app",
      HOME_DIR: "${HOME}",
      PLAIN: "x",
    });
  });

  it("rejects placeholders of contract 2, malformed service placeholders and a variable in both env and remoteSecrets", () => {
    const base = { name: "web", command: "npm start", port: 3000 };
    expect(() => new ServiceConfig({ ...base, env: { A: "${HUNT_PREVIEW_URL}" } })).toThrow(/no placeholder of contract 2/);
    expect(() => new ServiceConfig({ ...base, env: { A: "${services.ui.url}" } })).toThrow(/no placeholder of contract 2/);
    expect(() => new ServiceConfig({ ...base, env: { A: "x" }, remoteSecrets: { A: "KEY" } })).toThrow(/not in both/);
    expect(() => new ServiceConfig({ ...base, port: 8080 })).toThrow(/reserved for the session VM's preview proxy/);
    expect(() => new ServiceConfig({ ...base, remoteSecrets: { A: "$KEY" } })).toThrow(/name of a remote secret/);
  });
});
