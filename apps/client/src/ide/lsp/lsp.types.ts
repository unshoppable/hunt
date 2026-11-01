/** The language servers of a worktree: tsgo, and in Angular projects the Angular language server. */
export type LanguageServerKind = "typescript" | "angular";

/** Diagnostics the language server pushed for one document of `worktreePath` (LSP `publishDiagnostics` params). */
export type LspDiagnosticsEvent = { worktreePath: string; uri: string; diagnostics: unknown };
/**
 * The TypeScript server process of `worktreePath` ended (Rust `ExitedEvent` in `ide/lsp.rs`); the next request starts a
 * new one unless it crashed too often. `reason` says why a crashed server ended, with an excerpt of its stderr, and is
 * null for a server Hunt stopped.
 */
export type LspExitedEvent = { worktreePath: string; reason: string | null };
