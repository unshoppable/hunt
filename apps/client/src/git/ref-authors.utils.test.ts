import { describe, expect, it } from "vitest";
import type { GitRef } from "./git.types";
import { githubLoginOf, refAuthors, refsByAuthors } from "./ref-authors.utils";

const ref = (name: string, author: string, authorEmail = ""): GitRef => ({ name, kind: "local", target: "0".repeat(40), upstream: null, ahead: 0, behind: 0, worktreePath: null, author, authorEmail });

describe("githubLoginOf", () => {
  it("reads the login of GitHub's noreply addresses only", () => {
    expect(githubLoginOf("61085055+yackinn@users.noreply.github.com")).toBe("yackinn");
    expect(githubLoginOf("bot[bot]@users.noreply.github.com")).toBe("bot[bot]");
    expect(githubLoginOf("code@example.com")).toBeNull();
    expect(githubLoginOf("")).toBeNull();
  });
});

describe("refAuthors", () => {
  it("lists every name once, sorted, with the first login its emails name", () => {
    const refs = [ref("b", "Zoe", "zoe@example.com"), ref("a", "Ann", "1+ann@users.noreply.github.com"), ref("c", "Zoe", "2+zoe@users.noreply.github.com"), ref("d", "")];
    expect(refAuthors(refs)).toEqual([
      { name: "Ann", login: "ann" },
      { name: "Zoe", login: "zoe" },
    ]);
  });
});

describe("refsByAuthors", () => {
  it("keeps the refs of the named authors, or every ref when none is named", () => {
    const refs = [ref("a", "Ann"), ref("b", "Bob"), ref("c", "Cy")];
    expect(refsByAuthors(refs, ["Ann", "Cy"]).map((candidate) => candidate.name)).toEqual(["a", "c"]);
    expect(refsByAuthors(refs, []).map((candidate) => candidate.name)).toEqual(["a", "b", "c"]);
  });
});
