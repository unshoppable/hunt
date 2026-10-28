import ts from "typescript";
import { describe, expect, it } from "vitest";
import { isObjectMemberPosition } from "./completion-context.utils";

/** Parses `source` with `|` marking the cursor and asks whether a member of an object starts there. */
function atCursor(source: string): boolean {
  const offset = source.indexOf("|");
  const text = source.slice(0, offset) + source.slice(offset + 1);
  const sourceFile = ts.createSourceFile("a.ts", text, ts.ScriptTarget.Latest, true);
  return isObjectMemberPosition(ts, sourceFile, offset);
}

describe("isObjectMemberPosition", () => {
  it("accepts the start of a member in an object literal", () => {
    expect(atCursor("class A { @Property({ type: 'uuid', | }) id!: string; }")).toBe(true);
    expect(atCursor("class A { @Property({ type: 'uuid',| }) id!: string; }")).toBe(true);
    expect(atCursor("class A { @Property({| }) id!: string; }")).toBe(true);
    expect(atCursor("class A { @Property({ |}) id!: string; }")).toBe(true);
    expect(atCursor("const a = { ...b, | };")).toBe(true);
    expect(atCursor("call({\n  type: 'uuid',\n  |\n});")).toBe(true);
  });

  it("accepts an unclosed object literal", () => {
    expect(atCursor("call({ type: 'uuid', |")).toBe(true);
  });

  it("accepts the start of a member in a destructuring pattern", () => {
    expect(atCursor("const { a, | } = b;")).toBe(true);
    expect(atCursor("function f({ | }: Options) {}")).toBe(true);
  });

  it("rejects positions inside a member or after its colon", () => {
    expect(atCursor("call({ type: | });")).toBe(false);
    expect(atCursor("call({ ty| });")).toBe(false);
    expect(atCursor("call({ type: 'uu|id' });")).toBe(false);
  });

  it("rejects braces and commas that do not belong to an object", () => {
    expect(atCursor("if (a) {| }")).toBe(false);
    expect(atCursor("const f = () => {| };")).toBe(false);
    expect(atCursor("class A {| }")).toBe(false);
    expect(atCursor("call(a, | );")).toBe(false);
    expect(atCursor("const a = [1, | ];")).toBe(false);
    expect(atCursor("type T = { a: string, | };")).toBe(false);
    expect(atCursor("import { a, | } from './b';")).toBe(false);
    expect(atCursor("enum E { A, | }")).toBe(false);
  });

  it("rejects comments and strings", () => {
    expect(atCursor("call({ a: 1, // note, |\n});")).toBe(false);
    expect(atCursor("call('a, |');")).toBe(false);
    expect(atCursor("call(`{ |`);")).toBe(false);
  });
});
