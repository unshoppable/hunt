import { useState, type KeyboardEvent } from "react";
import { commands } from "../ipc/commands";
import type { RemoteSecretSummary } from "./settings.types";
import { configuredVmSettings, useSettingsStore } from "./settings.store";
import { DANGER_BUTTON_XS, GHOST_BUTTON_XS, PRIMARY_BUTTON_XS, SECONDARY_BUTTON_XS } from "../ui/buttons.constants";
import { confirmDestructive } from "../ui/confirm.utils";
import { Spinner } from "../ui/Icons";
import { useLoad } from "../ui/load.hook";
import { errorText } from "../ui/error-text.utils";
import { maskedRemoteSecret, normalizeRemoteSecretName, remoteSecretNameProblem, remoteSecretValueProblem } from "./remote-secrets.utils";
import { FORM_INPUT } from "./SettingsFields";

/** Keeps the value column of the remote secret rows aligned whatever buttons a row shows. */
const SECRET_ACTIONS = "flex w-36 shrink-0 items-center justify-end gap-1";

/**
 * The remote secrets the gateway keeps in Secret Manager and puts on every session VM, as names and hints: the gateway
 * never returns a value. The list loads when the block opens, when the project changes, on "Reload" and after every
 * change; each call names the gateway's project itself.
 */
export function RemoteSecretsBlock() {
  const remote = useSettingsStore((state) => state.remote);
  const [secrets, setSecrets] = useState<RemoteSecretSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const settings = configuredVmSettings(remote);
  const loadKey = `${remote.project}\n${generation}`;
  const isLoading = loadedKey !== loadKey;
  useLoad(
    async () => {
      if (!settings) throw new Error("Set the Google Cloud project above to manage the remote secrets.");
      return commands.listRemoteSecrets(settings);
    },
    {
      onValue: (listed) => {
        setSecrets(listed);
        setError(null);
        setLoadedKey(loadKey);
      },
      onError: (reason) => {
        setError(errorText(reason));
        setLoadedKey(loadKey);
      },
    },
    [remote.project, generation],
  );

  const names = secrets?.map((secret) => secret.name) ?? [];
  const nameProblem = remoteSecretNameProblem(name, names);
  const valueProblem = remoteSecretValueProblem(value);
  const canAdd = Boolean(settings) && Boolean(name) && Boolean(value) && !nameProblem && !valueProblem && !isSaving;

  /** Runs a change and reloads the list after it; resolves to whether it succeeded. */
  async function run(action: () => Promise<unknown>): Promise<boolean> {
    setIsSaving(true);
    try {
      await action();
      setError(null);
      setGeneration((current) => current + 1);
      return true;
    } catch (reason) {
      setError(errorText(reason));
      return false;
    } finally {
      setIsSaving(false);
    }
  }

  async function add() {
    if (!canAdd) return;
    if (!settings || !(await run(() => commands.setRemoteSecret(settings, name, value)))) return;
    setName("");
    setValue("");
  }

  async function replace(secret: string, replacement: string): Promise<boolean> {
    if (!settings) return false;
    return run(() => commands.setRemoteSecret(settings, secret, replacement));
  }

  async function remove(secret: string) {
    if (!(await confirmDestructive(`Delete the remote secret ${secret}? Sessions that start afterwards no longer get it.`, "Delete"))) return;
    if (!settings) return;
    await run(() => commands.deleteRemoteSecret(settings, secret));
  }

  function onAddKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void add();
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1 text-sm text-neutral-100">Remote secrets</div>
        {isLoading ? <Spinner className="size-3.5 text-neutral-500" /> : null}
        <button type="button" onClick={() => setGeneration((current) => current + 1)} disabled={isLoading} className={GHOST_BUTTON_XS}>
          Reload
        </button>
        <span className="w-6" />
      </div>
      <p className="text-[13px] leading-snug text-neutral-500">
        The gateway keeps these values in Secret Manager and hands them to the services of every session VM. A service names the ones it needs in the
        repository's hunt.json as <code className="font-mono text-neutral-400">{'"remoteSecrets": { "<ENV>": "$<NAME>" }'}</code> and gets
        them as environment variables. Changes apply to sessions that start or are handed off afterwards. Hunt never reads a value back.
      </p>
      {secrets?.length ? (
        <div className="flex flex-col gap-1">
          {secrets.map((secret) => (
            <RemoteSecretRow
              key={secret.name}
              secret={secret}
              isSaving={isSaving}
              onReplace={(replacement) => replace(secret.name, replacement)}
              onDelete={() => void remove(secret.name)}
            />
          ))}
        </div>
      ) : secrets && !isLoading ? (
        <p className="text-[13px] leading-snug text-neutral-500">No remote secrets yet.</p>
      ) : null}
      <div className="flex items-center gap-3">
        <input
          type="text"
          value={name}
          spellCheck={false}
          autoComplete="off"
          placeholder="NAME"
          aria-label="Name of the new remote secret"
          disabled={isSaving}
          onChange={(event) => setName(normalizeRemoteSecretName(event.target.value))}
          onKeyDown={onAddKeyDown}
          className={`${FORM_INPUT} min-w-0 flex-1 font-mono`}
        />
        <input
          type="password"
          value={value}
          spellCheck={false}
          autoComplete="off"
          placeholder="Value"
          aria-label="Value of the new remote secret"
          disabled={isSaving}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onAddKeyDown}
          className={`${FORM_INPUT} font-mono`}
        />
        <div className={SECRET_ACTIONS}>
          <button type="button" onClick={() => void add()} disabled={!canAdd} className={PRIMARY_BUTTON_XS}>
            Add
          </button>
        </div>
        <span className="w-6" />
      </div>
      {nameProblem || valueProblem ? <p className="text-[13px] leading-snug text-red-300">{nameProblem ?? valueProblem}</p> : null}
      {error ? <p className="text-[13px] leading-snug break-words text-red-300">{error}</p> : null}
    </div>
  );
}

/** One remote secret: its name, its masked value, and "Replace", which swaps the value for a password field, and "Delete". */
function RemoteSecretRow({
  secret,
  isSaving,
  onReplace,
  onDelete,
}: {
  secret: RemoteSecretSummary;
  isSaving: boolean;
  onReplace: (value: string) => Promise<boolean>;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const problem = draft ? remoteSecretValueProblem(draft) : null;
  const canSave = Boolean(draft) && !problem && !isSaving;

  async function save() {
    if (!draft || !canSave) return;
    if (!(await onReplace(draft))) return;
    setDraft(null);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.stopPropagation();
      setDraft(null);
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    void save();
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1 truncate font-mono text-sm text-neutral-100" title={secret.name}>
          {secret.name}
        </div>
        {draft === null ? (
          <>
            <div className="w-56 shrink-0 px-2 py-1 font-mono text-sm text-neutral-400">{maskedRemoteSecret(secret.hint)}</div>
            <div className={SECRET_ACTIONS}>
              <button type="button" onClick={() => setDraft("")} disabled={isSaving} className={GHOST_BUTTON_XS}>
                Replace
              </button>
              <button type="button" onClick={onDelete} disabled={isSaving} className={DANGER_BUTTON_XS} aria-label={`Delete the remote secret ${secret.name}`}>
                Delete
              </button>
            </div>
          </>
        ) : (
          <>
            <input
              type="password"
              value={draft}
              spellCheck={false}
              autoComplete="off"
              autoFocus
              placeholder="New value"
              aria-label={`New value of the remote secret ${secret.name}`}
              disabled={isSaving}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
              className={`${FORM_INPUT} shrink-0 font-mono`}
            />
            <div className={SECRET_ACTIONS}>
              <button type="button" onClick={() => setDraft(null)} className={SECONDARY_BUTTON_XS}>
                Cancel
              </button>
              <button type="button" onClick={() => void save()} disabled={!canSave} className={PRIMARY_BUTTON_XS}>
                Save
              </button>
            </div>
          </>
        )}
        <span className="w-6" />
      </div>
      {problem ? <p className="text-[13px] leading-snug text-red-300">{problem}</p> : null}
    </div>
  );
}
