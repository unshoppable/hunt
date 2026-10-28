import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type * as monaco from "monaco-editor";
import { onDidRefreshSemanticTokens, type SemanticSpan } from "./semantic-tokens.monaco";
import { applySemanticSpans, classifyCode, classifyExcerpt, hasSemanticColors, hasTokenizer, loadTokenizer, tokenizeCode, type HighlightedLine } from "./highlight.monaco";

/**
 * Loads the model of a worktree file by its worktree-relative path, so code copied from that file is colored with the
 * roles its names have in the whole file (see `useHighlightedCode`). Null where no local worktree backs the code.
 */
export const FileModelContext = createContext<((path: string) => Promise<monaco.editor.ITextModel>) | null>(null);

/**
 * Lines of `text` colored like the Monaco editors: grammar colors as soon as the grammar is loaded, semantic
 * colors for TypeScript and JavaScript once the worker answered. Text copied from the lines of a worktree file starting
 * at `startLine` of `path` takes its semantic colors from the whole file when `FileModelContext` provides it and the
 * lines still match, so imported names get the colors of their declarations. Null while the grammar loads or when the
 * language has none, so the caller shows plain text.
 */
export function useHighlightedCode(text: string, language: string, path?: string, startLine?: number): HighlightedLine[] | null {
  const loadFileModel = useContext(FileModelContext);
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
    const fileModel = loadFileModel && path && startLine && hasSemanticColors(language) ? loadFileModel(path).catch(() => null) : null;
    const classify = async () => {
      const model = await fileModel;
      const spans = (model && startLine ? await classifyExcerpt(text, model, startLine) : null) ?? (await classifyCode(text, language, path));
      if (isLive && spans.length) {
        setSemantic({ text, spans });
      }
    };
    void classify();
    // The file's imports resolve in the background; their roles arrive with a refresh. Refreshes come in bursts while
    // the files of a chat load, so a burst classifies once.
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const refresh = fileModel
      ? onDidRefreshSemanticTokens(() => {
          clearTimeout(refreshTimer);
          refreshTimer = setTimeout(() => void classify(), 250);
        })
      : null;
    return () => {
      isLive = false;
      clearTimeout(refreshTimer);
      refresh?.dispose();
    };
  }, [text, language, path, startLine, isLoaded, loadFileModel]);

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
