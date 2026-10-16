import { useState } from "react";
import { useSettingsStore } from "../state/settings";
import { GHOST_BUTTON_MD, PRIMARY_BUTTON_MD } from "../ui/buttons";
import { Modal } from "../ui/Modal";

/**
 * Asks whether to delete a session, or with `isRemoval` whether to remove a remote one from the sidebar; "Don't ask
 * again" turns the confirmation off in the settings (General → Sessions turns it back on). Replaces the native dialog
 * because that one cannot carry a checkbox.
 */
export function DeleteSessionDialog({ question, isRemoval = false, onConfirm, onClose }: { question: string; isRemoval?: boolean; onConfirm: () => void; onClose: () => void }) {
  const setConfirmSessionDelete = useSettingsStore((state) => state.setConfirmSessionDelete);
  const [isSkipNextTime, setIsSkipNextTime] = useState(false);

  const confirm = () => {
    if (isSkipNextTime) {
      setConfirmSessionDelete(false);
    }
    onClose();
    onConfirm();
  };

  const title = isRemoval ? "Remove from sidebar" : "Delete session";
  return (
    <Modal label={title} onClose={onClose} className="w-[420px] bg-(--surface-chat) p-4">
      <h2 className="mb-1 text-base font-semibold">{title}</h2>
      <p className="mb-3 text-[13px] text-neutral-300">{question}</p>
      <label className="mb-4 flex items-center gap-2 text-[13px] text-neutral-400">
        <input type="checkbox" checked={isSkipNextTime} onChange={(event) => setIsSkipNextTime(event.target.checked)} className="hunt-checkbox" />
        Don't ask again
      </label>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className={GHOST_BUTTON_MD}>
          Cancel
        </button>
        <button type="button" onClick={confirm} autoFocus className={PRIMARY_BUTTON_MD}>
          {isRemoval ? "Remove" : "Delete"}
        </button>
      </div>
    </Modal>
  );
}
