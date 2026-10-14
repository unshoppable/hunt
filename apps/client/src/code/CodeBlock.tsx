import { Fragment } from "react";
import { tokenStyleDeclarations } from "./tokenStyle";
import { useHighlightedCode } from "./useHighlightedCode";

/**
 * Preformatted code colored like the Monaco editors (see useHighlightedCode). `language` is a Monaco language id
 * (see monacoLanguage / monacoLanguageForFence); `path` only refines TypeScript parsing (TSX). Plain text until the
 * grammar is loaded and for languages without one.
 */
export function CodeBlock({ text, language, path, className }: { text: string; language: string; path?: string; className?: string }) {
  const lines = useHighlightedCode(text, language, path);
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
