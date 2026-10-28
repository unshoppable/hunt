import { describe, expect, it } from "vitest";
import { buildChangeTree, folderPaths } from "./change-tree.utils";

const file = (path: string, status = "M") => ({ path, status });

describe("buildChangeTree", () => {
  it("puts root files after folders and sorts both alphabetically", () => {
    const tree = buildChangeTree([file("zeta.ts"), file("b/x.ts"), file("alpha.ts"), file("a/y.ts")]);
    expect(tree.children.map((node) => node.name)).toEqual(["a", "b", "alpha.ts", "zeta.ts"]);
    expect(tree.files.map((entry) => entry.path)).toEqual(["a/y.ts", "b/x.ts", "alpha.ts", "zeta.ts"]);
  });

  it("compacts single-child folder chains into one node with the full path", () => {
    const tree = buildChangeTree([file("apps/backend/src/app/main.ts"), file("apps/backend/src/app/user/user.ts")]);
    const [apps] = tree.children;
    expect(apps.kind).toBe("folder");
    if (apps.kind !== "folder") return;
    expect(apps.name).toBe("apps/backend/src/app");
    expect(apps.path).toBe("apps/backend/src/app");
    expect(apps.children.map((node) => node.name)).toEqual(["user", "main.ts"]);
  });

  it("does not compact a folder that has files of its own", () => {
    const tree = buildChangeTree([file("src/index.ts"), file("src/lib/util.ts")]);
    const [src] = tree.children;
    if (src.kind !== "folder") throw new Error("expected folder");
    expect(src.name).toBe("src");
    expect(src.children.map((node) => node.name)).toEqual(["lib", "index.ts"]);
  });

  it("never compacts the root", () => {
    const tree = buildChangeTree([file("src/a.ts")]);
    expect(tree.path).toBe("");
    expect(tree.children[0].name).toBe("src");
  });
});

describe("folderPaths", () => {
  it("lists every folder node at any depth, compacted chains by their full path", () => {
    const tree = buildChangeTree([file("apps/backend/src/main.ts"), file("apps/backend/src/user/user.ts"), file("docs/a.md"), file("root.ts")]);
    expect(folderPaths(tree)).toEqual(["apps/backend/src", "apps/backend/src/user", "docs"]);
  });
});
