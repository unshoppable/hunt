import { describe, expect, it } from "vitest";
import { parseTranscriptRequest } from "./transcriptProtocol.ts";

describe("parseTranscriptRequest", () => {
  it("reads a sync with the offsets the client holds and the paths it owns", () => {
    const parsed = parseTranscriptRequest(JSON.stringify({ t: "sync", files: { "abc.jsonl": 120, "abc/tool-results/1.txt": 0 }, owned: ["sub.jsonl"] }));
    expect(parsed).toEqual({ request: { t: "sync", files: new Map([["abc.jsonl", 120], ["abc/tool-results/1.txt", 0]]), owned: ["sub.jsonl"] } });
  });

  it("reads a read and a write with its content decoded", () => {
    expect(parseTranscriptRequest(JSON.stringify({ t: "read", path: "abc.jsonl", offset: 7 }))).toEqual({ request: { t: "read", path: "abc.jsonl", offset: 7 } });
    const write = parseTranscriptRequest(JSON.stringify({ t: "write", id: 2, path: "sub.jsonl", offset: 0, data: Buffer.from("{}\n").toString("base64"), truncate: true }));
    expect(write).toEqual({ request: { t: "write", id: 2, path: "sub.jsonl", offset: 0, data: Buffer.from("{}\n"), truncate: true } });
  });

  it("refuses malformed lines and names what is wrong", () => {
    const cases: [unknown, string][] = [
      ["nope", "not JSON"],
      [JSON.stringify([]), "expected a JSON object"],
      [JSON.stringify({ t: "apply" }), 'unknown type "apply"'],
      [JSON.stringify({ t: "sync", files: [], owned: [] }), "files must be an object"],
      [JSON.stringify({ t: "sync", files: { "../x": 0 }, owned: [] }), '".." segment'],
      [JSON.stringify({ t: "sync", files: { a: -1 }, owned: [] }), "offset of a"],
      [JSON.stringify({ t: "sync", files: {}, owned: ["/abs"] }), "is absolute"],
      [JSON.stringify({ t: "read", path: "a", offset: 1.5 }), "offset must be"],
      [JSON.stringify({ t: "write", id: "1", path: "a", offset: 0, data: "", truncate: false }), "id must be an integer"],
      [JSON.stringify({ t: "write", id: 1, path: "a", offset: 0, data: "*", truncate: false }), "data must be base64"],
      [JSON.stringify({ t: "write", id: 1, path: "a", offset: 0, data: "", truncate: "yes" }), "truncate must be a boolean"],
    ];
    for (const [line, problem] of cases) {
      const parsed = parseTranscriptRequest(line as string);
      expect("error" in parsed ? parsed.error : "", line as string).toContain(problem);
    }
  });
});
