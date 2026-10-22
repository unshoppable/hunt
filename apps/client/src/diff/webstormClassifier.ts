import type * as tsTypes from "typescript";
import { WEBSTORM_ROLES, type WebstormRole } from "./webstormRoles";

type TypeScriptApi = typeof tsTypes;

/** Role ids by role name (the index in `WEBSTORM_ROLES`). */
const ROLE = Object.fromEntries(WEBSTORM_ROLES.map((role, index) => [role, index])) as Record<WebstormRole, number>;

/**
 * An import binding whose target the checker cannot resolve (a path alias or package outside the program): `key`
 * names the imported binding (`<module specifier>\0<imported name>`, `default` or `*`), `offset` is where its local
 * name starts in the import, the position to ask the language server about.
 */
export type UnresolvedImport = { key: string; offset: number };

export type WebstormClassification = {
  /** Flat `[start, length, roleId, …]` triples in source order. */
  classifications: number[];
  /** Unresolved imports without an entry in `importRoles`, one per key. */
  unresolvedImports: UnresolvedImport[];
};

/**
 * Classifies the identifiers of `sourceFile` with the roles WebStorm colors (see webstormRoles.ts), resolving each
 * through `checker` in one AST walk; `start` and `length` of the triples are UTF-16 offsets within the file.
 * Identifiers without a symbol (property access on `any`), `undefined`/`arguments`, JSX tag and attribute names, and
 * declaration kinds without a role emit nothing. Unresolved imports take their role id from `importRoles` by key
 * (-1: none) and are reported when it has no entry. Uses only the stable public API, so it runs against Monaco's
 * bundled TypeScript as well as the project's.
 */
export function classifyWebstorm(
  ts: TypeScriptApi,
  sourceFile: tsTypes.SourceFile,
  checker: tsTypes.TypeChecker,
  importRoles: Readonly<Record<string, number>> = {},
): WebstormClassification {
  const result: number[] = [];
  const unresolvedImports = new Map<string, UnresolvedImport>();

  const emit = (node: tsTypes.Node, role: number): void => {
    result.push(node.getStart(sourceFile), node.getWidth(sourceFile), role);
  };

  /** Marks the name chain of a decorator head (`Foo`, `Foo.bar`) as metadata in source order; anything else is classified normally. */
  const visitDecoratorHead = (head: tsTypes.Expression): void => {
    if (ts.isIdentifier(head)) {
      emit(head, ROLE.metadata);
    } else if (ts.isPropertyAccessExpression(head)) {
      visitDecoratorHead(head.expression);
      emit(head.name, ROLE.metadata);
    } else {
      visit(head);
    }
  };

  /** Marks the callee of a decorator (`@Foo`, `@Foo.bar(…)`) as metadata and classifies its arguments normally. */
  const visitDecorator = (decorator: tsTypes.Decorator): void => {
    const expression = decorator.expression;
    if (!ts.isCallExpression(expression)) {
      visitDecoratorHead(expression);
      return;
    }
    visitDecoratorHead(expression.expression);
    expression.typeArguments?.forEach(visit);
    expression.arguments.forEach(visit);
  };

  const classifyIdentifier = (node: tsTypes.Identifier | tsTypes.PrivateIdentifier): void => {
    const parent = node.parent;
    if ((ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) && parent.label === node) {
      emit(node, ROLE.label);
      return;
    }

    let symbol = ts.isShorthandPropertyAssignment(parent) && parent.name === node ? checker.getShorthandAssignmentValueSymbol(parent) : undefined;
    symbol ??= checker.getSymbolAtLocation(node);
    if (!symbol) return;
    if (symbol.flags & ts.SymbolFlags.Alias) {
      const target = checker.getAliasedSymbol(symbol);
      if (!target.declarations?.length) {
        classifyUnresolvedImport(node, symbol);
        return;
      }
      symbol = target;
    }
    if (!symbol.declarations?.length) return;

    const role = roleOf(ts, symbol, node);
    if (role >= 0) {
      emit(node, role);
    }
  };

  const classifyUnresolvedImport = (node: tsTypes.Node, alias: tsTypes.Symbol): void => {
    const declaration = alias.declarations?.[0];
    const key = declaration && importKey(ts, declaration);
    if (!declaration || !key) return;
    const role = importRoles[key];
    if (role === undefined) {
      const name = (declaration as tsTypes.NamedDeclaration).name;
      if (name && !unresolvedImports.has(key)) {
        unresolvedImports.set(key, { key, offset: name.getStart(sourceFile) });
      }
      return;
    }
    if (role >= 0) {
      emit(node, role);
    }
  };

  const visit = (node: tsTypes.Node): void => {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
      classifyIdentifier(node);
      return;
    }
    if (ts.isDecorator(node)) {
      visitDecorator(node);
      return;
    }
    if (ts.isJsxAttribute(node)) {
      if (node.initializer) {
        visit(node.initializer);
      }
      return;
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      node.typeArguments?.forEach(visit);
      visit(node.attributes);
      return;
    }
    if (ts.isJsxClosingElement(node)) return;
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sourceFile, visit);
  return { classifications: result, unresolvedImports: [...unresolvedImports.values()] };
}

/** The key of an import or re-export binding (see `UnresolvedImport`), or null for other alias declarations. */
function importKey(ts: TypeScriptApi, declaration: tsTypes.Declaration): string | null {
  let importedName: string;
  if (ts.isImportSpecifier(declaration) || ts.isExportSpecifier(declaration)) {
    importedName = (declaration.propertyName ?? declaration.name).text;
  } else if (ts.isImportClause(declaration)) {
    importedName = "default";
  } else if (ts.isNamespaceImport(declaration)) {
    importedName = "*";
  } else {
    return null;
  }
  let statement: tsTypes.Node = declaration;
  while (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) {
    statement = statement.parent;
  }
  const moduleSpecifier = statement.moduleSpecifier;
  return moduleSpecifier && ts.isStringLiteral(moduleSpecifier) ? `${moduleSpecifier.text}\0${importedName}` : null;
}

/**
 * The role of an import from the first line of the language server's hover on it (`(alias) interface Foo`,
 * `(alias) abstract class Bar<T>`), or null for kinds without a fixed role (variables, unknown text).
 */
export function roleOfImportHover(signature: string): WebstormRole | null {
  const kind = signature.match(/^\(alias\) (?:declare )?(?:abstract )?(?:const )?(class|interface|type|enum|function|namespace|module)\b/)?.[1];
  if (kind === "class") return "class";
  if (kind === "interface") return "interface";
  if (kind === "type") return "typeAlias";
  if (kind === "enum") return "enum";
  if (kind === "function") return "globalFunction";
  if (kind === "namespace" || kind === "module") return "moduleName";
  return null;
}

/** The role of a resolved symbol as `node` refers to it, or -1 when its declaration kind has none. */
function roleOf(ts: TypeScriptApi, symbol: tsTypes.Symbol, node: tsTypes.Node): number {
  const flags = symbol.flags;
  if (flags & ts.SymbolFlags.Class) return ROLE.class;
  const valueDeclaration = symbol.valueDeclaration ?? symbol.declarations![0];
  // Built-in values (`console`, `Math`, `Promise`) are variables merged with interfaces in the lib files; where a
  // type is expected (`Promise<T>`, `implements Iterable<T>`) the merged interface is meant.
  if (flags & ts.SymbolFlags.Interface && isTypePosition(ts, node)) return ROLE.interface;
  if (flags & ts.SymbolFlags.Variable && valueDeclaration.getSourceFile().isDeclarationFile && !ts.isParameter(valueDeclaration)) {
    return isCapitalized(node) ? ROLE.class : ROLE.globalVariable;
  }
  if (flags & ts.SymbolFlags.Interface) return ROLE.interface;
  if (flags & ts.SymbolFlags.Enum) return ROLE.enum;
  if (flags & ts.SymbolFlags.TypeAlias) return ROLE.typeAlias;
  if (flags & ts.SymbolFlags.TypeParameter) return ROLE.typeParameter;
  if (flags & ts.SymbolFlags.EnumMember) return ROLE.enumMember;
  if (flags & (ts.SymbolFlags.ValueModule | ts.SymbolFlags.NamespaceModule)) return ROLE.moduleName;
  if (flags & ts.SymbolFlags.Function) return isTopLevel(ts, valueDeclaration) ? ROLE.globalFunction : ROLE.localFunction;
  const methodFlags = ts.SymbolFlags.Method | ts.SymbolFlags.Constructor | ts.SymbolFlags.GetAccessor | ts.SymbolFlags.SetAccessor;
  if (flags & methodFlags) return hasStaticModifier(ts, symbol.declarations!) ? ROLE.staticMethod : ROLE.instanceMethod;
  if (flags & ts.SymbolFlags.Property) return hasStaticModifier(ts, symbol.declarations!) ? ROLE.staticField : ROLE.instanceField;
  if (flags & ts.SymbolFlags.Variable) return variableRole(ts, valueDeclaration);
  return -1;
}

/** Whether `node` names a type: the name of a type reference or of an `implements` clause entry. */
function isTypePosition(ts: TypeScriptApi, node: tsTypes.Node): boolean {
  const parent = node.parent;
  if (ts.isTypeReferenceNode(parent)) return parent.typeName === node;
  if (ts.isExpressionWithTypeArguments(parent) && ts.isHeritageClause(parent.parent)) return parent.parent.token === ts.SyntaxKind.ImplementsKeyword;
  return false;
}

/** Whether `declaration` sits directly in a source file or a namespace body. */
function isTopLevel(ts: TypeScriptApi, declaration: tsTypes.Node): boolean {
  const parent = declaration.parent;
  return !!parent && (ts.isSourceFile(parent) || ts.isModuleBlock(parent));
}

function hasStaticModifier(ts: TypeScriptApi, declarations: readonly tsTypes.Declaration[]): boolean {
  for (const declaration of declarations) {
    if (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Static) return true;
  }
  return false;
}

/** Parameter, global or local variable by the declaration a variable symbol (or the root of its binding pattern) comes from. */
function variableRole(ts: TypeScriptApi, declaration: tsTypes.Node): number {
  let root = declaration;
  while (ts.isBindingElement(root) || ts.isObjectBindingPattern(root) || ts.isArrayBindingPattern(root)) {
    root = root.parent;
  }
  if (ts.isParameter(root)) return ROLE.parameter;
  if (ts.isVariableDeclaration(root) && ts.isVariableStatement(root.parent.parent) && isTopLevel(ts, root.parent.parent)) return ROLE.globalVariable;
  return ROLE.localVariable;
}

/** Whether the identifier starts with an uppercase ASCII letter (`Promise`, `Math`, `JSON`). */
function isCapitalized(node: tsTypes.Node): boolean {
  const first = node.getSourceFile().text.charCodeAt(node.getStart());
  return first >= 65 && first <= 90;
}
