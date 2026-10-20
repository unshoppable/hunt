import { describe, expect, it } from "vitest";
import { completionName, isMemberList, likelyVisibleOrder, parseCompletionDetail } from "./completionItems";

describe("parseCompletionDetail", () => {
  it("splits a member into owner, signature and type", () => {
    expect(parseCompletionDetail("(property) PropertyOptions<ClassificationAssociation>.nullable?: boolean | undefined", "nullable")).toEqual({
      owner: "PropertyOptions<ClassificationAssociation>",
      signature: "nullable?: boolean | undefined",
      type: "boolean | undefined",
    });
    expect(parseCompletionDetail("(property) CreateClassificationAssociationDto.sourceType?: ClassificationAssociationType | null | undefined", "sourceType")?.type).toBe(
      "ClassificationAssociationType | null | undefined",
    );
  });

  it("keeps function types and keyof in a property's type", () => {
    const parsed = parseCompletionDetail("(property) PropertyOptions<X>.onCreate?: ((entity: X, em: EntityManager) => any) | undefined", "onCreate");
    expect(parsed?.type).toBe("((entity: X, em: EntityManager) => any) | undefined");
    expect(parsed?.parameters).toBeUndefined();
    expect(parseCompletionDetail("(property) PropertyOptions<X>.accessor?: boolean | keyof X | AnyString | undefined", "accessor")?.type).toBe("boolean | keyof X | AnyString | undefined");
  });

  it("reads a member of a mapped type without owner", () => {
    expect(parseCompletionDetail("(property) cascade?: Cascade[] | undefined", "cascade")).toEqual({ owner: undefined, signature: "cascade?: Cascade[] | undefined", type: "Cascade[] | undefined" });
  });

  it("splits a callable into parameters and return type", () => {
    expect(parseCompletionDetail("(alias) function rel<T, PK extends Primary<T>>(entityType: EntityClass<T>, pk: T | PK): T", "rel")).toEqual({
      owner: undefined,
      signature: "function rel<T, PK extends Primary<T>>(entityType: EntityClass<T>, pk: T | PK): T",
      parameters: "(entityType: EntityClass<T>, pk: T | PK)",
      type: "T",
    });
    expect(parseCompletionDetail("(method) Array<T>.map<U>(callbackfn: (value: T, index: number, array: T[]) => U, thisArg?: any): U[]", "map")).toEqual({
      owner: "Array<T>",
      signature: "map<U>(callbackfn: (value: T, index: number, array: T[]) => U, thisArg?: any): U[]",
      parameters: "(callbackfn: (value: T, index: number, array: T[]) => U, thisArg?: any)",
      type: "U[]",
    });
    expect(parseCompletionDetail("(method) Repo.find(id: string): Promise<Entity> (+2 overloads)", "find")?.type).toBe("Promise<Entity>");
  });

  it("reads parameters, variables and multi-line globals", () => {
    expect(parseCompletionDetail("(parameter) dto: CreateClassificationAssociation", "dto")?.type).toBe("CreateClassificationAssociation");
    expect(parseCompletionDetail("var DOMRectList: {\n    new (): DOMRectList;\n    prototype: DOMRectList;\n}", "DOMRectList")).toEqual({
      owner: undefined,
      signature: "var DOMRectList: { new (): DOMRectList; prototype: DOMRectList; }",
      type: "{ new (): DOMRectList; prototype: DOMRectList; }",
    });
  });

  it("keeps declarations without a type and drops alias and import notes", () => {
    expect(parseCompletionDetail("(alias) class Foo\nimport Foo", "Foo")).toEqual({ owner: undefined, signature: "class Foo" });
    expect(parseCompletionDetail("Auto import from './options'\nclass Helper", "Helper")).toEqual({ owner: undefined, signature: "class Helper" });
  });

  it("returns null for keywords, bare import notes and unknown names", () => {
    expect(parseCompletionDetail("if", "if")).toBeNull();
    expect(parseCompletionDetail('Update import from "@mikro-orm/core"', "Property")).toBeNull();
    expect(parseCompletionDetail("this: this", "rel")).toBeNull();
  });
});

describe("completionName", () => {
  it("drops the optional marker", () => {
    expect(completionName({ label: "nullable?" })).toBe("nullable");
    expect(completionName({ label: "type" })).toBe("type");
  });
});

describe("isMemberList", () => {
  it("accepts object literal and member access lists", () => {
    expect(isMemberList([{ kind: 5, sortText: "11" }, { kind: 5, sortText: "12" }, { kind: 2, sortText: "14" }])).toBe(true);
  });

  it("rejects global lists, keywords and empty lists", () => {
    expect(isMemberList([{ kind: 5, sortText: "11" }, { kind: 6, sortText: "15" }])).toBe(false);
    expect(isMemberList([{ kind: 7, sortText: "16" }])).toBe(false);
    expect(isMemberList([{ kind: 5, sortText: "11" }, { kind: 14, sortText: "14" }])).toBe(false);
    expect(isMemberList([])).toBe(false);
  });
});

describe("likelyVisibleOrder", () => {
  const items = [
    { label: "nullable?", filterText: "nullable", sortText: "12" },
    { label: "name?", filterText: "name", sortText: "12" },
    { label: "type", sortText: "11" },
    { label: "Number", sortText: "15" },
  ];

  it("orders by sort text, then by label", () => {
    expect(likelyVisibleOrder(items, "")).toEqual([2, 1, 0, 3]);
  });

  it("keeps only items starting with the typed word, ignoring case", () => {
    expect(likelyVisibleOrder(items, "nu")).toEqual([0, 3]);
  });
});
