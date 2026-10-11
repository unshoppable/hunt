import { useState } from "react";
import { useSettingsStore } from "../state/settings";
import { GHOST_BUTTON, PRIMARY_BUTTON } from "../ui/buttons";
import { Modal } from "../ui/Modal";

/**
 * Asks whether to delete a session; "Don't ask again" turns the confirmation off in the settings (General → Sessions
 * turns it back on). Replaces the native dialog because that one cannot carry a checkbox.
 */
export function DeleteSessionDialog({ question, onConfirm, onClose }: { question: string; onConfirm: () => void; onClose: () => void }) {
  const setConfirmSessionDelete = useSettingsStore((state) => state.setConfirmSessionDelete);
  const [isSkipNextTime, setIsSkipNextTime] = useState(false);

  const confirm = () => {
    if (isSkipNextTime) {
      setConfirmSessionDelete(false);
    }
    onClose();
    onConfirm();
  };

  return (
    <Modal label="Delete session" onClose={onClose} className="w-[420px] bg-(--surface-chat) p-4">
      <h2 className="mb-1 text-base font-semibold">Delete session</h2>
      <p className="mb-3 text-[13px] text-neutral-300">{question}</p>
      <label className="mb-4 flex items-center gap-2 text-[13px] text-neutral-400">
        <input type="checkbox" checked={isSkipNextTime} onChange={(event) => setIsSkipNextTime(event.target.checked)} className="hunt-checkbox" />
        Don't ask again
      </label>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className={GHOST_BUTTON}>
          Cancel
        </button>
        <button type="button" onClick={confirm} autoFocus className={PRIMARY_BUTTON}>
          Delete
        </button>
      </div>
    </Modal>
  );
}
