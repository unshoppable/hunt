import { describe, expect, it } from "vitest";
import { defaultDiagramName, diagramFilePath, diagramFileStem, expandSaveFolders, savePatternSegments } from "./diagram-save.utils";

describe("savePatternSegments", () => {
  it("splits a relative pattern and rejects absolute and climbing ones", () => {
    expect(savePatternSegments(" apps/*/docs/diagrams/ ")).toEqual(["apps", "*", "docs", "diagrams"]);
    expect(savePatternSegments("/etc")).toBeNull();
    expect(savePatternSegments("C:/docs")).toBeNull();
    expect(savePatternSegments("apps/../..")).toBeNull();
    expect(savePatternSegments("  ")).toBeNull();
  });
});

describe("expandSaveFolders", () => {
  const tree: Record<string, string[]> = { apps: ["med", ".cache", "aktivrente"], "apps/med/libs": ["core"] };
  const listFolders = async (path: string) => {
    const names = tree[path];
    if (!names) throw new Error(`no such folder: ${path}`);
    return names;
  };

  it("expands each star to the visible subfolders and keeps the literal segments", async () => {
    expect(await expandSaveFolders("apps/*/docs/diagrams", listFolders)).toEqual(["apps/aktivrente/docs/diagrams", "apps/med/docs/diagrams"]);
  });

  it("takes a pattern without a star as the one folder, and a star under a missing folder as none", async () => {
    expect(await expandSaveFolders("docs/diagrams", listFolders)).toEqual(["docs/diagrams"]);
    expect(await expandSaveFolders("apps/*/libs/*", listFolders)).toEqual(["apps/med/libs/core"]);
    expect(await expandSaveFolders("missing/*", listFolders)).toEqual([]);
    expect(await expandSaveFolders("../outside", listFolders)).toEqual([]);
  });
});

describe("diagram file names", () => {
  it("derives a kebab-case stem and the path in the folder", () => {
    expect(diagramFileStem("Zustände der Bestellung")).toBe("zustande-der-bestellung");
    expect(defaultDiagramName({ type: "states", title: "Order lifecycle" })).toBe("order-lifecycle");
    expect(defaultDiagramName({ type: "erd" })).toBe("erd");
    expect(diagramFilePath("apps/med/docs/diagrams/", "Order lifecycle")).toBe("apps/med/docs/diagrams/order-lifecycle.react-flow.json");
    expect(diagramFilePath("docs", "erd.react-flow.json")).toBe("docs/erd.react-flow.json");
  });
});
