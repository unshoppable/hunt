import { useContext, useEffect, useMemo, useState } from "react";
import { DiffFile, DiffModeEnum, DiffView } from "@git-diff-view/react";
import { generateDiffFile } from "@git-diff-view/file";
import type { DiffFileHighlighter } from "@git-diff-view/core";
import { prepareDiffHighlighter } from "./diff-highlighter.utils";
import { FileModelContext } from "./highlighted-code.hook";
import { hasSemanticColors } from "./highlight.monaco";
import { onDidRefreshSemanticTokens } from "./semantic-tokens.monaco";
import { useSettingsStore } from "../settings/settings.store";
import { monacoLanguage } from "./language-id.utils";
import { useFileIconUrl } from "../ui/file-icons/file-icons.hook";

/** Compact diff for one tool call: old and new text come straight from the ACP `diff` content block. */
export function InlineDiff({
  path,
  oldText,
  newText,
  showHeader = true,
}: {
  path: string;
  oldText: string;
  newText: string;
  /** The chat hides the path header because the tool line above already names the file. */
  showHeader?: boolean;
}) {
  const fileIconUrl = useFileIconUrl();
  return (
    <div className="overflow-hidden rounded border border-(--line)">
      {showHeader ? (
        <div className="flex items-center gap-1.5 border-b border-(--line) bg-(--surface-inset) px-3 py-1.5 font-mono text-[13px] text-neutral-300">
          <img src={fileIconUrl(path)} alt="" className="size-4 shrink-0" />
          <span className="min-w-0 truncate">{path}</span>
        </div>
      ) : null}
      <div className="max-h-80 overflow-auto">
        <HighlightedDiff path={path} oldText={oldText} newText={newText} />
      </div>
    </div>
  );
}

/**
 * Unified diff of `path`, built from both texts or from a unified-diff `patch` whose hunk headers give the line numbers.
 * Lines are colored like the Monaco editors once the highlighter is prepared (see diff-highlighter.utils.ts) and plain
 * before.
 */
export function HighlightedDiff({
  path,
  oldText,
  newText,
  patch,
}: { path: string } & ({ oldText: string; newText: string; patch?: never } | { patch: string; oldText?: never; newText?: never })) {
  // Tool activity in the chat is monospace at 0.85em of the chat font (see .chat-mono in index.css).
  const diffFontSize = useSettingsStore((state) => Math.round(state.panes.chat.fontSize * 0.85));
  const language = monacoLanguage(path);
  const loadFileModel = useContext(FileModelContext);
  const [highlighter, setHighlighter] = useState<DiffFileHighlighter | null>(null);

  const file = useMemo(() => {
    const diffFile =
      patch === undefined ? generateDiffFile(path, oldText, path, newText, language, language) : new DiffFile(path, "", path, "", [patch], language, language);
    diffFile.initTheme("dark");
    diffFile.initRaw();
    if (highlighter) {
      diffFile.initSyntax({ registerHighlighter: highlighter });
    }
    diffFile.buildUnifiedDiffLines();
    return diffFile;
  }, [path, oldText, newText, patch, language, highlighter]);
  // A patch carries only its hunks: git-diff-view composes both sides from them, and the highlighter colors those.
  const oldContent = file.getOldFileContent();
  const newContent = file.getNewFileContent();

  useEffect(() => {
    let isLive = true;
    const fileModel = loadFileModel && path && hasSemanticColors(language) ? loadFileModel(path).catch(() => null) : null;
    const prepare = async () => {
      const prepared = await prepareDiffHighlighter(language, path, [oldContent, newContent], await fileModel);
      if (isLive) {
        setHighlighter(prepared);
      }
    };
    void prepare();
    // The file's imports resolve in the background; their roles arrive with a refresh, in bursts.
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const refresh = fileModel
      ? onDidRefreshSemanticTokens(() => {
          clearTimeout(refreshTimer);
          refreshTimer = setTimeout(() => void prepare(), 250);
        })
      : null;
    return () => {
      isLive = false;
      clearTimeout(refreshTimer);
      refresh?.dispose();
    };
  }, [language, path, oldContent, newContent, loadFileModel]);

  return (
    <DiffView
      diffFile={file}
      diffViewMode={DiffModeEnum.Unified}
      diffViewTheme="dark"
      diffViewHighlight={highlighter !== null}
      registerHighlighter={highlighter ?? undefined}
      diffViewFontSize={diffFontSize}
    />
  );
}
