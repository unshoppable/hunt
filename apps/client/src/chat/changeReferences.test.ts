import { describe, expect, it } from "vitest";
import { findChangeReferences, stripChangeMarker } from "./changeReferences";
import { stripGuardrailMarker } from "./guardrailSuggestion";

const BASE = "/Users/me/worktrees/hunt-1";

describe("findChangeReferences", () => {
  it("reads one place per line with single lines and ranges", () => {
    const reply = "Done.\n\n<!-- hunt:changes\nsrc/a.ts:120-148\nsrc-tauri/src/b.rs:31\n-->";
    expect(findChangeReferences(reply, BASE)).toEqual([
      { path: "src/a.ts", startLine: 120, endLine: 148 },
      { path: "src-tauri/src/b.rs", startLine: 31, endLine: 31 },
    ]);
  });

  it("accepts L prefixes, list bullets, backticks and paths inside the worktree", () => {
    const reply = `<!-- hunt:changes\n- \`./src/a.ts:L3-L9\`\n${BASE}/src/b.ts:7\n/etc/hosts:1\nno place here\n-->`;
    expect(findChangeReferences(reply, BASE)).toEqual([
      { path: "src/a.ts", startLine: 3, endLine: 9 },
      { path: "src/b.ts", startLine: 7, endLine: 7 },
    ]);
  });

  it("keeps the first four places and ignores a marker still streaming in", () => {
    const reply = "<!-- hunt:changes\na.ts:1\nb.ts:2\nc.ts:3\nd.ts:4\ne.ts:5\n-->";
    expect(findChangeReferences(reply, BASE).map((reference) => reference.path)).toEqual(["a.ts", "b.ts", "c.ts", "d.ts"]);
    expect(findChangeReferences("Done.\n<!-- hunt:changes\nsrc/a.ts:1", BASE)).toEqual([]);
  });
});

describe("stripChangeMarker", () => {
  it("leaves the text when the marker is followed by the guardrail and question markers", () => {
    const reply = "Done.\n\n<!-- hunt:changes\nsrc/a.ts:1\n-->\n<!-- hunt:guardrail rule: x -->\n<!-- hunt:question -->";
    expect(stripGuardrailMarker(stripChangeMarker(reply))).toBe("Done.");
  });
});
