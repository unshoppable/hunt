import { useState, type KeyboardEvent } from "react";
import { commands } from "../ipc/commands";
import type { GithubTokenStatus } from "./settings.types";
import { ICON_BUTTON_SM, PRIMARY_BUTTON_XS, SECONDARY_BUTTON_XS } from "../ui/buttons.constants";
import { confirmDestructive } from "../ui/confirm.utils";
import { TrashIcon } from "../ui/Icons";
import { useLoad } from "../ui/load.hook";
import { errorText } from "../ui/error-text.utils";
import { FORM_INPUT } from "./SettingsFields";

/** The GitHub token remote sessions push and run `gh` with; Hunt keeps it in the keychain, never in the settings. */
export function GithubTokenRow() {
  const [status, setStatus] = useState<GithubTokenStatus | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  useLoad(commands.githubTokenStatus, { onValue: setStatus, onError: (reason) => setError(errorText(reason)) }, []);

  async function run(action: Promise<GithubTokenStatus>): Promise<boolean> {
    setIsSaving(true);
    try {
      setStatus(await action);
      setError(null);
      return true;
    } catch (reason) {
      setError(errorText(reason));
      return false;
    } finally {
      setIsSaving(false);
    }
  }

  async function save() {
    if (!draft.trim() || isSaving) return;
    if (!(await run(commands.setGithubToken(draft)))) return;
    setDraft("");
  }

  async function remove() {
    if (!(await confirmDestructive("Delete the GitHub token from the keychain? Remote sessions handed off from now on cannot push.", "Delete"))) return;
    await run(commands.removeGithubToken());
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void save();
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <label htmlFor="github-token" className="min-w-0 flex-1 text-sm text-neutral-100">
          GitHub token
        </label>
        <button type="button" onClick={() => void remove()} disabled={!status?.saved || isSaving} className={`${ICON_BUTTON_SM} hover:text-red-300`} aria-label="Delete the GitHub token" title="Delete the GitHub token">
          <TrashIcon />
        </button>
        <input
          id="github-token"
          type="password"
          value={draft}
          spellCheck={false}
          autoComplete="off"
          placeholder={status?.saved ? `••••••••${status.hint ?? ""}` : "Not set"}
          disabled={isSaving}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          className={`${FORM_INPUT} font-mono ${status?.saved ? "placeholder:text-neutral-200!" : ""}`}
        />
        <span className="w-6" />
      </div>
      {draft.trim() ? (
        <div className="flex items-center justify-end gap-2 pr-9">
          <button type="button" onClick={() => setDraft("")} className={SECONDARY_BUTTON_XS}>
            Cancel
          </button>
          <button type="button" onClick={() => void save()} disabled={isSaving} className={PRIMARY_BUTTON_XS}>
            Save
          </button>
        </div>
      ) : null}
      {error ? <p className="text-[13px] leading-snug break-words text-red-300">{error}</p> : null}
      <p className="text-[13px] leading-snug text-neutral-500">
        With a token, the agent of a remote session pushes to GitHub and runs gh as you. Use a fine-grained token limited to the repositories you hand off, with Contents and
        Pull requests read and write, Actions and Commit statuses read. Everyone with root on the VM can read it. Hunt keeps it in the macOS keychain; a session gets it at its
        handoff or /clear.
      </p>
    </div>
  );
}
