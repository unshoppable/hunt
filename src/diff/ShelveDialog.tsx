import { useState } from "react";
import { commands } from "../ipc/commands";
import { INPUT } from "./styles";
import { GHOST_BUTTON, PRIMARY_BUTTON } from "../ui/buttons";
import { Modal } from "../ui/Modal";

/** Asks for a shelf name and parks the given files on the shelf. */
export function ShelveDialog({
  sessionId,
  paths,
  onClose,
  onShelved,
}: {
  sessionId: string;
  paths: string[];
  onClose: () => void;
  onShelved: () => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  async function submit() {
    if (!name.trim() || isBusy) return;
    setIsBusy(true);
    setError(null);
    try {
      await commands.shelveFiles(sessionId, paths, name.trim());
      onShelved();
      onClose();
    } catch (reason) {
      setError(String(reason));
      setIsBusy(false);
    }
  }

  return (
    <Modal label="Shelve changes" onClose={onClose} isCloseable={!isBusy} className="w-[420px] bg-(--surface-chat) p-4">
      <h2 className="mb-1 text-base font-semibold">Shelve changes</h2>
      <p className="mb-3 text-[13px] text-neutral-400">
        {paths.length} {paths.length === 1 ? "file is" : "files are"} removed from the worktree and kept on the shelf until you unshelve them.
      </p>
      <label className="mb-1 block text-[13px] text-neutral-400">Shelf name</label>
      <input
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            void submit();
          }
        }}
        placeholder="What do these changes do?"
        autoFocus
        className={`${INPUT} mb-3`}
      />
      {error ? <p className="mb-3 text-[13px] text-red-400">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} disabled={isBusy} className={GHOST_BUTTON}>
          Cancel
        </button>
        <button type="button" onClick={() => void submit()} disabled={isBusy || !name.trim()} className={PRIMARY_BUTTON}>
          {isBusy ? "Shelving…" : "Shelve"}
        </button>
      </div>
    </Modal>
  );
}
