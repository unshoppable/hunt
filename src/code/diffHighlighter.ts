import type { DiffAST, DiffFileHighlighter, SyntaxLine, SyntaxNode } from "@git-diff-view/core";
import type { SemanticSpan } from "../diff/semanticTokens";
import { applySemanticSpans, classifyCode, loadTokenizer, tokenizeCode, type HighlightedLine } from "./highlight";
import { tokenStyleAttribute } from "./tokenStyle";

/** What `getAST` hands to `processAST`; git-diff-view only passes it through. */
type HighlightedFile = { lines: HighlightedLine[] };

/**
 * Highlighter for git-diff-view that colors diff lines with the grammar and theme of the Monaco editors.
 * git-diff-view calls it synchronously, so the grammar must be loaded and the semantic classifications of each
 * side's content computed beforehand: `prepareDiffHighlighter` does both.
 */
function createDiffHighlighter(semanticSpans: Map<string, SemanticSpan[]>): DiffFileHighlighter {
  return {
    name: "monaco",
    type: "style",
    maxLineToIgnoreSyntax: 5000,
    setMaxLineToIgnoreSyntax: () => {},
    ignoreSyntaxHighlightList: [],
    setIgnoreSyntaxHighlightList: () => {},
    // Languages without a grammar yield no AST and render plain instead of falling back to git-diff-view's own highlighter.
    hasRegisteredCurrentLang: () => true,
    getAST: (raw, _fileName, lang) => {
      const lines = tokenizeCode(raw, lang ?? "plaintext");
      if (!lines) return undefined as unknown as DiffAST;
      const file: HighlightedFile = { lines: applySemanticSpans(lines, raw, semanticSpans.get(raw) ?? []) };
      return file as unknown as DiffAST;
    },
    processAST: (ast) => {
      const { lines } = ast as unknown as HighlightedFile;
      const syntaxFileObject: Record<number, SyntaxLine> = {};
      lines.forEach((runs, index) => {
        const lineNumber = index + 1;
        const nodeList: SyntaxLine["nodeList"] = [];
        let offset = 0;
        // git-diff-view expects each line's value to end with its newline, like the raw lines it compares against.
        const texts = runs.map((run) => run.text);
        const newline = index < lines.length - 1 ? "\n" : "";
        if (texts.length) {
          texts[texts.length - 1] += newline;
        } else if (newline) {
          texts.push(newline);
        }
        texts.forEach((value, runIndex) => {
          const node: SyntaxNode = { type: "text", value, lineNumber, startIndex: offset, endIndex: offset + value.length - 1 };
          const run = runs[runIndex];
          const wrapper: SyntaxNode | undefined = run
            ? { type: "element", value: "", lineNumber, startIndex: node.startIndex, endIndex: node.endIndex, properties: { style: tokenStyleAttribute(run.style) } }
            : undefined;
          nodeList.push({ node, wrapper });
          offset += value.length;
        });
        const value = texts.join("");
        syntaxFileObject[lineNumber] = { value, lineNumber, valueLength: value.length, nodeList };
      });
      return { syntaxFileObject, syntaxFileLineNumber: lines.length };
    },
  };
}

/** Loads the grammar of `language` and classifies each text (see classifyCode), then builds the highlighter for them. */
export async function prepareDiffHighlighter(language: string, path: string, texts: string[]): Promise<DiffFileHighlighter> {
  await loadTokenizer(language);
  const semanticSpans = new Map<string, SemanticSpan[]>();
  for (const text of texts) {
    if (semanticSpans.has(text)) continue;
    semanticSpans.set(text, await classifyCode(text, language, path));
  }
  return createDiffHighlighter(semanticSpans);
}
