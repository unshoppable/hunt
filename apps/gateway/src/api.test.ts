import { mkdtempSync, rmSync } from "node:fs";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import protocolFile from "../../../libs/domain/protocol.json" with { type: "json" };
import type { ApiEvent } from "../../../libs/domain/src/gatewayApi.ts";
import type { Transport } from "./acpClient.ts";
import { createApiServer, type ApiServer } from "./api.ts";
import { forward } from "./apiClient.ts";
import { parseEvent } from "./apiProtocol.ts";
import { NO_SECRET_VERSION, type Compute, type Instance } from "./gcp.ts";
import { Orchestrator } from "./orchestrator.ts";
import { createRemoteSecretStore, type RemoteSecretStore } from "./remoteSecretStore.ts";
import type { SessionVm } from "./sessionVm.ts";

const ID = "ab12cd34-0000-4000-8000-000000000001";
const VM = "vm-hunt-s-ab12cd34";
const RELEASE = { version: "session@1.4.0", protocol: 1 };
const PROVISION = { id: ID, title: "Fix login", repo: "acme/app", branch: "feat/login" };

/** A Compute Engine whose new VMs run at once; it records every change. */
function fakeCompute() {
  const instances = new Map<string, Instance>();
  const calls: string[] = [];
  const copy = (name: string) => {
    const instance = instances.get(name);
    return instance ? structuredClone(instance) : null;
  };
  const operation = (zone: string) => ({ name: "operation-1", zone });
  const unexpected = async () => {
    throw new Error("unexpected call");
  };
  const compute: Compute = {
    list: async () => [...instances.values()].map((instance) => structuredClone(instance)),
    listByLabel: async () => [],
    locate: async (name) => copy(name),
    get: async (_zone, name) => copy(name),
    insert: async (zone, request) => {
      calls.push(`insert ${request.name} ${request.template} ${request.machineType} ${JSON.stringify(request.labels)}`);
      instances.set(request.name, {
        name: request.name,
        zone,
        status: "RUNNING",
        creationTimestamp: "2026-10-14T08:00:00.000-07:00",
        lastStopTimestamp: "",
        lastSuspendedTimestamp: "",
        labels: request.labels,
        metadata: { fingerprint: "fp0", items: [] },
        disks: [],
        machineType: request.machineType ?? "c4d-standard-8",
      });
      return operation(zone);
    },
    waitOperation: async () => ({ isDone: true, error: null }),
    setName: unexpected,
    getDisk: unexpected,
    createSnapshot: unexpected,
    deleteSnapshot: unexpected,
    setMetadata: async (_zone, name, _fingerprint, items) => {
      instances.get(name)!.metadata.items = items;
    },
    start: async (zone, name) => {
      calls.push(`start ${name}`);
      instances.get(name)!.status = "RUNNING";
      return operation(zone);
    },
    resume: async (zone) => operation(zone),
    suspend: async (zone) => operation(zone),
    stop: async (_zone, name) => {
      calls.push(`stop ${name}`);
    },
    setDiskAutoDelete: async () => {},
    delete: async (_zone, name) => {
      calls.push(`delete ${name}`);
      instances.delete(name);
    },
  };
  return { compute, calls, instances };
}

/** The remote secret store over an in-memory Secret Manager. */
function fakeSecrets(): RemoteSecretStore {
  let latest: string | null = null;
  return createRemoteSecretStore({
    read: async () => (latest === null ? { absent: NO_SECRET_VERSION } : { bytes: Buffer.from(latest) }),
    addVersion: async (_name, bytes) => {
      latest = bytes.toString("utf8");
      return "projects/1/secrets/HUNT_REMOTE_SECRETS/versions/1";
    },
    listVersions: async () => ["projects/1/secrets/HUNT_REMOTE_SECRETS/versions/1"],
    destroyVersion: async () => {},
    log: () => {},
  });
}

/** A session VM that boots and needs the staged release; `release` holds `ensureRelease` until it is opened. */
function fakeVm() {
  let open = () => {};
  let isOpen = Promise.resolve();
  const huntCtlCalls: string[] = [];
  const vm: SessionVm = {
    run: async () => "",
    huntCtl: async (args, input) => {
      huntCtlCalls.push(`${args.join(" ")} <<< ${String(input)}`);
      return {};
    },
    waitUntilReady: async (_timeoutMs, onWaiting) => {
      onWaiting?.();
      return "";
    },
    ensureRelease: async (_installedHash, onInstall) => {
      onInstall?.();
      await isOpen;
      return RELEASE;
    },
    putClaudeFiles: async () => {},
    idleDecision: async () => "keep: a turn is running",
    openRelay: () => ({}) as Transport,
  };
  return {
    vm,
    huntCtlCalls,
    hold: () => {
      isOpen = new Promise((resolve) => {
        open = resolve;
      });
    },
    release: () => open(),
  };
}

describe("the gateway API over its Unix socket", () => {
  let dir = "";
  let socketPath = "";
  let api: ApiServer;
  let compute: ReturnType<typeof fakeCompute>;
  let vm: ReturnType<typeof fakeVm>;
  let secrets: RemoteSecretStore;
  let logs: string[];

  beforeEach(async () => {
    // Unix socket paths are limited to 104 bytes on macOS, so a long TMPDIR is not used.
    dir = mkdtempSync(join(tmpdir().length > 60 ? "/tmp" : tmpdir(), "hunt-api-"));
    socketPath = join(dir, "api.sock");
    compute = fakeCompute();
    vm = fakeVm();
    secrets = fakeSecrets();
    logs = [];
    const location = { project: "medconomy-hunt", zone: "europe-west3-a" };
    api = createApiServer({
      orchestrator: new Orchestrator({
        compute: compute.compute,
        location,
        zones: () => [location.zone],
        vm: () => vm.vm,
        remoteSecrets: () => secrets.all(),
        sleep: async () => {},
        now: () => 0,
      }),
      secrets,
      gatewayInfo: async () => ({ release: "gateway@2.0.0", ...location, previewDomain: "hunt.example.com" }),
      log: (message) => logs.push(message),
    });
    await new Promise<void>((resolve) => api.server.listen(socketPath, resolve));
  });

  afterEach(async () => {
    await api.drain();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Calls `method` like `hunt-api <method>` with `params` on stdin; returns the exit status and the events. */
  async function call(method: string, params?: unknown, caller = "jane_doe_example_com", connectWaitMs = 0) {
    let output = "";
    const status = await forward({
      socketPath,
      caller,
      method,
      input: params === undefined ? "" : JSON.stringify(params),
      write: (text) => {
        output += text;
      },
      connectWaitMs,
    });
    const events = output.trimEnd().split("\n").map((line) => parseEvent(line));
    return { status, events: events as ApiEvent[], final: events.at(-1) as ApiEvent };
  }

  it("says hello with the protocol numbers, the gateway's location and the caller", async () => {
    expect(await call("hello")).toEqual({
      status: 0,
      events: [expect.anything()],
      final: {
        type: "result",
        data: {
          api: protocolFile.api,
          protocol: protocolFile.protocol,
          release: "gateway@2.0.0",
          project: "medconomy-hunt",
          zone: "europe-west3-a",
          previewDomain: "hunt.example.com",
          caller: "jane_doe_example_com",
        },
      },
    });
  });

  it("provisions a session VM for its caller from the template and streams the progress before the result", async () => {
    const { status, events } = await call("sessions.provision", { ...PROVISION, machineType: "c4d-highcpu-16" });
    expect(status).toBe(0);
    expect(events.filter((event) => event.type === "progress")).toEqual([
      { type: "progress", step: "creatingVm" },
      { type: "progress", step: "waitingForVm" },
      { type: "progress", step: "vmReady" },
      { type: "progress", step: "installingRuntime" },
    ]);
    expect(events.at(-1)).toEqual({
      type: "result",
      data: { vm: { project: "medconomy-hunt", zone: "europe-west3-a", instance: VM }, created: true, release: RELEASE },
    });
    const labels = '{"hunt-role":"session","hunt-session":"ab12cd34","hunt-origin":"desktop","hunt-owner":"jane_doe_example_com"}';
    expect(compute.calls[0]).toBe(`insert ${VM} tpl-hunt-session c4d-highcpu-16 ${labels}`);
    expect(logs.at(-1)).toMatch(new RegExp(`^jane_doe_example_com: sessions.provision ${ID}: ok in \\d+ ms$`));

    const listed = await call("sessions.list");
    expect(listed.final).toMatchObject({ type: "result", data: { sessions: [{ id: ID, vm: VM, owner: "jane_doe_example_com", repo: "acme/app" }] } });
  });

  it("stores remote secrets, lists them without values, puts them on the VMs it brings up and logs only their names", async () => {
    expect((await call("secrets.list")).final).toEqual({ type: "result", data: { secrets: [] } });
    expect((await call("secrets.set", { name: "MED_OPENAI_API_KEY", value: "sk-proj-abcdefgh1234" })).final).toEqual({ type: "result", data: {} });
    expect((await call("secrets.list")).final).toEqual({ type: "result", data: { secrets: [{ name: "MED_OPENAI_API_KEY", hint: "1234" }] } });

    await call("sessions.provision", PROVISION);
    expect(vm.huntCtlCalls).toEqual(['put-remote-secrets <<< {"MED_OPENAI_API_KEY":"sk-proj-abcdefgh1234"}']);
    expect((await call("secrets.delete", { name: "MED_OPENAI_API_KEY" })).final).toEqual({ type: "result", data: { existed: true } });
    expect((await call("secrets.delete", { name: "MED_OPENAI_API_KEY" })).final).toEqual({ type: "result", data: { existed: false } });

    expect((await call("secrets.set", { name: "lower", value: "sk-proj-x" })).final).toEqual({
      type: "error",
      code: "invalidParams",
      message: "the name must match ^[A-Z][A-Z0-9_]{0,63}$",
    });
    expect((await call("secrets.set", { name: "KEY", value: "sk-proj\nx" })).final).toEqual({
      type: "error",
      code: "invalidParams",
      message: "the value must be a single line",
    });
    expect(logs).toContainEqual(expect.stringMatching(/^jane_doe_example_com: secrets\.set MED_OPENAI_API_KEY: ok in \d+ ms$/));
    expect(logs.join("\n")).not.toContain("sk-proj");
  });

  it("reports missing VMs as the contract says: notFound for start, exists false for get, alreadyGone for delete", async () => {
    expect(await call("vms.start", { id: ID })).toMatchObject({
      status: 1,
      final: { type: "error", code: "notFound", message: `the session ${ID} has no VM ${VM}` },
    });
    expect((await call("vms.get", { id: ID })).final).toEqual({ type: "result", data: { exists: false, name: VM, status: null } });
    expect(await call("vms.delete", { id: ID })).toMatchObject({ status: 0, final: { type: "result", data: { alreadyGone: true } } });

    await call("sessions.provision", PROVISION);
    expect((await call("vms.stop", { id: ID })).final).toEqual({ type: "result", data: {} });
    expect((await call("vms.delete", { id: ID })).final).toEqual({ type: "result", data: { alreadyGone: false } });
    expect(compute.calls.slice(1)).toEqual([`stop ${VM}`, `delete ${VM}`]);
  });

  it("refuses invalid input before and after the socket", async () => {
    expect(await call("hello; id")).toMatchObject({ status: 1, final: { type: "error", code: "invalidParams" } });
    const notJson = await forward({ socketPath, caller: "jane", method: "hello", input: "{", write: () => {} });
    expect(notJson).toBe(1);
    expect((await call("vms.reboot")).final).toMatchObject({ type: "error", code: "invalidParams", message: expect.stringContaining("unknown method") });
    expect((await call("vms.start", { id: "nope" })).final).toEqual({ type: "error", code: "invalidParams", message: "id must be a session ID (a lowercase UUID)" });
    expect((await call("hello", undefined, "Not A User")).final).toMatchObject({ type: "error", code: "forbidden" });
  });

  it("lets concurrent starts of one session share one operation", async () => {
    await call("sessions.provision", PROVISION);
    compute.instances.get(VM)!.status = "TERMINATED";
    vm.hold();
    const first = call("vms.start", { id: ID });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = call("vms.start", { id: ID });
    await new Promise((resolve) => setTimeout(resolve, 20));
    vm.release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.final).toEqual(b.final);
    expect(a.final).toMatchObject({ type: "result", data: { wasRunning: false } });
    expect(b.events.filter((event) => event.type === "progress").map((event) => (event as { step: string }).step)).toEqual([
      "startingVm",
      "waitingForVm",
      "vmReady",
      "installingRuntime",
    ]);
    expect(compute.calls.filter((entry) => entry.startsWith("start"))).toEqual([`start ${VM}`]);
  });

  it("serves a client that ends its side after the request, and refuses a request without a caller", async () => {
    const ask = (request: string, end: boolean) =>
      new Promise<string>((resolve) => {
        const socket = connect(socketPath);
        let answer = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => {
          answer += chunk;
        });
        socket.on("close", () => resolve(answer));
        socket.write(request);
        if (end) {
          socket.end();
        }
      });
    expect(parseEvent(await ask('{"caller":"jane","method":"vms.get","params":{"id":"' + ID + '"}}\n', true))).toMatchObject({ type: "result" });
    expect(parseEvent(await ask('{"method":"hello"}', true))).toEqual({ type: "error", code: "forbidden", message: "the request names no valid caller" });
  });

  it("finishes the running requests on drain and accepts no new ones", async () => {
    vm.hold();
    const running = call("sessions.provision", PROVISION);
    await new Promise((resolve) => setTimeout(resolve, 20));
    let isDrained = false;
    const drained = api.drain().then(() => {
      isDrained = true;
    });
    expect((await call("hello")).final).toMatchObject({ type: "error", code: "unavailable" });
    expect(isDrained).toBe(false);
    vm.release();
    expect((await running).status).toBe(0);
    await drained;
    expect(isDrained).toBe(true);
  });
});

describe("forward", () => {
  it("reports an API that cannot be reached or that ends the connection before its result", async () => {
    const dir = mkdtempSync(join(tmpdir().length > 60 ? "/tmp" : tmpdir(), "hunt-api-"));
    try {
      const socketPath = join(dir, "api.sock");
      let output = "";
      const write = (text: string) => {
        output += text;
      };
      expect(await forward({ socketPath, caller: "jane", method: "hello", input: "", write, connectWaitMs: 600 })).toBe(1);
      expect(parseEvent(output.trim())).toMatchObject({ type: "error", code: "unavailable", message: expect.stringContaining("failed to reach the gateway API") });

      const server = createServer((socket) => {
        socket.resume();
        socket.end('{"type":"progress","step":"startingVm"}\n');
      });
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      output = "";
      expect(await forward({ socketPath, caller: "jane", method: "vms.start", input: `{"id":"${ID}"}`, write })).toBe(1);
      expect(output.trim().split("\n").map((line) => parseEvent(line))).toEqual([
        { type: "progress", step: "startingVm" },
        { type: "error", code: "unavailable", message: "the gateway API ended the connection before its result" },
      ]);
      await new Promise((resolve) => server.close(resolve));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
