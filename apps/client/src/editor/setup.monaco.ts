import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import editorWorker from "monaco-editor/editor/editor.worker.js?worker";
import jsonWorker from "monaco-editor/language/json/json.worker.js?worker";
import cssWorker from "monaco-editor/language/css/css.worker.js?worker";
import htmlWorker from "monaco-editor/language/html/html.worker.js?worker";
import tsWorker from "./semantic.worker.ts?worker";
import { registerSemanticTokens } from "./semantic-tokens.monaco";
import { registerLspProviders } from "../ide/lsp/lsp-providers.monaco";
import { WEBSTORM, WEBSTORM_TOKEN_RULES, typescriptLanguage } from "./webstorm-scheme.monaco";
import { angularTemplateLanguage } from "./angular-template.monaco";
import { cssLanguage } from "./css-language.monaco";
import { kindBadgeSvg } from "../ide/KindIcon";
import { MONACO_THEME } from "./monaco.constants";
import { onShortcut } from "./shortcuts.monaco";
import { StandaloneServices } from "monaco-editor/editor/standalone/browser/standaloneServices.js";
import { IStorageService } from "monaco-editor/platform/storage/common/storage.js";

/** Editor background last applied through `applyMonacoBackground`; `setupMonaco` keeps it when it (re)defines the theme. */
let editorBackground = "#33373f";

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

/** Tailwind's at-rules, which the CSS language service would otherwise mark as unknown; WebStorm's Tailwind plugin knows them. */
const TAILWIND_CSS_DATA: monaco.css.CSSDataV1 = {
  version: 1.1,
  atDirectives: ["@tailwind", "@apply", "@config", "@plugin", "@source", "@theme", "@utility", "@variant", "@custom-variant", "@reference", "@screen"].map((name) => ({ name })),
};

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

  // The bundled TypeScript worker only colors code (see semantic-tokens.monaco.ts): it sees files out of their project
  // context, so its type checking would only produce noise.
  const noDiagnostics = { noSemanticValidation: true, noSyntaxValidation: true };
  monaco.typescript.typescriptDefaults.setDiagnosticsOptions(noDiagnostics);
  monaco.typescript.javascriptDefaults.setDiagnosticsOptions(noDiagnostics);

  // Node resolution follows `./users` to `users/index.ts`, so names re-exported through barrels get their colors.
  for (const defaults of [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults]) {
    defaults.setCompilerOptions({ ...defaults.getCompilerOptions(), moduleResolution: monaco.typescript.ModuleResolutionKind.NodeJs });
  }

  // Completion, signature help, hover, inlay hints, highlights, symbols, navigation and diagnostics of worktree
  // files come from the project's language server (see ide/lsp/lsp-providers.monaco.ts), which knows the project's types and
  // imports; the worker only sees one file plus the DOM lib and keeps formatting. Cmd+click is handled by the
  // editors themselves (see ide-link.monaco.ts), so Monaco's own go-to-definition stays off.
  const serverFeatures = { completionItems: false, signatureHelp: false, hovers: false, inlayHints: false, documentHighlights: false, documentSymbols: false, definitions: false, references: false, diagnostics: false, rename: false, codeActions: false };
  for (const defaults of [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults]) {
    defaults.setModeConfiguration({ ...defaults.modeConfiguration, ...serverFeatures });
  }
  for (const defaults of [monaco.css.cssDefaults, monaco.css.scssDefaults, monaco.css.lessDefaults]) {
    defaults.setModeConfiguration({ ...defaults.modeConfiguration, definitions: false });
    defaults.setOptions({ ...defaults.options, data: { useDefaultDataProvider: true, dataProviders: { tailwind: TAILWIND_CSS_DATA } } });
  }

  monaco.languages.setMonarchTokensProvider("typescript", typescriptLanguage(".ts"));
  monaco.languages.setMonarchTokensProvider("javascript", typescriptLanguage(".js"));
  monaco.languages.setMonarchTokensProvider("css", cssLanguage(".css"));
  monaco.languages.setMonarchTokensProvider("scss", cssLanguage(".scss"));
  monaco.languages.setMonarchTokensProvider("html", angularTemplateLanguage());
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
      // Unused code keeps its color; index.css underlines it with a grey wave instead of fading it.
      "editorUnnecessaryCode.opacity": "#000000ff",
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
