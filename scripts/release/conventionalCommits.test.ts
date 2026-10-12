import { describe, expect, it } from "vitest";
import { bumpFor, nextVersion, parseCommit, renderNotes, type ConventionalCommit, type RawCommit } from "./conventionalCommits.ts";

function raw(subject: string, body = "", hash = "0123456789abcdef"): RawCommit {
  return { hash, subject, body };
}

function parsed(subject: string, body = "", hash = "0123456789abcdef"): ConventionalCommit {
  const commit = parseCommit(raw(subject, body, hash));
  if (!commit) throw new Error(`fixture "${subject}" is not a conventional commit`);
  return commit;
}

describe("parseCommit", () => {
  it("reads type, scope and description", () => {
    expect(parsed("feat(ide): add usages popover")).toMatchObject({ type: "feat", scope: "ide", description: "add usages popover", breaking: false });
  });

  it("treats a missing scope as undefined and lower-cases the type", () => {
    expect(parsed("Fix: trailing slash")).toMatchObject({ type: "fix", scope: undefined, description: "trailing slash" });
  });

  it("marks `!` after type or scope as breaking", () => {
    expect(parsed("feat!: drop legacy storage").breaking).toBe(true);
    expect(parsed("refactor(store)!: rename reducers").breaking).toBe(true);
  });

  it("marks a BREAKING CHANGE footer as breaking", () => {
    expect(parsed("fix: realign ids", "Some body.\n\nBREAKING CHANGE: session ids are now uuids").breaking).toBe(true);
    expect(parsed("fix: realign ids", "BREAKING-CHANGE: same thing").breaking).toBe(true);
    expect(parsed("fix: realign ids", "mentions breaking change in prose").breaking).toBe(false);
  });

  it("returns undefined for a non-conventional subject", () => {
    expect(parseCommit(raw("Fix release workflow config path"))).toBeUndefined();
    expect(parseCommit(raw("feat:missing space"))).toBeUndefined();
    expect(parseCommit(raw("Merge branch 'main'"))).toBeUndefined();
  });
});

describe("bumpFor", () => {
  it("picks the highest release type", () => {
    expect(bumpFor([parsed("fix: a"), parsed("feat: b"), parsed("docs: c")])).toBe("minor");
    expect(bumpFor([parsed("feat: b"), parsed("fix: a")])).toBe("minor");
    expect(bumpFor([parsed("perf: a"), parsed("revert: b")])).toBe("patch");
  });

  it("returns major for any breaking commit regardless of type", () => {
    expect(bumpFor([parsed("feat: a"), parsed("chore!: b")])).toBe("major");
  });

  it("returns undefined when no commit is releasable", () => {
    expect(bumpFor([])).toBeUndefined();
    expect(bumpFor([parsed("chore: deps"), parsed("docs: readme"), parsed("ci: cache")])).toBeUndefined();
  });
});

describe("nextVersion", () => {
  it("bumps and resets lower components", () => {
    expect(nextVersion("0.2.0", "patch")).toBe("0.2.1");
    expect(nextVersion("0.2.1", "minor")).toBe("0.3.0");
    expect(nextVersion("0.3.0", "major")).toBe("1.0.0");
    expect(nextVersion("1.9.9", "major")).toBe("2.0.0");
  });

  it("rejects pre-release and malformed versions", () => {
    expect(() => nextVersion("1.0.0-beta.1", "patch")).toThrow(/failed to parse version/);
    expect(() => nextVersion("1.0", "patch")).toThrow(/failed to parse version/);
  });
});

describe("renderNotes", () => {
  it("groups commits by section in log order and lists each commit once", () => {
    const notes = renderNotes([
      parsed("feat(ide): add usages popover", "", "aaaaaaa1111"),
      parsed("fix: trailing slash", "", "bbbbbbb2222"),
      parsed("feat!: drop legacy storage", "", "ccccccc3333"),
      parsed("perf(graph): cache layout", "", "ddddddd4444"),
      parsed("chore: deps", "", "eeeeeee5555"),
    ]);
    expect(notes).toBe(
      [
        "### Breaking changes",
        "",
        "- drop legacy storage (ccccccc)",
        "",
        "### Features",
        "",
        "- ide: add usages popover (aaaaaaa)",
        "",
        "### Fixes",
        "",
        "- trailing slash (bbbbbbb)",
        "",
        "### Performance",
        "",
        "- graph: cache layout (ddddddd)",
      ].join("\n"),
    );
  });

  it("renders nothing for commits outside every section", () => {
    expect(renderNotes([parsed("chore: deps")])).toBe("");
  });
});
