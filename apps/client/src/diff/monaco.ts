import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import editorWorker from "monaco-editor/editor/editor.worker.js?worker";
import jsonWorker from "monaco-editor/language/json/json.worker.js?worker";
import cssWorker from "monaco-editor/language/css/css.worker.js?worker";
import htmlWorker from "monaco-editor/language/html/html.worker.js?worker";
import tsWorker from "./semantic.worker.ts?worker";
import { registerSemanticTokens } from "./semanticTokens";
import { registerLspProviders } from "../ide/lsp/providers";
import { WEBSTORM, WEBSTORM_TOKEN_RULES, typescriptLanguage } from "./webstormScheme";
import { CODE_FONT_FAMILY, UI_FONT_FAMILY } from "../state/settings";
import type { CommandId } from "../state/keymap";
import { isShortcut } from "../ui/shortcuts";
import { kindBadgeSvg } from "../ide/KindIcon";
import { StandaloneServices } from "monaco-editor/editor/standalone/browser/standaloneServices.js";
import { IStorageService } from "monaco-editor/platform/storage/common/storage.js";

/** Monaco theme name: WebStorm's syntax colors (see webstormScheme.ts) on the diff pane's background. */
export const MONACO_THEME = "hunt-dark";

/** Editor background last applied through `applyMonacoBackground`; `setupMonaco` keeps it when it (re)defines the theme. */
let editorBackground = "#33373f";

/**
 * Brackets keep the theme's punctuation color like in WebStorm instead of Monaco's rainbow pairs. Only this dotted
 * configuration key reaches the text models (the nested `bracketPairColorization` option object is dropped on the way).
 */
const BRACKET_PAIR_COLORS_OFF = { "bracketPairColorization.enabled": false } as monaco.editor.IStandaloneEditorConstructionOptions;

/**
 * Options shared by every Monaco editor to look like WebStorm: the code font with ligatures (a `lineHeight` below 8
 * is a multiple of the font size), semantic highlighting (see semanticTokens.ts), plain bracket colors and inlay
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
 * grows wide enough for the types at the right of its rows. See ide/lsp/providers.ts for what opens it and what its
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

/** Height of a completion row as a multiple of the editor's font size. */
const COMPLETION_ROW_HEIGHT = 1.7;

/** Monaco's storage key for whether the completion list shows the docs column, and the scope and target it uses. */
const COMPLETION_DOCS_KEY = "expandSuggestionDocs";
const PROFILE_SCOPE = 0;
const USER_TARGET = 0;

/** Monaco's codicon of a completion kind and the KindIcon badge drawn in its place, like WebStorm's lookup icons. */
const COMPLETION_KIND_BADGES: Record<string, string> = {
  "symbol-method": "method",
  "symbol-function": "function",
  "symbol-constructor": "constructor",
  "symbol-field": "property",
  "symbol-property": "property",
  "symbol-variable": "var",
  "symbol-constant": "const",
  "symbol-class": "class",
  "symbol-interface": "interface",
  "symbol-struct": "type",
  "symbol-type-parameter": "type",
  "symbol-module": "module",
  "symbol-enum": "enum",
  "symbol-enum-member": "enum member",
};

/**
 * Sets up the completion list of every code editor: the keymap's `editor.completion` (⌃Space, ⌥Space) opens it in
 * place of Monaco's own ⌃Space binding, its rows are `COMPLETION_ROW_HEIGHT` times the font size high and carry
 * WebStorm's kind badges, and the docs column always shows beside it. Monaco keeps that column's state in its storage;
 * its close button is hidden (index.css), so nothing turns it off again.
 */
function setUpCompletionList(): void {
  StandaloneServices.get(IStorageService).store(COMPLETION_DOCS_KEY, true, PROFILE_SCOPE, USER_TARGET);
  monaco.editor.addKeybindingRules([{ keybinding: monaco.KeyMod.WinCtrl | monaco.KeyCode.Space, command: "-editor.action.triggerSuggest" }]);

  const style = document.createElement("style");
  style.textContent = Object.entries(COMPLETION_KIND_BADGES)
    .map(([icon, kind]) => `.monaco-editor .suggest-widget .suggest-icon.codicon-${icon}::before { content: ""; background-image: url("data:image/svg+xml,${encodeURIComponent(kindBadgeSvg(kind))}"); }`)
    .join("\n");
  document.head.append(style);

  monaco.editor.onDidCreateEditor((editor) => {
    onShortcut(editor, "editor.completion", () => editor.trigger("keyboard", "editor.action.triggerSuggest", {}));
    const fitRows = () => editor.updateOptions({ suggestLineHeight: Math.round(editor.getOption(monaco.editor.EditorOption.fontSize) * COMPLETION_ROW_HEIGHT) });
    editor.onDidChangeConfiguration((event) => {
      if (event.hasChanged(monaco.editor.EditorOption.fontSize)) {
        fitRows();
      }
    });
    // The event fires while the editor is still being constructed; options can change once that is done.
    queueMicrotask(fitRows);
  });
}

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

/**
 * Runs `run` when a binding of the keymap command `id` is pressed while `editor` has the focus. The binding is read at
 * press time, so a keymap change reaches open editors at once, and the press does not reach Monaco's own bindings.
 */
export function onShortcut(editor: monaco.editor.ICodeEditor, id: CommandId, run: () => void): monaco.IDisposable {
  return editor.onKeyDown((event) => {
    if (!isShortcut(event.browserEvent, id)) return;
    event.preventDefault();
    event.stopPropagation();
    run();
  });
}

let isSetUp = false;

/** Bundles Monaco with Vite instead of the loader's CDN default and registers the language workers; runs once. */
export function setupMonaco(): void {
  if (isSetUp) return;
  isSetUp = true;
  window.MonacoEnvironment = {
    getWorker(_workerId, label) {
      switch (label) {
        case "json":
          return new jsonWorker();
        case "css":
        case "scss":
        case "less":
          return new cssWorker();
        case "html":
        case "handlebars":
        case "razor":
          return new htmlWorker();
        case "typescript":
        case "javascript":
          return new tsWorker();
        default:
          return new editorWorker();
      }
    },
  };

  // The bundled TypeScript worker only colors code (see semanticTokens.ts): it sees files out of their project
  // context, so its type checking would only produce noise.
  const noDiagnostics = { noSemanticValidation: true, noSyntaxValidation: true };
  monaco.typescript.typescriptDefaults.setDiagnosticsOptions(noDiagnostics);
  monaco.typescript.javascriptDefaults.setDiagnosticsOptions(noDiagnostics);

  // Node resolution follows `./users` to `users/index.ts`, so names re-exported through barrels get their colors.
  for (const defaults of [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults]) {
    defaults.setCompilerOptions({ ...defaults.getCompilerOptions(), moduleResolution: monaco.typescript.ModuleResolutionKind.NodeJs });
  }

  // Completion, signature help, hover, inlay hints, highlights, symbols, navigation and diagnostics of worktree
  // files come from the project's language server (see ide/lsp/providers.ts), which knows the project's types and
  // imports; the worker only sees one file plus the DOM lib and keeps formatting. Cmd+click is handled by the
  // editors themselves (see ideLink.ts), so Monaco's own go-to-definition stays off.
  const serverFeatures = { completionItems: false, signatureHelp: false, hovers: false, inlayHints: false, documentHighlights: false, documentSymbols: false, definitions: false, references: false, diagnostics: false, rename: false, codeActions: false };
  for (const defaults of [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults]) {
    defaults.setModeConfiguration({ ...defaults.modeConfiguration, ...serverFeatures });
  }
  for (const defaults of [monaco.css.cssDefaults, monaco.css.scssDefaults, monaco.css.lessDefaults]) {
    defaults.setModeConfiguration({ ...defaults.modeConfiguration, definitions: false });
  }

  monaco.languages.setMonarchTokensProvider("typescript", typescriptLanguage(".ts"));
  monaco.languages.setMonarchTokensProvider("javascript", typescriptLanguage(".js"));
  registerSemanticTokens();
  registerLspProviders();
  setUpCompletionList();
  monaco.editor.onDidCreateEditor((editor) => {
    onShortcut(editor, "editor.selectAllOccurrences", () => editor.trigger("keyboard", "editor.action.selectHighlights", {}));
  });

  applyMonacoBackground(editorBackground);

  loader.config({ monaco });
}

/** (Re)defines the Monaco theme with the given editor background; open editors using the theme repaint at once. */
export function applyMonacoBackground(background: string): void {
  editorBackground = background;
  monaco.editor.defineTheme(MONACO_THEME, {
    base: "vs-dark",
    inherit: true,
    rules: WEBSTORM_TOKEN_RULES,
    colors: {
      "editor.background": background,
      "editor.foreground": `#${WEBSTORM.TEXT}`,
      "editor.lineHighlightBackground": "#ffffff0c",
      // A light, translucent blue that stays visible under the translucent diff tints (see index.css).
      "editor.selectionBackground": "#4c8bf580",
      "editor.inactiveSelectionBackground": "#4c8bf540",
      "editorLineNumber.foreground": `#${WEBSTORM.LINE_NUMBERS}`,
      "editorInlayHint.foreground": `#${WEBSTORM.INLAY_HINT_FOREGROUND}`,
      "editorInlayHint.background": `#${WEBSTORM.INLAY_HINT_BACKGROUND}`,
      "editorGutter.background": background,
      "diffEditor.insertedTextBackground": "#2ea04366",
      "diffEditor.removedTextBackground": "#f8514966",
      "diffEditor.insertedLineBackground": "#105b144d",
      "diffEditor.removedLineBackground": "#701b144d",
      "diffEditorGutter.insertedLineBackground": "#2b4a32",
      "diffEditorGutter.removedLineBackground": "#55302f",
      "diffEditor.unchangedRegionBackground": "#2d323c",
      "diffEditor.diagonalFill": "#00000000",
      "scrollbarSlider.background": "#ffffff1a",
      // The completion list's look (shape, rows, docs column) lives in index.css; these are the colors Monaco applies itself.
      "editorSuggestWidget.background": "#21252d",
      "editorSuggestWidget.border": "#4a4f59",
      "editorSuggestWidget.foreground": "#dfe1e5",
      "editorSuggestWidget.selectedForeground": "#ffffff",
      "editorSuggestWidget.selectedBackground": "#00000000",
      "editorSuggestWidget.highlightForeground": "#5c95ff",
      "editorSuggestWidget.focusHighlightForeground": "#a9c7ff",
    },
  });
}

/** Monaco language ids by file extension and by the names used in Markdown fences. */
const LANGUAGE_BY_NAME: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  typescript: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  javascript: "javascript",
  json: "json",
  jsonc: "json",
  rs: "rust",
  rust: "rust",
  md: "markdown",
  markdown: "markdown",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  yml: "yaml",
  yaml: "yaml",
  sh: "shell",
  zsh: "shell",
  bash: "shell",
  shell: "shell",
  console: "shell",
  py: "python",
  python: "python",
  sql: "sql",
  toml: "ini",
  ini: "ini",
  go: "go",
  java: "java",
  kt: "kotlin",
  kotlin: "kotlin",
  xml: "xml",
  graphql: "graphql",
  dockerfile: "dockerfile",
  docker: "dockerfile",
  text: "plaintext",
  txt: "plaintext",
  plain: "plaintext",
  plaintext: "plaintext",
};

/** Monaco language id for a file path. */
export function monacoLanguage(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return LANGUAGE_BY_NAME[extension] ?? "plaintext";
}

/**
 * Monaco language id for the info string of a Markdown fence (`ts`, `bash`, `TypeScript title="x"`). Names
 * without an alias are passed through, so Monaco's other grammars (`cpp`, `ruby`, …) still apply.
 */
export function monacoLanguageForFence(info: string | undefined): string {
  const name = info?.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!name) return "plaintext";
  return LANGUAGE_BY_NAME[name] ?? name;
}
