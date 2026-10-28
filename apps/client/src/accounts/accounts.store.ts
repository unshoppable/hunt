import { create } from "zustand";
import { commands } from "../ipc/commands";
import type { ClaudeAccounts } from "./accounts.types";
import type { DropdownOption } from "../ui/floating-menu.utils";
import { errorText } from "../ui/error-text.utils";

/** Dropdown entry of the local login; every other entry is the id of a token account. */
export const LOCAL_LOGIN = "local";

/** The account choices of a Claude account dropdown: the local login, then the token accounts by email. */
export function accountOptions(accounts: ClaudeAccounts | null): DropdownOption[] {
  return [{ id: LOCAL_LOGIN, name: "Local login", description: "claude /login" }, ...(accounts?.accounts ?? []).map((account) => ({ id: account.id, name: account.email }))];
}

type AccountsState = {
  /** null until the first load. */
  accounts: ClaudeAccounts | null;
  /** The last failed load or change; cleared by the next successful one. */
  error: string | null;
  load: () => Promise<void>;
  /** Takes the account list a backend command answers with; resolves to whether the command succeeded. */
  apply: (action: Promise<ClaudeAccounts>) => Promise<boolean>;
  /** Makes `id` (`LOCAL_LOGIN` or a token account) the account of every Claude Code process started from now on. */
  select: (id: string) => Promise<boolean>;
  clearError: () => void;
};

/** The Claude accounts the backend keeps (see agent/accounts.rs); every window reloads them on `accounts:changed`. */
export const useAccountsStore = create<AccountsState>()((set, get) => ({
  accounts: null,
  error: null,
  load: async () => {
    await get().apply(commands.listAccounts());
  },
  apply: async (action) => {
    try {
      set({ accounts: await action, error: null });
      return true;
    } catch (reason) {
      set({ error: errorText(reason) });
      return false;
    }
  },
  select: (id) => get().apply(commands.setActiveAccount(id === LOCAL_LOGIN ? null : id)),
  clearError: () => set({ error: null }),
}));
