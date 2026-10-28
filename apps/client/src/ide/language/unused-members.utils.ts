import type * as tsTypes from "typescript";
import { rangeContains, type Location, type Range } from "../lsp/lsp-protocol.utils";
import { uriKey } from "./usages.utils";

type TypeScriptApi = typeof tsTypes;

/** Offsets of a declared name in its file. */
export type NameSpan = { start: number; end: number };

/** A class member whose usages the editor looks up; the declarations of one member are its overloads or its accessor pair. */
export type MemberCandidate = {
  name: string;
  kind: "property" | "method";
  declarations: NameSpan[];
};

/**
 * Members a framework or the runtime calls by name, so they have no references in the code: Angular's and NestJS's
 * lifecycle hooks (also without `implements`) and the conversions JavaScript calls implicitly.
 */
const IMPLICITLY_CALLED = new Set([
  "ngOnChanges",
  "ngOnInit",
  "ngDoCheck",
  "ngAfterContentInit",
  "ngAfterContentChecked",
  "ngAfterViewInit",
  "ngAfterViewChecked",
  "ngOnDestroy",
  "onModuleInit",
  "onModuleDestroy",
  "onApplicationBootstrap",
  "beforeApplicationShutdown",
  "onApplicationShutdown",
  "toJSON",
  "toString",
  "valueOf",
]);

/**
 * The public and protected members of the classes in `sourceFile` that may be unused: properties (also parameter
 * properties), methods and accessors with a plain name. Left out are private members (TypeScript reports those itself),
 * members a framework or the runtime calls (decorated ones, lifecycle hooks), `override`, `abstract` and `declare`
 * members, and the members of `declare` classes and declaration files. Uses only the stable public API, so it runs
 * against Monaco's bundled TypeScript as well as the project's.
 */
export function unusedMemberCandidates(ts: TypeScriptApi, sourceFile: tsTypes.SourceFile): MemberCandidate[] {
  if (sourceFile.isDeclarationFile) return [];
  const candidates: MemberCandidate[] = [];
  const visit = (node: tsTypes.Node) => {
    if ((ts.isClassDeclaration(node) || ts.isClassExpression(node)) && !hasModifier(ts, node, ts.SyntaxKind.DeclareKeyword)) {
      candidates.push(...classCandidates(ts, node, sourceFile));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return candidates;
}

/** The candidates of one class; overloads and accessor pairs are grouped by name and staticness. */
function classCandidates(ts: TypeScriptApi, node: tsTypes.ClassLikeDeclaration, sourceFile: tsTypes.SourceFile): MemberCandidate[] {
  const groups = new Map<string, { candidate: MemberCandidate; isExcluded: boolean }>();
  const add = (member: tsTypes.ClassElement | tsTypes.ParameterDeclaration, name: tsTypes.Identifier, kind: MemberCandidate["kind"]) => {
    const key = `${hasModifier(ts, member, ts.SyntaxKind.StaticKeyword) ? "static " : ""}${name.text}`;
    let group = groups.get(key);
    if (!group) {
      group = { candidate: { name: name.text, kind, declarations: [] }, isExcluded: false };
      groups.set(key, group);
    }
    group.candidate.declarations.push({ start: name.getStart(sourceFile), end: name.getEnd() });
    group.isExcluded ||= isExcluded(ts, member, name.text);
  };

  for (const member of node.members) {
    if (ts.isConstructorDeclaration(member)) {
      for (const parameter of member.parameters) {
        if (ts.isParameterPropertyDeclaration(parameter, member) && ts.isIdentifier(parameter.name)) {
          add(parameter, parameter.name, "property");
        }
      }
      continue;
    }
    if (!member.name || !ts.isIdentifier(member.name)) continue;
    if (ts.isMethodDeclaration(member)) {
      add(member, member.name, "method");
    } else if (ts.isPropertyDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
      add(member, member.name, "property");
    }
  }
  return [...groups.values()].filter((group) => !group.isExcluded).map((group) => group.candidate);
}

function isExcluded(ts: TypeScriptApi, member: tsTypes.ClassElement | tsTypes.ParameterDeclaration, name: string): boolean {
  if (IMPLICITLY_CALLED.has(name)) return true;
  if (ts.canHaveDecorators(member) && ts.getDecorators(member)?.length) return true;
  const excludingModifiers = [ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.OverrideKeyword, ts.SyntaxKind.AbstractKeyword, ts.SyntaxKind.DeclareKeyword];
  return excludingModifiers.some((modifier) => hasModifier(ts, member, modifier));
}

function hasModifier(ts: TypeScriptApi, node: tsTypes.Node, kind: tsTypes.SyntaxKind): boolean {
  return !!ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some((modifier) => modifier.kind === kind);
}

/**
 * Whether `references` (asked with `includeDeclaration: true`) hold nothing but the member's own `declarations` in
 * the document `uri`. The TypeScript server adds the declarations of interface and base class members the member
 * implements or overrides, so those count as usages.
 */
export function isOnlyDeclaration(references: readonly Location[], uri: string, declarations: readonly Range[]): boolean {
  const documentKey = uriKey(uri);
  return references.every(
    (reference) => uriKey(reference.uri) === documentKey && declarations.some((declaration) => rangeContains(declaration, reference.range.start)),
  );
}

/**
 * The worktree path of the template beside the source file `path` (`list.component.ts` → `list.component.html`), where
 * a base class's template lives even when only subclasses of other projects use it, out of the Angular server's reach.
 * Null for files other than `.ts`.
 */
export function siblingTemplatePath(path: string): string | null {
  return /\.ts$/.test(path) ? path.replace(/\.ts$/, ".html") : null;
}

/** The hover text of an unused member's marker, worded like WebStorm's: `Unused property 'displayByName'`. */
export function unusedMemberMessage(candidate: MemberCandidate): string {
  return `Unused ${candidate.kind} '${candidate.name}'`;
}
