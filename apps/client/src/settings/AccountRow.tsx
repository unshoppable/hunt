import { useRef, useState, type KeyboardEvent } from "react";
import { commands } from "../ipc/commands";
import { LOCAL_LOGIN, accountOptions, useAccountsStore } from "../accounts/accounts.store";
import { ICON_BUTTON_SM, PRIMARY_BUTTON_XS, SECONDARY_BUTTON_XS } from "../ui/buttons.constants";
import { confirmDestructive } from "../ui/confirm.utils";
import { Dropdown } from "../ui/Dropdown";
import { PlusIcon, Spinner, TrashIcon } from "../ui/Icons";
import { FORM_INPUT } from "./SettingsFields";

/**
 * The Claude account every Claude Code process Hunt starts uses: the local login or an OAuth token per email. "+" asks
 * for an email; Hunt runs `claude setup-token`, opens its sign-in in a private browser window with the email filled in
 * and makes the new token the active account. The trash button removes the selected token account. The backend owns the list (see agent/accounts.rs), so it is
 * not part of the settings store and "Reset" leaves it alone.
 */
export function AccountRow() {
  const accounts = useAccountsStore((state) => state.accounts);
  const error = useAccountsStore((state) => state.error);
  const apply = useAccountsStore((state) => state.apply);
  const select = useAccountsStore((state) => state.select);
  const clearError = useAccountsStore((state) => state.clearError);
  const [isAdding, setIsAdding] = useState(false);
  const [email, setEmail] = useState("");
  const [isSigningIn, setIsSigningIn] = useState(false);
  const isCancellingRef = useRef(false);
  const active = accounts?.accounts.find((account) => account.id === accounts.activeId) ?? null;
  const options = accountOptions(accounts);

  function closeForm() {
    setIsAdding(false);
    setEmail("");
  }

  async function signIn() {
    if (!email.trim() || isSigningIn) return;
    isCancellingRef.current = false;
    setIsSigningIn(true);
    const isAdded = await apply(commands.signInAccount(email));
    setIsSigningIn(false);
    if (isCancellingRef.current) {
      clearError();
    }
    if (!isAdded) return;
    closeForm();
  }

  /** Stops a running sign-in and keeps the form open; otherwise closes the form. */
  function cancel() {
    if (!isSigningIn) {
      closeForm();
      return;
    }
    isCancellingRef.current = true;
    void apply(commands.cancelSignIn().then(commands.listAccounts));
  }

  async function remove() {
    if (!active) return;
    if (!(await confirmDestructive(`Remove the Claude account ${active.email} and delete its token from the keychain? Hunt uses the local login afterwards.`, "Remove"))) return;
    await apply(commands.removeAccount(active.id));
  }

  function onFormKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      void signIn();
    } else if (event.key === "Escape") {
      event.stopPropagation();
      cancel();
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1 text-sm text-neutral-100">Claude account</div>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => setIsAdding(true)} className={ICON_BUTTON_SM} aria-label="Add a Claude account" title="Add a Claude account">
            <PlusIcon />
          </button>
          <button type="button" onClick={() => void remove()} disabled={!active} className={`${ICON_BUTTON_SM} hover:text-red-300`} aria-label="Remove the selected Claude account" title="Remove the selected Claude account">
            <TrashIcon />
          </button>
        </div>
        <Dropdown
          title="Claude account of every Claude Code process Hunt starts"
          value={accounts?.activeId ?? LOCAL_LOGIN}
          options={options}
          onChange={(id) => void select(id)}
          disabled={!accounts}
          className={`${FORM_INPUT} flex items-center justify-between gap-1.5 text-left`}
        />
        {/* Keeps the field aligned with the unit column of NumberRow. */}
        <span className="w-6" />
      </div>
      {isAdding ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <label htmlFor="account-email" className="min-w-0 flex-1 pl-4 text-sm text-neutral-400">
              Email
            </label>
            <input id="account-email" type="email" value={email} spellCheck={false} autoFocus placeholder="name@example.com" disabled={isSigningIn} onChange={(event) => setEmail(event.target.value)} onKeyDown={onFormKeyDown} className={FORM_INPUT} />
            <span className="w-6" />
          </div>
          {/* Right edge in line with the fields above, which keep the unit column free. */}
          <div className="flex items-center justify-end gap-2 pr-9">
            {isSigningIn ? (
              <span className="flex min-w-0 items-center gap-2 text-[13px] text-neutral-400">
                <Spinner />
                Waiting for the sign-in in your browser…
              </span>
            ) : null}
            <button type="button" onClick={cancel} className={SECONDARY_BUTTON_XS}>
              Cancel
            </button>
            <button type="button" onClick={() => void signIn()} disabled={!email.trim() || isSigningIn} className={PRIMARY_BUTTON_XS}>
              Sign in with browser
            </button>
          </div>
          <p className="pl-4 text-[13px] leading-snug text-neutral-500">
            Hunt runs <code>claude setup-token</code> and opens claude.ai in a private window of Chrome, Brave, Edge or Firefox with the email filled in. Once you signed in, the token
            goes straight into the keychain. Signing in again with the same email renews its token.
          </p>
        </div>
      ) : null}
      {error ? <p className="text-[13px] leading-snug break-words text-red-300">{error}</p> : null}
      <p className="text-[13px] leading-snug text-neutral-500">
        Every Claude Code process Hunt starts from now on uses this account: agents, session summaries and the plan usage. Agents already running keep the account they started with. Hunt keeps
        the tokens in the macOS keychain.
      </p>
    </div>
  );
}
