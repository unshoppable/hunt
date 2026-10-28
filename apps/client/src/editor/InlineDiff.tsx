import { useEffect, useMemo, useState } from "react";
import { DiffFile, DiffModeEnum, DiffView } from "@git-diff-view/react";
import { generateDiffFile } from "@git-diff-view/file";
import type { DiffFileHighlighter } from "@git-diff-view/core";
import { prepareDiffHighlighter } from "./diff-highlighter.utils";
import { useSettingsStore } from "../settings/settings.store";
import { monacoLanguage } from "./language-id.utils";

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
  return (
    <div className="overflow-hidden rounded border border-(--line)">
      {showHeader ? (
        <div className="truncate border-b border-(--line) bg-(--surface-inset) px-3 py-1.5 font-mono text-[13px] text-neutral-300">{path}</div>
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
    void prepareDiffHighlighter(language, path, [oldContent, newContent]).then((prepared) => {
      if (isLive) {
        setHighlighter(prepared);
      }
    });
    return () => {
      isLive = false;
    };
  }, [language, path, oldContent, newContent]);

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
