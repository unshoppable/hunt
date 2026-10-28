import { describe, expect, it } from "vitest";
import { FileState } from "./file-state.value-object.ts";
import type { FileReport } from "./sync-protocol.types.ts";
import { changeMessages, parseRequest, pathProblem } from "./sync-protocol.utils.ts";

const STATE = new FileState({ size: 2, modifiedNs: "1700000000123456789", executable: false, link: false });

describe("pathProblem", () => {
  it("accepts worktree-relative paths, also inside .hunt and with dots in names", () => {
    for (const path of ["a", "src/a.ts", ".gitignore", ".hunt/graph.json", "a/.git-x/b", "..a/b..", ".github/x.yml"]) {
      expect(pathProblem(path), path).toBeNull();
    }
  });

  it("rejects absolute paths, climbing or empty segments, NUL and everything in .git", () => {
    const cases: [unknown, string][] = [
      ["", "non-empty string"],
      [7, "non-empty string"],
      ["/etc/passwd", "is absolute"],
      ["a/../b", '".." segment'],
      ["..", '".." segment'],
      ["a//b", "empty"],
      ["a/./b", "empty"],
      ["a/", "empty"],
      ["a\0b", "NUL"],
      [".git/config", "inside .git"],
      [".git", "inside .git"],
    ];
    for (const [path, problem] of cases) {
      expect(pathProblem(path), String(path)).toContain(problem);
    }
  });
});

describe("parseRequest", () => {
  it("reads writes, links and deletes", () => {
    const line = JSON.stringify({
      t: "apply",
      id: 3,
      writes: [{ path: "a.sh", data: Buffer.from("echo").toString("base64"), executable: true, modifiedNs: "1700000000123456789" }],
      links: [{ path: "l", target: "../a.sh", modifiedNs: "0" }],
      deletes: ["old/b.txt"],
    });

    expect(parseRequest(line)).toEqual({
      request: {
        id: 3,
        writes: [{ path: "a.sh", data: Buffer.from("echo"), executable: true, modifiedNs: 1700000000123456789n }],
        links: [{ path: "l", target: "../a.sh", modifiedNs: 0n }],
        deletes: ["old/b.txt"],
      },
      problems: [],
    });
  });

  it("treats missing lists as empty", () => {
    expect(parseRequest('{"t":"apply","id":1}')).toEqual({ request: { id: 1, writes: [], links: [], deletes: [] }, problems: [] });
  });

  it("skips invalid entries and names each one", () => {
    const line = JSON.stringify({
      t: "apply",
      id: 4,
      writes: [
        { path: ".git/hooks/pre-commit", data: "", executable: true, modifiedNs: "1" },
        { path: "a", data: "not base64!", executable: false, modifiedNs: "1" },
        { path: "b", data: "", executable: "no", modifiedNs: "1" },
        { path: "c", data: "", executable: false, modifiedNs: 1 },
        { path: "ok", data: "", executable: false, modifiedNs: "1" },
      ],
      links: [{ path: "/abs", target: "x", modifiedNs: "1" }, { path: "l", target: "", modifiedNs: "1" }, "x"],
      deletes: ["../up", 5, "fine"],
    });

    const parsed = parseRequest(line);
    expect(parsed).toMatchObject({ request: { id: 4, writes: [{ path: "ok" }], links: [], deletes: ["fine"] } });
    expect("problems" in parsed && parsed.problems).toEqual([
      'request 4: skipped writes[0]: path ".git/hooks/pre-commit" lies inside .git',
      "request 4: skipped writes[1] (a): data must be base64",
      "request 4: skipped writes[2] (b): executable must be a boolean",
      "request 4: skipped writes[3] (c): modifiedNs must be a decimal string",
      'request 4: skipped links[0]: path "/abs" is absolute',
      "request 4: skipped links[1] (l): target must be a non-empty string without NUL",
      "request 4: skipped links[2] must be an object",
      'request 4: skipped deletes[0]: path "../up" has an empty, "." or ".." segment',
      "request 4: skipped deletes[1]: path must be a non-empty string",
    ]);
  });

  it("refuses lines that are no apply request", () => {
    expect(parseRequest("{")).toEqual({ error: "malformed request: not JSON" });
    expect(parseRequest("[]")).toEqual({ error: "malformed request: expected a JSON object" });
    expect(parseRequest('{"t":"write"}')).toEqual({ error: 'malformed request: unknown type "write"' });
    expect(parseRequest('{"t":"apply","id":"1"}')).toEqual({ error: "malformed request: id must be an integer" });
    expect(parseRequest('{"t":"apply","id":1.5}')).toEqual({ error: "malformed request: id must be an integer" });
    expect(parseRequest('{"t":"apply","id":2,"deletes":"a"}')).toEqual({ error: "malformed request 2: deletes must be an array" });
  });
});

describe("changeMessages", () => {
  const report = (path: string, size: number): FileReport => ({ path, state: STATE, listed: true, data: "x".repeat(size) });

  it("starts a new message when the inline data would exceed the limit, keeping a large file whole", () => {
    const gone: FileReport = { path: "gone", state: null, listed: true };
    const messages = changeMessages([report("a", 4), report("b", 4), gone, report("c", 3), report("big", 20)], 8);

    expect(messages.map((message) => message.t === "changes" && message.files.map((file) => file.path))).toEqual([["a", "b", "gone"], ["c"], ["big"]]);
  });

  it("sends nothing for no reports", () => {
    expect(changeMessages([], 8)).toEqual([]);
  });
});
