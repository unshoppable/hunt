/// <reference types="vite/client" />

/** Monaco ships this worker entry without typings; only what diff/semantic.worker.ts needs is declared. */
declare module "monaco-editor/languages/features/typescript/ts.worker.js" {
  import type { worker } from "monaco-editor";

  export class TypeScriptWorker {
    constructor(ctx: worker.IWorkerContext, createData: unknown);
    getLanguageService(): import("typescript").LanguageService;
  }
  export function initialize(factory: (ctx: worker.IWorkerContext, createData: unknown) => unknown): void;
  /** The bundled TypeScript API (5.9) under `typescript`, next to the language service factory. */
  export const ts: { typescript: typeof import("typescript") };
}

/** Monaco's tokenizer registry has no typings on its module path; only what code/highlight.ts needs is declared. */
declare module "monaco-editor/editor/common/languages.js" {
  export type TokenizationSupport = {
    getInitialState(): unknown;
    tokenize(line: string, hasEOL: boolean, state: unknown): { tokens: { offset: number; type: string }[]; endState: unknown };
  };
  export const TokenizationRegistry: {
    /** The loaded tokenizer of a language, or null while its grammar is still loading or when there is none. */
    get(languageId: string): TokenizationSupport | null;
    /** Loads the grammar of a language on first use; null when Monaco has none for it. */
    getOrCreate(languageId: string): Promise<TokenizationSupport | null>;
    /** Fires when a tokenizer is registered or removed. */
    onDidChange(listener: (event: { changedLanguages: string[] }) => void): { dispose(): void };
  };
}

/** Monaco's built-in themes have no typings on their module path. */
declare module "monaco-editor/editor/standalone/common/themes.js" {
  import type { editor } from "monaco-editor";

  export const vs_dark: editor.IStandaloneThemeData;
}

/** Monaco's service registry has no typings on its module path; only what diff/monaco.ts needs is declared. */
declare module "monaco-editor/editor/standalone/browser/standaloneServices.js" {
  import type { ServiceIdentifier } from "monaco-editor/platform/storage/common/storage.js";

  export const StandaloneServices: { get<T>(id: ServiceIdentifier<T>): T };
}

/** Monaco's storage service, where its widgets keep UI state such as the completion list's docs column. */
declare module "monaco-editor/platform/storage/common/storage.js" {
  /** A service's key for `StandaloneServices.get`; `T` is the service it yields. */
  export type ServiceIdentifier<T> = ((...args: never[]) => void) & { readonly service?: T };

  export const IStorageService: ServiceIdentifier<{ store(key: string, value: boolean, scope: number, target: number): void }>;
}
