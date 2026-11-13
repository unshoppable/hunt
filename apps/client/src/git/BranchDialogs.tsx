import { useMemo, useState, type ReactNode } from "react";
import { commands } from "../ipc/commands";
import type { GitScope } from "./git.types";
import { reportSuccess } from "../ui/status-toasts.store";
import { INPUT } from "../ui/styles.constants";
import { GHOST_BUTTON_MD, PRIMARY_BUTTON_MD, SECONDARY_BUTTON_MD } from "../ui/buttons.constants";
import { PlusIcon, Spinner } from "../ui/Icons";
import { Modal } from "../ui/Modal";
import { useDialogSize } from "../ui/dialog-size.hook";

/** Smallest size the push target dialog shrinks to: the list keeps a few rows. */
const PUSH_TARGET_MIN_SIZE = { width: 360, height: 300 };

/** The choice of one branch among `candidates` that a filter narrows: what `BranchChoiceList` shows and changes. */
type BranchChoice = {
  filter: string;
  setFilter: (filter: string) => void;
  /** The candidates whose name contains the filter, ignoring case. */
  matches: string[];
  /** The selected match; a filter that hides the chosen branch selects the first match, `null` without one. */
  selected: string | null;
  select: (candidate: string) => void;
  /** Moves the selection `step` rows through the matches. */
  moveSelection: (step: number) => void;
};

/** The state of a `BranchChoiceList` over `candidates` (`null` while they load), starting on `initial`. */
function useBranchChoice(candidates: readonly string[] | null, initial: string): BranchChoice {
  const [filter, setFilter] = useState("");
  const [choice, setChoice] = useState(initial);
  const matches = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return (candidates ?? []).filter((candidate) => candidate.toLowerCase().includes(needle));
  }, [candidates, filter]);
  const selected = matches.includes(choice) ? choice : (matches[0] ?? null);
  const moveSelection = (step: number) => {
    if (matches.length === 0) return;
    const index = selected ? matches.indexOf(selected) : -1;
    setChoice(matches[Math.max(0, Math.min(matches.length - 1, index + step))]);
  };
  return { filter, setFilter, matches, selected, select: setChoice, moveSelection };
}

/**
 * The filter field and the list of a branch `choice`, under `label`: typing filters, a click or the arrow keys select
 * a row, a double click or Enter calls `onSubmit` (with the row double-clicked). `children` are rows after the
 * matches, for what the list has to say instead of them.
 */
function BranchChoiceList({ label, choice, onSubmit, children }: { label: string; choice: BranchChoice; onSubmit: (candidate?: string) => void; children?: ReactNode }) {
  return (
    <>
      <label className="mb-1 block text-[13px] text-neutral-400">{label}</label>
      <input
        value={choice.filter}
        onChange={(event) => choice.setFilter(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            onSubmit();
          } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            choice.moveSelection(event.key === "ArrowDown" ? 1 : -1);
          }
        }}
        autoFocus
        spellCheck={false}
        placeholder="Filter"
        className={`${INPUT} font-mono`}
      />
      <ul role="listbox" className="mt-1 min-h-0 flex-1 overflow-auto rounded border border-(--line) p-1 font-mono text-[13px]">
        {choice.matches.map((candidate) => (
          <li
            key={candidate}
            role="option"
            aria-selected={candidate === choice.selected}
            onClick={() => choice.select(candidate)}
            onDoubleClick={() => onSubmit(candidate)}
            className={`cursor-default truncate rounded px-2 py-0.5 ${candidate === choice.selected ? "bg-(--row-selected) text-blue-100" : "text-neutral-200 hover:bg-(--row-hover)"}`}
          >
            {candidate}
          </li>
        ))}
        {children}
      </ul>
    </>
  );
}

/**
 * Lets the user pick the branch the session on `branch` is compared with, among `candidates` (local and remote
 * branches, starting on `initial`): a double click, Enter or "Compare" calls `onCompare` with it and closes the
 * dialog. It shares the remembered size of the push target dialog, which lists branches the same way.
 */
export function CompareBranchDialog({ branch, candidates, initial, onClose, onCompare }: { branch: string; candidates: string[]; initial: string; onClose: () => void; onCompare: (target: string) => void }) {
  const picker = useBranchChoice(candidates, initial);
  const dialog = useDialogSize("pushTarget", { min: PUSH_TARGET_MIN_SIZE, fillsHeight: true });
  const submit = (target = picker.selected) => {
    if (!target) return;
    onCompare(target);
    onClose();
  };
  return (
    <Modal label="Compare with branch" onClose={onClose} isCloseable className="bg-(--surface-chat) p-4" style={dialog.style} resize={dialog.resize}>
      <h2 className="mb-1 text-base font-semibold">Compare with branch</h2>
      <p className="mb-3 text-[13px] text-neutral-400">
        The changelist of <span className="font-mono text-neutral-300">{branch}</span> then lists every difference to the branch as it stands now, as after a soft reset to it.
      </p>
      <BranchChoiceList label="Branch" choice={picker} onSubmit={submit}>
        {picker.matches.length === 0 ? <li className="px-2 py-0.5 text-neutral-500">No branch matches.</li> : null}
      </BranchChoiceList>
      <div className="mt-auto flex justify-end gap-2 pt-3">
        <button type="button" onClick={onClose} className={GHOST_BUTTON_MD}>
          Cancel
        </button>
        <button type="button" onClick={() => submit()} disabled={!picker.selected} className={PRIMARY_BUTTON_MD}>
          Compare
        </button>
      </div>
    </Modal>
  );
}

/**
 * Lets the user pick, among the branches of `origin` (`candidates`, without the `origin/` prefix; `null` while they
 * load, `candidatesError` when that failed), the one a push of the session lands on: the text field filters the list, a click selects a row, a double click, Enter or "Change"
 * applies the selection. "New branch…" swaps the list for a name field, prefilled with the session's own branch
 * `branch`: "Create & change" creates that branch on `origin` at the commit of the current target (or merely fetches
 * it when `origin` has it already) and makes it the target. Dragging an edge resizes the dialog; the size is
 * remembered across sessions.
 */
export function PushTargetDialog({
  sessionId,
  branch,
  current,
  candidates,
  candidatesError = null,
  onClose,
  onChanged,
}: {
  sessionId: string;
  branch: string;
  current: string;
  candidates: string[] | null;
  candidatesError?: string | null;
  onClose: () => void;
  onChanged: (target: string) => void;
}) {
  const picker = useBranchChoice(candidates, current);
  const { selected } = picker;
  /** The name of the branch to create while "New branch…" is open; `null` while the list is shown. */
  const [newName, setNewName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const dialog = useDialogSize("pushTarget", { min: PUSH_TARGET_MIN_SIZE, fillsHeight: true });
  const isCreating = newName !== null;
  const target = isCreating ? newName.trim() : selected;
  const canSubmit = !!target && target !== current && !isBusy;

  async function submit(choice = target) {
    if (!choice || choice === current || isBusy) return;
    setIsBusy(true);
    setError(null);
    try {
      await commands.setPushTarget(sessionId, choice, isCreating);
      reportSuccess(`${branch} now pushes to origin/${choice}`);
      onChanged(choice);
      onClose();
    } catch (reason) {
      setError(String(reason));
      setIsBusy(false);
    }
  }

  return (
    <Modal label="Change push target" onClose={onClose} isCloseable={!isBusy} className="bg-(--surface-chat) p-4" style={dialog.style} resize={dialog.resize}>
      <h2 className="mb-1 text-base font-semibold">Change push target</h2>
      <p className="mb-3 text-[13px] text-neutral-400">
        A push lands on this branch of origin, after a rebase onto it; the session's own branch never reaches origin. Currently{" "}
        <span className="font-mono text-neutral-300">origin/{current}</span>.
      </p>
      {isCreating ? (
        <>
          <label className="mb-1 block text-[13px] text-neutral-400">New branch on origin</label>
          <input
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                void submit();
              }
            }}
            autoFocus
            spellCheck={false}
            placeholder="Name of the branch to create"
            className={`${INPUT} font-mono`}
          />
          <p className="mt-2 text-[13px] text-neutral-500">
            Created at the commit of <span className="font-mono">origin/{current}</span>, or fetched when origin has it already; then the push target.
          </p>
        </>
      ) : (
        <>
          <BranchChoiceList label="Branch on origin" choice={picker} onSubmit={(candidate) => void submit(candidate)}>
            {candidatesError ? (
              <li className="px-2 py-0.5 break-words whitespace-normal text-red-400">Loading the branches of origin failed: {candidatesError}</li>
            ) : !candidates ? (
              <li className="px-2 py-0.5 text-neutral-500">Loading the branches of origin…</li>
            ) : picker.matches.length === 0 ? (
              <li className="px-2 py-0.5 text-neutral-500">No fetched branch of origin matches.</li>
            ) : null}
          </BranchChoiceList>
        </>
      )}
      {error ? <p className="mt-3 text-[13px] text-red-400">{error}</p> : null}
      <div className="mt-auto flex justify-end gap-2 pt-3">
        {isCreating ? (
          <button type="button" onClick={() => setNewName(null)} disabled={isBusy} className={`${GHOST_BUTTON_MD} mr-auto`}>
            Back
          </button>
        ) : (
          <button type="button" onClick={() => setNewName(branch === current ? "" : branch)} disabled={isBusy} className={`${SECONDARY_BUTTON_MD} mr-auto`}>
            <PlusIcon className="size-3.5 shrink-0" />
            New branch…
          </button>
        )}
        <button type="button" onClick={onClose} disabled={isBusy} className={GHOST_BUTTON_MD}>
          Cancel
        </button>
        <button type="button" onClick={() => void submit()} disabled={!canSubmit} className={PRIMARY_BUTTON_MD}>
          {isBusy ? <Spinner className="size-3.5 shrink-0" /> : null}
          {isBusy ? (isCreating ? "Creating…" : "Changing…") : isCreating ? "Create & change" : "Change"}
        </button>
      </div>
    </Modal>
  );
}

/** Asks for the new name of the branch `branch` and renames it. Dragging an edge resizes the dialog. */
export function RenameBranchDialog({ scope, branch, onClose, onRenamed }: { scope: GitScope; branch: string; onClose: () => void; onRenamed: (newName: string) => void }) {
  const dialog = useDialogSize("renameBranch");
  const [name, setName] = useState(branch);
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const newName = name.trim();
  const canSubmit = !!newName && newName !== branch && !isBusy;

  async function submit() {
    if (!canSubmit) return;
    setIsBusy(true);
    setError(null);
    try {
      await commands.gitRenameBranch(scope, branch, newName);
      reportSuccess(`Renamed ${branch} to ${newName}`);
      onRenamed(newName);
      onClose();
    } catch (reason) {
      setError(String(reason));
      setIsBusy(false);
    }
  }

  return (
    <Modal label="Rename branch" onClose={onClose} isCloseable={!isBusy} className="bg-(--surface-chat) p-4" style={dialog.style} resize={dialog.resize}>
      <h2 className="mb-1 text-base font-semibold">Rename branch</h2>
      <p className="mb-3 truncate font-mono text-[13px] text-neutral-400" title={branch}>
        {branch}
      </p>
      <label className="mb-1 block text-[13px] text-neutral-400">New name</label>
      <input
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            void submit();
          }
        }}
        autoFocus
        spellCheck={false}
        className={`${INPUT} mb-3 font-mono`}
      />
      {error ? <p className="mb-3 text-[13px] text-red-400">{error}</p> : null}
      <div className="mt-auto flex justify-end gap-2">
        <button type="button" onClick={onClose} disabled={isBusy} className={GHOST_BUTTON_MD}>
          Cancel
        </button>
        <button type="button" onClick={() => void submit()} disabled={!canSubmit} className={PRIMARY_BUTTON_MD}>
          {isBusy ? "Renaming…" : "Rename"}
        </button>
      </div>
    </Modal>
  );
}
