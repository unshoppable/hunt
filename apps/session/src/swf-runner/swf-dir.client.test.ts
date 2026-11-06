import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { started } from "../../../../libs/domain/src/swf/swf.fixtures.ts";
import { answersMessage, pipelineMessage } from "../../../../libs/domain/src/swf/swf-inbox.utils.ts";
import { SwfDir } from "./swf-dir.client.ts";

const NOW = Date.parse("2026-10-25T10:00:00Z");

describe("SwfDir", () => {
  const dirs: string[] = [];

  function swfDir(): SwfDir {
    const dir = mkdtempSync(join(tmpdir(), "hunt-swf-"));
    dirs.push(dir);
    return new SwfDir(join(dir, ".hunt", "swf"), join(dir, "claude", "projects", "-home-agent-app"));
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("has no pipeline, result or inbox before anything was written", () => {
    const files = swfDir();
    expect(files.readPipeline()).toBeNull();
    expect(files.readResult()).toBeNull();
    expect(files.readInbox()).toEqual([]);
  });

  it("writes the pipeline as indented JSON, creating the folder, and reads it back; an unusable file reads as none", () => {
    const files = swfDir();
    const pipeline = started(NOW);
    files.writePipeline(pipeline);
    expect(readFileSync(join(files.dir, "pipeline.json"), "utf8")).toBe(`${JSON.stringify(pipeline.toJSON(), null, 2)}\n`);
    expect(files.readPipeline()?.toJSON()).toEqual(pipeline.toJSON());
    writeFileSync(join(files.dir, "pipeline.json"), "{");
    expect(files.readPipeline()).toBeNull();
    writeFileSync(join(files.dir, "pipeline.json"), JSON.stringify({ step: "nowhere" }));
    expect(files.readPipeline()).toBeNull();
  });

  it("keeps the result as the ended run's step file and discards one that is unusable", () => {
    const files = swfDir();
    mkdirSync(files.dir, { recursive: true });
    writeFileSync(join(files.dir, "result.md"), "## Plan\n<!-- hunt:step {\"step\":\"plan\"} -->\n");
    expect(files.readResult()).toBe("## Plan\n<!-- hunt:step {\"step\":\"plan\"} -->\n");
    files.keepResult({ n: 1, step: "plan", startedAt: "2026-10-25T10:00:00.000Z", endedAt: "2026-10-25T10:05:00.000Z", outcome: "passed" });
    expect(files.readResult()).toBeNull();
    expect(readFileSync(join(files.dir, "steps", "01-plan.md"), "utf8")).toBe("## Plan\n<!-- hunt:step {\"step\":\"plan\"} -->\n");

    writeFileSync(join(files.dir, "result.md"), "garbage");
    files.discardResult();
    expect(existsSync(join(files.dir, "result.md"))).toBe(false);
    files.discardResult();
  });

  it("keeps the output of each gate check under the run's number, replacing that of an earlier gate run", () => {
    const files = swfDir();
    const run = { n: 2, step: "implement" as const, startedAt: "2026-10-25T10:00:00.000Z", endedAt: null, outcome: "running" as const };
    files.keepGateLog(run, "lint", "first");
    files.keepGateLog(run, "lint", "error: unused import\n");
    files.keepGateLog(run, "test", "");
    expect(readFileSync(join(files.dir, "gate", "02-lint.log"), "utf8")).toBe("error: unused import\n");
    expect(readFileSync(join(files.dir, "gate", "02-test.log"), "utf8")).toBe("");
  });

  it("copies the transcript of a run's conversation under the run's number whenever it grew, and nothing without one", () => {
    const files = swfDir();
    const run = { n: 3, step: "verify" as const, startedAt: "2026-10-25T10:00:00.000Z", endedAt: null, outcome: "running" as const };
    const target = join(files.dir, "transcripts", "03-verify.jsonl");
    files.keepTranscript(run);
    files.keepTranscript({ ...run, sessionId: "acp-1" });
    mkdirSync(files.projectDir, { recursive: true });
    writeFileSync(join(files.projectDir, "..", "acp-1.jsonl"), "outside\n");
    files.keepTranscript({ ...run, sessionId: "../acp-1" });
    expect(existsSync(join(files.dir, "transcripts"))).toBe(false);

    writeFileSync(join(files.projectDir, "acp-1.jsonl"), '{"type":"user"}\n');
    files.keepTranscript({ ...run, sessionId: "acp-1" });
    expect(readFileSync(target, "utf8")).toBe('{"type":"user"}\n');
    writeFileSync(join(files.projectDir, "acp-1.jsonl"), '{"type":"user"}\n{"type":"assistant"}\n');
    files.keepTranscript({ ...run, sessionId: "acp-1" });
    expect(readFileSync(target, "utf8")).toBe('{"type":"user"}\n{"type":"assistant"}\n');
    expect(existsSync(`${target}.tmp`)).toBe(false);
  });

  it("reads the inbox in the order of the file names, marks files that hold no message and removes entries", () => {
    const files = swfDir();
    const inbox = join(files.dir, "inbox");
    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(inbox, "1761400000002-7.json"), JSON.stringify(answersMessage([{ author: "bob", createdAt: "2026-10-25T11:00:00Z", body: "Postgres." }])));
    writeFileSync(join(inbox, "1761400000001-7.json"), JSON.stringify(pipelineMessage(started(NOW))));
    writeFileSync(join(inbox, "1761400000003-7.json"), "{");
    writeFileSync(join(inbox, "1761400000004-7.json.tmp"), "half written");
    const entries = files.readInbox();
    expect(entries.map((entry) => [entry.name, entry.message?.kind ?? null])).toEqual([
      ["1761400000001-7.json", "pipeline"],
      ["1761400000002-7.json", "answers"],
      ["1761400000003-7.json", null],
    ]);
    files.removeInboxEntry("1761400000001-7.json");
    files.removeInboxEntry("1761400000003-7.json");
    files.removeInboxEntry("missing.json");
    expect(files.readInbox().map((entry) => entry.name)).toEqual(["1761400000002-7.json"]);
  });
});
