/** The language servers of a worktree: tsgo, and in Angular projects the Angular language server. */
export type LanguageServerKind = "typescript" | "angular";

/** Diagnostics the language server pushed for one document of `worktreePath` (LSP `publishDiagnostics` params). */
export type LspDiagnosticsEvent = { worktreePath: string; uri: string; diagnostics: unknown };
/** The language server process of `worktreePath` ended; the next request starts a new one. */
export type LspExitedEvent = { worktreePath: string };
