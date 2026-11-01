import { useState } from "react";
import { commands } from "../../ipc/commands";
import { INPUT } from "../../ui/styles.constants";
import { GHOST_BUTTON_MD, PRIMARY_BUTTON_MD } from "../../ui/buttons.constants";
import { Modal } from "../../ui/Modal";
import { useDialogSize } from "../../ui/dialog-size.hook";
import { errorText } from "../../ui/error-text.utils";
import { newFolderProblem } from "../language/path-rename.utils";

/**
 * Asks for the name of a new folder inside the worktree folder `parent` (`""` is the worktree itself) and creates it;
 * `a/b` creates nested folders. Enter creates, Esc closes. Dragging an edge resizes the dialog.
 */
export function NewFolderDialog({ sessionId, parent, onClose, onCreated }: { sessionId: string; parent: string; onClose: () => void; onCreated: (path: string) => void }) {
  const dialog = useDialogSize("newFolder");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const folderName = name.trim();
  const problem = folderName ? newFolderProblem(folderName) : null;
  const canSubmit = !!folderName && !problem && !isBusy;

  async function submit() {
    if (!canSubmit) return;
    const path = parent ? `${parent}/${folderName}` : folderName;
    setIsBusy(true);
    setError(null);
    try {
      await commands.createDir(sessionId, path);
      onCreated(path);
      onClose();
    } catch (reason) {
      setError(errorText(reason));
      setIsBusy(false);
    }
  }

  return (
    <Modal label="New folder" onClose={onClose} isCloseable={!isBusy} className="bg-(--surface-chat) p-4" style={dialog.style} resize={dialog.resize}>
      <h2 className="mb-1 text-base font-semibold">New folder</h2>
      <p className="mb-3 truncate font-mono text-[13px] text-neutral-400" title={parent || "/"}>
        {parent ? `${parent}/` : "/"}
      </p>
      <label htmlFor="new-folder-name" className="mb-1 block text-[13px] text-neutral-400">
        Name
      </label>
      <input
        id="new-folder-name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void submit();
          }
        }}
        autoFocus
        spellCheck={false}
        className={`${INPUT} font-mono`}
      />
      {problem ? <p className="mt-1.5 text-[13px] text-red-400">{problem}</p> : null}
      {error ? <p className="mt-3 text-[13px] text-red-400">{error}</p> : null}
      <div className="mt-auto flex justify-end gap-2 pt-4">
        <button type="button" onClick={onClose} disabled={isBusy} className={GHOST_BUTTON_MD}>
          Cancel
        </button>
        <button type="button" onClick={() => void submit()} disabled={!canSubmit} className={PRIMARY_BUTTON_MD}>
          {isBusy ? "Creating…" : "Create"}
        </button>
      </div>
    </Modal>
  );
}
