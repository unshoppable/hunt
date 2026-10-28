/** A Claude account Hunt can start Claude Code with: an OAuth token from `claude setup-token`, kept in the keychain. */
export type ClaudeAccount = { id: string; email: string };

/** The token accounts in the order they were added and the one in use; `activeId` null uses the local login. */
export type ClaudeAccounts = { accounts: ClaudeAccount[]; activeId: string | null };
