import type * as tsTypes from "typescript";

type TypeScriptApi = typeof tsTypes;

/**
 * Whether `offset` in `sourceFile` is where a member of an object literal or object destructuring pattern starts: the
 * last token before it is that object's `{` or one of its `,`, with only whitespace in between. Completion offers the
 * members of the object's type there, so the list may open before a word is typed. Blocks, type literals, import
 * braces, argument lists and arrays answer false, as do comments and strings. Uses only the stable public API, so it
 * runs against Monaco's bundled TypeScript as well as the project's.
 */
export function isObjectMemberPosition(ts: TypeScriptApi, sourceFile: tsTypes.SourceFile, offset: number): boolean {
  const token = lastTokenBefore(ts, sourceFile, sourceFile, offset);
  if (!token || (token.kind !== ts.SyntaxKind.OpenBraceToken && token.kind !== ts.SyntaxKind.CommaToken)) return false;
  if (token.getEnd() > offset || sourceFile.text.slice(token.getEnd(), offset).trim()) return false;
  // Commas sit in the SyntaxList of the object's members, the opening brace directly in the object.
  const container = token.parent?.kind === ts.SyntaxKind.SyntaxList ? token.parent.parent : token.parent;
  return container?.kind === ts.SyntaxKind.ObjectLiteralExpression || container?.kind === ts.SyntaxKind.ObjectBindingPattern;
}

/** The last token of `node` that starts before `offset`; it may still reach past `offset` (a word or string around it). */
function lastTokenBefore(ts: TypeScriptApi, node: tsTypes.Node, sourceFile: tsTypes.SourceFile, offset: number): tsTypes.Node | null {
  const children = node.getChildren(sourceFile);
  for (let index = children.length - 1; index >= 0; index--) {
    const child = children[index];
    if (child.pos === child.end || child.getStart(sourceFile) >= offset) continue;
    if (child.kind <= ts.SyntaxKind.LastToken) return child;
    const token = lastTokenBefore(ts, child, sourceFile, offset);
    if (token) return token;
  }
  return null;
}
