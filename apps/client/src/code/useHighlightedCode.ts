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

/**
 * The grammars of `languages` that are loaded, so `tokenizeCode` can color their lines; the missing ones are loaded
 * and a new set is returned as each one arrives. Languages without a grammar never show up in it.
 */
export function useLoadedTokenizers(languages: readonly string[]): ReadonlySet<string> {
  const key = [...new Set(languages)].sort().join(" ");
  const [loadedHere, setLoadedHere] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    for (const language of key.split(" ")) {
      if (!language || hasTokenizer(language)) continue;
      // A loaded grammar stays loaded, so a late result is still true and needs no staleness check.
      void loadTokenizer(language).then((isLoaded) => {
        if (isLoaded) {
          setLoadedHere((current) => new Set(current).add(language));
        }
      });
    }
  }, [key]);

  return useMemo(() => new Set([...loadedHere, ...key.split(" ").filter((language) => language && hasTokenizer(language))]), [key, loadedHere]);
}
