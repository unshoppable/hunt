import * as monaco from "monaco-editor";
import { CODE_FONT_FAMILY, UI_FONT_FAMILY } from "../settings/settings.store";

/** Monaco theme name: WebStorm's syntax colors (see webstorm-scheme.monaco.ts) on the diff pane's background. */
export const MONACO_THEME = "hunt-dark";

/**
 * Brackets keep the theme's punctuation color like in WebStorm instead of Monaco's rainbow pairs. Only this dotted
 * configuration key reaches the text models (the nested `bracketPairColorization` option object is dropped on the way).
 */
const BRACKET_PAIR_COLORS_OFF = { "bracketPairColorization.enabled": false } as monaco.editor.IStandaloneEditorConstructionOptions;

/**
 * Options shared by every Monaco editor to look like WebStorm: the code font with ligatures (a `lineHeight` below 8
 * is a multiple of the font size), semantic highlighting (see semantic-tokens.monaco.ts), plain bracket colors and inlay
 * hints in the UI font.
 */
export const EDITOR_APPEARANCE_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  fontFamily: CODE_FONT_FAMILY,
  fontLigatures: true,
  lineHeight: 2,
  "semanticHighlighting.enabled": true,
  inlayHints: { fontFamily: UI_FONT_FAMILY, padding: true },
  ...BRACKET_PAIR_COLORS_OFF,
};

/**
 * Options of a read-only code preview without editor chrome (no minimap, rulers, folding, glyph margin, sticky scroll,
 * context menu or links), on top of the shared appearance. Font size, family and line height come from the caller.
 */
export const PREVIEW_EDITOR_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  ...EDITOR_APPEARANCE_OPTIONS,
  theme: MONACO_THEME,
  readOnly: true,
  domReadOnly: true,
  automaticLayout: true,
  glyphMargin: false,
  folding: false,
  minimap: { enabled: false },
  overviewRulerLanes: 0,
  hideCursorInOverviewRuler: true,
  overviewRulerBorder: false,
  renderLineHighlight: "line",
  scrollBeyondLastLine: false,
  scrollbar: { alwaysConsumeMouseWheel: false, useShadows: false },
  stickyScroll: { enabled: false },
  // Hints would widen a line after it was scrolled into view; WebStorm's previews show none either.
  inlayHints: { enabled: "off" },
  contextmenu: false,
  links: false,
  wordWrap: "off",
};

/**
 * Completion like WebStorm's for every editable code editor (the IDE editor, a diff's right side): the list opens while
 * typing in code and in strings (import paths), word-based guesses never mix into the language server's list, and it
 * grows wide enough for the types at the right of its rows. See ide/lsp/lsp-providers.monaco.ts for what opens it and what its
 * rows show, and `setUpCompletionList` for keys, row height and the docs column.
 */
export const COMPLETION_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  quickSuggestions: { other: "on", comments: "off", strings: "on" },
  wordBasedSuggestions: "off",
  // Monaco validates `fitWidthToDetails` but leaves it out of its typings.
  suggest: { showStatusBar: false, showInlineDetails: true, preview: false, fitWidthToDetails: true } as monaco.editor.ISuggestOptions,
  suggestOnTriggerCharacters: true,
  acceptSuggestionOnCommitCharacter: true,
  parameterHints: { enabled: true, cycle: true },
};

/**
 * Scroll track of an editable code editor (a diff's right side, the IDE editor), split into two lanes: change marks
 * (see `changeMark`) in the left one, the language server's markers in the right one, where Monaco always draws markers.
 */
export const SCROLL_TRACK_OPTIONS: monaco.editor.IEditorOptions = {
  overviewRulerLanes: 2,
  hideCursorInOverviewRuler: true,
  overviewRulerBorder: false,
};

/** Green mark in the scroll track's left lane (see `SCROLL_TRACK_OPTIONS`) for the changed lines `startLine` to `endLine`. */
export function changeMark(startLine: number, endLine: number): monaco.editor.IModelDeltaDecoration {
  return {
    range: { startLineNumber: startLine, startColumn: 1, endLineNumber: endLine, endColumn: 1 },
    options: { overviewRuler: { color: "#2ea043", position: monaco.editor.OverviewRulerLane.Left } },
  };
}
