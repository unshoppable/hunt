import { useEffect, useMemo, useState } from "react";
import { DiffModeEnum, DiffView } from "@git-diff-view/react";
import { generateDiffFile } from "@git-diff-view/file";
import type { DiffFileHighlighter } from "@git-diff-view/core";
import { prepareDiffHighlighter } from "../code/diffHighlighter";
import { useSettingsStore } from "../state/settings";
import { monacoLanguage } from "./monaco";

/**
 * Compact diff for one tool call: old and new text come straight from the ACP `diff` content block. Lines are
 * colored like the Monaco editors once the highlighter is prepared (see diffHighlighter.ts) and plain before.
 */
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
  // Tool activity in the chat is monospace at 0.85em of the chat font (see .chat-mono in index.css).
  const diffFontSize = useSettingsStore((state) => Math.round(state.panes.chat.fontSize * 0.85));
  const language = monacoLanguage(path);
  const [highlighter, setHighlighter] = useState<DiffFileHighlighter | null>(null);

  useEffect(() => {
    let isLive = true;
    void prepareDiffHighlighter(language, path, [oldText, newText]).then((prepared) => {
      if (isLive) {
        setHighlighter(prepared);
      }
    });
    return () => {
      isLive = false;
    };
  }, [language, path, oldText, newText]);

  const file = useMemo(() => {
    const diffFile = generateDiffFile(path, oldText, path, newText, language, language);
    diffFile.initTheme("dark");
    diffFile.initRaw();
    if (highlighter) {
      diffFile.initSyntax({ registerHighlighter: highlighter });
    }
    diffFile.buildUnifiedDiffLines();
    return diffFile;
  }, [path, oldText, newText, language, highlighter]);

  return (
    <div className="overflow-hidden rounded border border-(--line)">
      {showHeader ? (
        <div className="truncate border-b border-(--line) bg-(--surface-inset) px-3 py-1.5 font-mono text-[13px] text-neutral-300">{path}</div>
      ) : null}
      <div className="max-h-80 overflow-auto">
        <DiffView
          diffFile={file}
          diffViewMode={DiffModeEnum.Unified}
          diffViewTheme="dark"
          diffViewHighlight={highlighter !== null}
          registerHighlighter={highlighter ?? undefined}
          diffViewFontSize={diffFontSize}
        />
      </div>
    </div>
  );
}
