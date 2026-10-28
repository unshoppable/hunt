import ts from "typescript";
import { describe, expect, it } from "vitest";
import { isOnlyDeclaration, siblingTemplatePath, unusedMemberCandidates, unusedMemberMessage } from "./unused-members.utils";

/** The candidates of `source` as `name:kind:declarationCount`, with each declaration span checked against the name. */
function candidatesOf(source: string, fileName = "a.ts"): string[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  return unusedMemberCandidates(ts, sourceFile).map((candidate) => {
    for (const declaration of candidate.declarations) {
      expect(source.slice(declaration.start, declaration.end)).toBe(candidate.name);
    }
    return `${candidate.name}:${candidate.kind}:${candidate.declarations.length}`;
  });
}

const uri = "file:///repo/a.ts";

function range(line: number, start: number, end: number) {
  return { start: { line, character: start }, end: { line, character: end } };
}

describe("unusedMemberCandidates", () => {
  it("lists public and protected properties, methods and accessors", () => {
    const source = `
      export class Page {
        protected readonly displayByName = displayByName;
        statuses = [];
        static create() {}
        load(): void {}
        get title() { return ""; }
      }`;
    expect(candidatesOf(source)).toEqual(["displayByName:property:1", "statuses:property:1", "create:method:1", "load:method:1", "title:property:1"]);
  });

  it("lists public and protected parameter properties", () => {
    expect(candidatesOf("class A { constructor(protected readonly a: string, public b: number, private c: number, d: number) {} }")).toEqual([
      "a:property:1",
      "b:property:1",
    ]);
  });

  it("groups overloads and accessor pairs into one candidate, static members apart", () => {
    const source = "class A { load(a: string): void; load(a: number): void; load(a: unknown) {} get size() { return 1; } set size(v: number) {} static load() {} }";
    expect(candidatesOf(source)).toEqual(["load:method:3", "size:property:2", "load:method:1"]);
  });

  it("leaves out private, decorated, override, abstract and declare members", () => {
    const source = `
      abstract class A extends B {
        private a = 1;
        #b = 2;
        @Input() c = 3;
        @HostListener("click") d() {}
        override e() {}
        abstract f(): void;
        declare g: string;
        constructor(@Inject(TOKEN) protected h: string) { super(); }
      }`;
    expect(candidatesOf(source)).toEqual([]);
  });

  it("leaves out members a framework or the runtime calls by name", () => {
    expect(candidatesOf("class A { ngOnInit() {} ngOnDestroy() {} onModuleInit() {} toJSON() {} kept() {} }")).toEqual(["kept:method:1"]);
  });

  it("leaves out a whole accessor pair when one accessor is decorated", () => {
    expect(candidatesOf("class A { @Input() set value(v: string) {} get value() { return ''; } }")).toEqual([]);
  });

  it("leaves out computed names, declare classes and declaration files", () => {
    expect(candidatesOf("class A { ['a']() {} [Symbol.iterator]() {} }")).toEqual([]);
    expect(candidatesOf("declare class A { a: string; }")).toEqual([]);
    expect(candidatesOf("export class A { a: string; }", "a.d.ts")).toEqual([]);
  });

  it("finds classes nested in functions and class expressions", () => {
    expect(candidatesOf("function f() { class A { a = 1; } return class { b() {} }; }")).toEqual(["a:property:1", "b:method:1"]);
  });
});

describe("isOnlyDeclaration", () => {
  const declarations = [range(4, 21, 34)];

  it("accepts no references and the declaration alone", () => {
    expect(isOnlyDeclaration([], uri, declarations)).toBe(true);
    expect(isOnlyDeclaration([{ uri, range: range(4, 21, 34) }], uri, declarations)).toBe(true);
  });

  it("matches the document regardless of URI escaping", () => {
    const escaped = "file:///repo/%61.ts";
    expect(isOnlyDeclaration([{ uri: escaped, range: range(4, 21, 34) }], uri, declarations)).toBe(true);
  });

  it("counts a reference in the same file, another file or an implemented declaration as a usage", () => {
    expect(isOnlyDeclaration([{ uri, range: range(4, 21, 34) }, { uri, range: range(9, 10, 23) }], uri, declarations)).toBe(false);
    expect(isOnlyDeclaration([{ uri: "file:///repo/a.html", range: range(4, 21, 34) }], uri, declarations)).toBe(false);
    expect(isOnlyDeclaration([{ uri: "file:///repo/node_modules/@angular/core/index.d.ts", range: range(0, 19, 27) }], uri, declarations)).toBe(false);
  });
});

describe("siblingTemplatePath", () => {
  it("swaps a TypeScript file's extension for .html", () => {
    expect(siblingTemplatePath("libs/list/base-list.component.ts")).toBe("libs/list/base-list.component.html");
  });

  it("has no template for other files", () => {
    expect(siblingTemplatePath("src/a.tsx")).toBeNull();
    expect(siblingTemplatePath("src/a.d.mts")).toBeNull();
  });
});

describe("unusedMemberMessage", () => {
  it("names the kind and the member", () => {
    expect(unusedMemberMessage({ name: "displayByName", kind: "property", declarations: [] })).toBe("Unused property 'displayByName'");
  });
});
