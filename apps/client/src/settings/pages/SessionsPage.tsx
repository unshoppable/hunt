import { useSettingsStore } from "../settings.store";
import { useShortcutLabel } from "../../ui/shortcut-label.hook";
import { PageHeader } from "../SettingsFields";

/** How the session sidebar deletes sessions; the delete dialog's "Don't ask again" lands here. */
export function SessionsPage() {
  const confirmSessionDelete = useSettingsStore((state) => state.confirmSessionDelete);
  const setConfirmSessionDelete = useSettingsStore((state) => state.setConfirmSessionDelete);
  const removeShortcut = useShortcutLabel("session.remove");

  return (
    <section>
      <PageHeader title="Sessions" hint="Session sidebar behavior" isDefault={confirmSessionDelete} onReset={() => setConfirmSessionDelete(true)} />
      <div className="flex flex-col gap-2">
        <label className="flex items-center gap-2 text-sm text-neutral-100">
          <input type="checkbox" checked={confirmSessionDelete} onChange={(event) => setConfirmSessionDelete(event.target.checked)} className="hunt-checkbox" />
          Ask before deleting a session
        </label>
        <p className="text-[13px] leading-snug text-neutral-500">Deleting a session also removes its sub sessions and its worktree. Without the question, the delete button{removeShortcut ? ` and ${removeShortcut}` : ""} act at once.</p>
      </div>
    </section>
  );
}
