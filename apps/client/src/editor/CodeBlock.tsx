import { Fragment } from "react";
import { tokenStyleDeclarations } from "./token-style.utils";
import { useHighlightedCode } from "./highlighted-code.hook";

/**
 * Preformatted code colored like the Monaco editors (see useHighlightedCode). `language` is a Monaco language id
 * (see monacoLanguage / monacoLanguageForFence); `path` refines TypeScript parsing (TSX) and, with `startLine` (the
 * 1-based line of `path` the text was copied from), lets the names take their colors from the whole file. Plain text
 * until the grammar is loaded and for languages without one.
 */
export function CodeBlock({ text, language, path, startLine, className }: { text: string; language: string; path?: string; startLine?: number; className?: string }) {
  const lines = useHighlightedCode(text, language, path, startLine);
  return (
    <pre className={className}>
      {lines
        ? lines.map((runs, index) => (
            <Fragment key={index}>
              {index > 0 ? "\n" : null}
              {runs.map((run, runIndex) => (
                <span key={runIndex} style={tokenStyleDeclarations(run.style)}>
                  {run.text}
                </span>
              ))}
            </Fragment>
          ))
        : text}
    </pre>
  );
}
