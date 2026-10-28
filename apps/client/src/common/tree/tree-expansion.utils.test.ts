import { describe, expect, it } from "vitest";
import { toggleInCollapsed, toggleInExpanded } from "./tree-expansion.utils";

describe("toggleInExpanded", () => {
  it("closes the folder and every folder below it, but not siblings with the same prefix", () => {
    const expanded = new Set(["", "src", "src/app", "src/app/user", "src-old", "docs"]);
    expect([...toggleInExpanded(expanded, "src")]).toEqual(["", "src-old", "docs"]);
  });

  it("closes everything when the root closes", () => {
    expect([...toggleInExpanded(new Set(["", "src", "src/app"]), "")]).toEqual([]);
  });

  it("opens only the folder itself", () => {
    expect([...toggleInExpanded(new Set([""]), "src")]).toEqual(["", "src"]);
  });
});

describe("toggleInCollapsed", () => {
  const folders = ["local", "local/feat", "local/feat/general", "localx", "remote"];

  it("closes the folder and every known folder below it", () => {
    expect([...toggleInCollapsed(new Set(["tags"]), "local", folders)]).toEqual(["tags", "local", "local/feat", "local/feat/general"]);
  });

  it("opens only the folder itself, so its subfolders stay closed", () => {
    expect([...toggleInCollapsed(new Set(["local", "local/feat"]), "local", folders)]).toEqual(["local/feat"]);
  });
});
