import { useEffect, useRef, useState } from "react";
import type * as monaco from "monaco-editor";
import { classifyModel, onDidRefreshSemanticTokens } from "./semantic-tokens.monaco";
import { hasSemanticColors, type FileClassification } from "./highlight.monaco";
import { monacoLanguage } from "./language-id.utils";

/**
 * Semantic classifications of the TypeScript and JavaScript files among `paths`, by path, so lines a list quotes from them
 * get the colors of the editor (see `colorFileLine`). `loadFileModel` opens a worktree file with its imports (see
 * `FileModelContext`); without it the map stays empty. Each file is classified once per content and again when the roles
 * of imports come in (see `onDidRefreshSemanticTokens`); classifications of paths that leave `paths` are kept.
 */
export function useFileClassifications(
  loadFileModel: ((path: string) => Promise<monaco.editor.ITextModel>) | null,
  paths: readonly string[],
): ReadonlyMap<string, FileClassification> {
  const key = [...new Set(paths)].filter((path) => hasSemanticColors(monacoLanguage(path))).sort().join("\n");
  const [classifications, setClassifications] = useState<ReadonlyMap<string, FileClassification>>(() => new Map());
  /** The model version each path is classified, or being classified, at since the last refresh. */
  const classifiedVersions = useRef(new Map<string, number>());

  useEffect(() => {
    if (!loadFileModel || !key) return;
    let isLive = true;
    const models = new Map<string, monaco.editor.ITextModel>();
    const subscriptions: monaco.IDisposable[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let isRefreshed = false;

    const classify = async (path: string, model: monaco.editor.ITextModel) => {
      const version = model.getVersionId();
      if (classifiedVersions.current.get(path) === version) return;
      classifiedVersions.current.set(path, version);
      const spans = await classifyModel(model);
      if (!spans) {
        // The model changed meanwhile (its change classifies it again) or the worker failed: a later run may retry.
        if (classifiedVersions.current.get(path) === version) {
          classifiedVersions.current.delete(path);
        }
        return;
      }
      setClassifications((current) => new Map(current).set(path, { text: model.getValue(), spans }));
    };

    // Edits and refreshes come in bursts (typing, the imports of several files resolving), so a burst classifies once.
    const classifyLater = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (isRefreshed) {
          classifiedVersions.current.clear();
          isRefreshed = false;
        }
        for (const [path, model] of models) {
          void classify(path, model);
        }
      }, 250);
    };

    for (const path of key.split("\n")) {
      loadFileModel(path).then(
        (model) => {
          if (!isLive) return;
          models.set(path, model);
          subscriptions.push(model.onDidChangeContent(classifyLater));
          void classify(path, model);
        },
        () => {},
      );
    }
    subscriptions.push(
      onDidRefreshSemanticTokens(() => {
        isRefreshed = true;
        classifyLater();
      }),
    );
    return () => {
      isLive = false;
      clearTimeout(timer);
      for (const subscription of subscriptions) {
        subscription.dispose();
      }
    };
  }, [key, loadFileModel]);

  return classifications;
}
