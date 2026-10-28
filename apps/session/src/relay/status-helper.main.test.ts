import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { writeJsonAtomic } from "./json-file.utils.ts";
import { AnnotationSpool } from "../review/annotation-spool.service.ts";
import type { BrowserAnnotation } from "../../../../libs/domain/src/review/browser-annotation.utils.ts";
import { createLineDecoder, parseLine } from "../../../../libs/domain/src/shared/ndjson.utils.ts";

const HELPER = fileURLToPath(new URL("./status-helper.main.ts", import.meta.url));
/** Longer than one poll of the helper. */
const WAIT_MS = 3_000;

type Message = Record<string, unknown>;

interface HelperProcess {
  child: ChildProcessWithoutNullStreams;
  /** Resolves with the next message the helper sent. */
  next(): Promise<Message>;
  exited: Promise<number | null>;
}

function startHelper(statusPath: string, spoolDir = join(statusPath, "..", "annotations")): HelperProcess {
  const child = spawn(process.execPath, [HELPER, statusPath, spoolDir]);
  const received: Message[] = [];
  let onMessage = () => {};
  const lines = createLineDecoder((line) => {
    received.push(parseLine(line) as Message);
    onMessage();
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => lines.push(chunk));
  let output = "";
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  return {
    child,
    next: () =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out; helper output:\n${output}`)), WAIT_MS);
        onMessage = () => {
          const message = received.shift();
          if (!message) return;
          clearTimeout(timer);
          onMessage = () => {};
          resolve(message);
        };
        onMessage();
      }),
    exited: new Promise((resolve) => child.once("exit", (code) => resolve(code))),
  };
}

function writeStatus(path: string, changes: Message): void {
  const status = { heartbeatAt: Date.now(), state: "ready", error: null, acpSessionId: "acp-1", turn: "idle", clientConnected: true };
  writeJsonAtomic(path, { ...status, lastClientActivityAt: null, lastTurnEndedAt: 1_000, pendingPermissionSince: null, question: true, ...changes });
}

describe("statusHelper", () => {
  let helper: HelperProcess | null = null;
  let dir = "";

  afterEach(() => {
    helper?.child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports the relay's status when it changes, no turn once the file is gone, and exits when stdin ends", async () => {
    dir = mkdtempSync(join(tmpdir(), "hunt-status-"));
    const statusPath = join(dir, "status.json");
    writeStatus(statusPath, {});
    helper = startHelper(statusPath);

    expect(await helper.next()).toEqual({ t: "ready" });
    expect(await helper.next()).toEqual({ t: "status", turn: "idle", question: true, lastTurnEndedAt: 1_000 });

    // A change the report does not show sends nothing.
    writeStatus(statusPath, { clientConnected: false });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    writeStatus(statusPath, { turn: "running", question: false });
    expect(await helper.next()).toEqual({ t: "status", turn: "running", question: false, lastTurnEndedAt: 1_000 });

    rmSync(statusPath);
    expect(await helper.next()).toEqual({ t: "status", turn: null, question: null, lastTurnEndedAt: null });

    helper.child.stdin.end();
    expect(await helper.exited).toBe(0);
  }, 15_000);

  it("sends every annotation of the spool folder once, in the order of arrival, and deletes it", async () => {
    dir = mkdtempSync(join(tmpdir(), "hunt-status-"));
    const statusPath = join(dir, "status.json");
    const spoolDir = join(dir, "annotations");
    writeStatus(statusPath, {});
    const spool = new AnnotationSpool(spoolDir);
    spool.create();
    const annotation: BrowserAnnotation = {
      url: "https://7c0c6f2e-4200.hunt.example.com/",
      title: "Orders",
      selector: "#save",
      text: "Save",
      outerHtml: '<button id="save">Save</button>',
      rect: { x: 1, y: 2, width: 3, height: 4 },
      viewport: { width: 1280, height: 800 },
      styles: {},
      comment: "Make it blue",
    };
    const first = spool.store(annotation, 1_700_000_000_000);
    const second = spool.store({ ...annotation, comment: "And bigger" }, 1_700_000_000_001);
    writeFileSync(join(spoolDir, "1700000000002-00000000-0000-4000-8000-000000000000.json"), "{}");
    helper = startHelper(statusPath, spoolDir);

    expect(await helper.next()).toEqual({ t: "ready" });
    expect(await helper.next()).toEqual({ t: "status", turn: "idle", question: true, lastTurnEndedAt: 1_000 });
    expect(await helper.next()).toEqual({ t: "annotation", annotation: first });
    expect(await helper.next()).toEqual({ t: "annotation", annotation: second });
    expect(readdirSync(spoolDir)).toEqual([]);

    const third = spool.store({ ...annotation, comment: "Later" });
    expect(await helper.next()).toEqual({ t: "annotation", annotation: third });
    expect(readdirSync(spoolDir)).toEqual([]);
  }, 15_000);
});
