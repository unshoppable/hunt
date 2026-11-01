import { describe, expect, it } from "vitest";
import { changedPathsOf } from "./git-status.utils.ts";

describe("changedPathsOf", () => {
  it("gives no path for a clean tree", () => {
    expect(changedPathsOf("")).toEqual([]);
  });

  it("gives the path of each entry and the target of a rename, keeping spaces and arrows in names", () => {
    const output = [" M src/app.ts", "?? notes with space.md", "R  new.ts", "old.ts", "A  a -> b.txt", "D  gone.ts", ""].join("\0");
    expect(changedPathsOf(output)).toEqual(["src/app.ts", "notes with space.md", "new.ts", "a -> b.txt", "gone.ts"]);
  });
});
