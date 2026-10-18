import { describe, expect, it } from "vitest";
import schema from "../../src-tauri/src/diagram.schema.json";
import type { ShapeDiagramType } from "../ipc/types";
import { DIAGRAM_FILES, DIAGRAM_TYPES, isShapeDiagramType, KINDS_BY_TYPE } from "./diagramTypes";

/** The kind enum the schema's `allOf` branch for `type` allows. */
function schemaKinds(type: ShapeDiagramType): string[] {
  const branch = schema.allOf.find((condition) => condition.if.properties.type.const === type);
  return branch!.then.properties.nodes.items.properties.kind.enum;
}

describe("diagram types", () => {
  it("lists the dependency diagram first and every schema type after it", () => {
    expect(DIAGRAM_TYPES.map((option) => option.id)).toEqual(["dependencies", ...schema.properties.type.enum]);
    for (const option of DIAGRAM_TYPES) {
      expect(option.name).not.toBe("");
      expect(option.description).not.toBe("");
    }
  });

  it("allows exactly the kinds the schema allows per type", () => {
    for (const type of schema.properties.type.enum as ShapeDiagramType[]) {
      expect(KINDS_BY_TYPE[type], type).toEqual(schemaKinds(type));
    }
  });

  it("names the file of every type", () => {
    expect(isShapeDiagramType("dependencies")).toBe(false);
    expect(isShapeDiagramType("erd")).toBe(true);
    expect(DIAGRAM_FILES.dependencies).toBe(".hunt/graph.json");
    for (const type of schema.properties.type.enum as ShapeDiagramType[]) {
      expect(DIAGRAM_FILES[type]).toBe(`.hunt/diagram.${type}.json`);
    }
  });
});
