import ts from "typescript";
import { describe, expect, it } from "vitest";
import { classifyWebstorm, roleOfImportHover } from "./webstorm-classifier.utils";
import { WEBSTORM_ROLES, type WebstormRole } from "./webstorm-roles.constants";

const OTHER = `
export class Repo {}
export class Entity {}
export function helper(n: number): number { return n; }
export interface Shape { kind: string }
`;

const MAIN = `
import { Repo, Entity, helper, Shape } from "./other";
import * as mod from "./other";
import { External, Missing as Renamed, Unknown } from "@scope/missing";
declare const Deco: any;

const CONFIG = { a: 1 };
let counter = 0;

interface Shape2 { area(): number; kind: string }
type Alias = Shape | Shape2;
enum Color { Red, Green }

class Box<T> extends Repo {
  static count = 0;
  private items: T[] = [];
  #secret = 1;
  constructor(private readonly em: Entity, public size: number) { super(); }
  static create(): Box<string> { return new Box(new Entity(), 1); }
  add(item: T): void {
    this.items.push(item);
    const local = this.em;
    function inner(): void {}
    inner();
    Box.count++;
    Box.create();
    this.size = Color.Green + this.#secret;
  }
}

function globalFn(param: number): void {
  const { a } = CONFIG;
  outer: for (const x of [1]) { if (x) break outer; }
  console.log(Math.max(param, counter), Promise.resolve(a));
  const pending: Promise<number> | null = null;
  const version = APP_VERSION;
  const anyValue: any = null;
  anyValue.whatever;
  const em = 1;
  const obj = { em, size: 2 };
  helper(obj.size);
  mod.helper(1);
  const alias: Alias = { kind: "x" };
  alias.kind;
  const external: External | Renamed | Unknown | null = null;
}

@Deco.table({ name: helper })
class Decorated {
  @Deco() field = 1;
}
`;

type Classified = { text: string; role: WebstormRole };

/** Roles of the imports from the unresolvable `@scope/missing`, as the language server would report them. */
const IMPORT_ROLES = {
  "@scope/missing\0External": WEBSTORM_ROLES.indexOf("interface"),
  "@scope/missing\0Missing": WEBSTORM_ROLES.indexOf("enum"),
};

const GLOBALS = `
declare global {
  const APP_VERSION: string;
}
export {};
`;

/**
 * Classifies `main.ts` (importing `other.ts`, with the globals of `globals.d.ts`) with a program over in-memory sources and
 * the ES2020 and DOM libs; the imports from `@scope/missing` take their roles from `IMPORT_ROLES`.
 */
function classify(): { classified: Classified[]; unresolvedImports: { key: string; text: string }[] } {
  const files: Record<string, string> = { "/project/main.ts": MAIN, "/project/other.ts": OTHER, "/project/globals.d.ts": GLOBALS };
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ["lib.es2020.d.ts", "lib.dom.d.ts"],
    strict: true,
    experimentalDecorators: true,
  };
  const base = ts.createCompilerHost(options);
  const host: ts.CompilerHost = {
    ...base,
    getCurrentDirectory: () => "/project",
    fileExists: (fileName) => fileName in files || base.fileExists(fileName),
    directoryExists: (directory) => directory === "/project" || !!base.directoryExists?.(directory),
    readFile: (fileName) => files[fileName] ?? base.readFile(fileName),
    getSourceFile: (fileName, languageVersion) => {
      const text = files[fileName];
      return text === undefined ? base.getSourceFile(fileName, languageVersion) : ts.createSourceFile(fileName, text, languageVersion);
    },
    writeFile: () => {},
  };
  const program = ts.createProgram(Object.keys(files), options, host);
  const sourceFile = program.getSourceFile("/project/main.ts")!;
  const { classifications: triples, unresolvedImports } = classifyWebstorm(ts, sourceFile, program.getTypeChecker(), IMPORT_ROLES);

  const result: Classified[] = [];
  for (let index = 0; index < triples.length; index += 3) {
    result.push({ text: MAIN.slice(triples[index], triples[index] + triples[index + 1]), role: WEBSTORM_ROLES[triples[index + 2]] });
  }
  return {
    classified: result,
    unresolvedImports: unresolvedImports.map((unresolvedImport) => ({ key: unresolvedImport.key, text: MAIN.slice(unresolvedImport.offset).match(/^\w+/)![0] })),
  };
}

const { classified, unresolvedImports } = classify();

/** The distinct roles every identifier spelled `text` got, in order of first appearance. */
function rolesOf(text: string): WebstormRole[] {
  return [...new Set(classified.filter((entry) => entry.text === text).map((entry) => entry.role))];
}

describe("classifyWebstorm", () => {
  it("emits triples in source order", () => {
    const starts: number[] = [];
    let position = 0;
    for (const entry of classified) {
      position = MAIN.indexOf(entry.text, position);
      starts.push(position);
      position += entry.text.length;
    }
    expect(starts).toEqual([...starts].sort((left, right) => left - right));
  });

  it("colors type declarations and their references by kind", () => {
    expect(rolesOf("Box")).toEqual(["class"]);
    expect(rolesOf("Shape2")).toEqual(["interface"]);
    expect(rolesOf("Color")).toEqual(["enum"]);
    expect(rolesOf("Alias")).toEqual(["typeAlias"]);
    expect(rolesOf("T")).toEqual(["typeParameter"]);
    expect(rolesOf("Green")).toEqual(["enumMember"]);
    expect(rolesOf("Red")).toEqual(["enumMember"]);
  });

  it("distinguishes global from local functions", () => {
    expect(rolesOf("globalFn")).toEqual(["globalFunction"]);
    expect(rolesOf("inner")).toEqual(["localFunction"]);
  });

  it("distinguishes instance from static members", () => {
    expect(rolesOf("add")).toEqual(["instanceMethod"]);
    expect(rolesOf("push")).toEqual(["instanceMethod"]);
    expect(rolesOf("area")).toEqual(["instanceMethod"]);
    expect(rolesOf("create")).toEqual(["staticMethod"]);
    expect(rolesOf("items")).toEqual(["instanceField"]);
    expect(rolesOf("#secret")).toEqual(["instanceField"]);
    expect(rolesOf("kind")).toEqual(["instanceField"]);
    expect(rolesOf("count")).toEqual(["staticField"]);
  });

  it("colors constructor parameter properties as instance fields", () => {
    expect(rolesOf("em")).toEqual(["instanceField", "localVariable"]);
    expect(rolesOf("size")).toEqual(["instanceField"]);
  });

  it("colors parameters and local and global variables", () => {
    expect(rolesOf("item")).toEqual(["parameter"]);
    expect(rolesOf("param")).toEqual(["parameter"]);
    expect(rolesOf("local")).toEqual(["localVariable"]);
    expect(rolesOf("x")).toEqual(["localVariable"]);
    expect(rolesOf("a")).toEqual(["instanceField", "localVariable"]);
    expect(rolesOf("CONFIG")).toEqual(["globalVariable"]);
    expect(rolesOf("counter")).toEqual(["globalVariable"]);
  });

  it("colors imports by the role of their target", () => {
    expect(rolesOf("Repo")).toEqual(["class"]);
    expect(rolesOf("Entity")).toEqual(["class"]);
    expect(rolesOf("Shape")).toEqual(["interface"]);
    expect(rolesOf("helper")).toEqual(["globalFunction"]);
    expect(rolesOf("mod")).toEqual(["moduleName"]);
  });

  it("colors unresolved imports by the roles passed in and reports those without one", () => {
    expect(rolesOf("External")).toEqual(["interface"]);
    expect(rolesOf("Renamed")).toEqual(["enum"]);
    expect(rolesOf("Missing")).toEqual([]);
    expect(rolesOf("Unknown")).toEqual([]);
    expect(unresolvedImports).toEqual([{ key: "@scope/missing\0Unknown", text: "Unknown" }]);
  });

  it("colors decorator heads as metadata and their arguments normally", () => {
    expect(rolesOf("Deco")).toEqual(["globalVariable", "metadata"]);
    expect(rolesOf("table")).toEqual(["metadata"]);
    expect(classified.filter((entry) => entry.role === "metadata").map((entry) => entry.text)).toEqual(["Deco", "table", "Deco"]);
    expect(rolesOf("name")).toEqual(["instanceField"]);
    expect(rolesOf("field")).toEqual(["instanceField"]);
  });

  it("colors labels", () => {
    expect(classified.filter((entry) => entry.text === "outer")).toEqual([{ text: "outer", role: "label" }, { text: "outer", role: "label" }]);
  });

  it("colors built-ins as global variables, those merged with an interface as classes, and their interfaces where a type is expected", () => {
    expect(rolesOf("console")).toEqual(["globalVariable"]);
    expect(rolesOf("Promise")).toEqual(["class", "interface"]);
    expect(rolesOf("pending")).toEqual(["localVariable"]);
    expect(rolesOf("Math")).toEqual(["class"]);
    expect(rolesOf("log")).toEqual(["instanceMethod"]);
  });

  it("colors variables of declaration files as global variables, capitalized or not", () => {
    expect(rolesOf("APP_VERSION")).toEqual(["globalVariable"]);
  });

  it("skips property access on any", () => {
    expect(rolesOf("anyValue")).toEqual(["localVariable"]);
    expect(rolesOf("whatever")).toEqual([]);
  });

  it("colors a shorthand property by its value", () => {
    expect(rolesOf("obj")).toEqual(["localVariable"]);
    expect(classified.filter((entry) => entry.text === "em").map((entry) => entry.role)).toEqual(["instanceField", "instanceField", "localVariable", "localVariable"]);
  });
});

describe("roleOfImportHover", () => {
  it("reads the kind of an import from the language server's hover", () => {
    expect(roleOfImportHover("(alias) interface CreateHospitalCaseForAnalysis")).toBe("interface");
    expect(roleOfImportHover("(alias) class HospitalCaseForAnalysis")).toBe("class");
    expect(roleOfImportHover("(alias) abstract class Base<T>")).toBe("class");
    expect(roleOfImportHover("(alias) type Id = string")).toBe("typeAlias");
    expect(roleOfImportHover("(alias) enum MlCodeType")).toBe("enum");
    expect(roleOfImportHover("(alias) const enum Flags")).toBe("enum");
    expect(roleOfImportHover("(alias) function helper(): void")).toBe("globalFunction");
    expect(roleOfImportHover("(alias) namespace Api")).toBe("moduleName");
  });

  it("colors imported variables as global variables, like their declarations", () => {
    expect(roleOfImportHover("(alias) const BackendBaseConfig: { APP_NAME: string }\nimport BackendBaseConfig")).toBe("globalVariable");
    expect(roleOfImportHover("(alias) const describe: SuiteAPI")).toBe("globalVariable");
    expect(roleOfImportHover("(alias) let counter: number")).toBe("globalVariable");
    expect(roleOfImportHover("(alias) interface Component\n(alias) const Component: ComponentDecorator")).toBe("interface");
  });

  it("leaves other text without a role", () => {
    expect(roleOfImportHover("interface Local")).toBeNull();
    expect(roleOfImportHover("const local: number")).toBeNull();
  });
});
