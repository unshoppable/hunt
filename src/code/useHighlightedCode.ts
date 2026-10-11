import { useEffect, useMemo, useState } from "react";
import type { SemanticSpan } from "../diff/semanticTokens";
import { applySemanticSpans, classifyCode, hasTokenizer, loadTokenizer, tokenizeCode, type HighlightedLine } from "./highlight";

/**
 * Lines of `text` colored like the Monaco editors: grammar colors as soon as the grammar is loaded, semantic
 * colors for TypeScript and JavaScript once the worker answered. Null while the grammar loads or when the
 * language has none, so the caller shows plain text.
 */
export function useHighlightedCode(text: string, language: string, path?: string): HighlightedLine[] | null {
  const [isLoaded, setIsLoaded] = useState(() => hasTokenizer(language));
  const [semantic, setSemantic] = useState<{ text: string; spans: SemanticSpan[] } | null>(null);

  useEffect(() => {
    if (hasTokenizer(language)) {
      setIsLoaded(true);
      return;
    }
    let isLive = true;
    void loadTokenizer(language).then((loaded) => {
      if (isLive) {
        setIsLoaded(loaded);
      }
    });
    return () => {
      isLive = false;
    };
  }, [language]);

  useEffect(() => {
    if (!isLoaded) return;
    let isLive = true;
    void classifyCode(text, language, path).then((spans) => {
      if (isLive && spans.length) {
        setSemantic({ text, spans });
      }
    });
    return () => {
      isLive = false;
    };
  }, [text, language, path, isLoaded]);

  return useMemo(() => {
    if (!isLoaded) return null;
    const lines = tokenizeCode(text, language);
    if (!lines) return null;
    return semantic?.text === text ? applySemanticSpans(lines, text, semantic.spans) : lines;
  }, [text, language, isLoaded, semantic]);
}
