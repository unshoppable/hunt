import { DEFAULT_DETACHED_POPUPS, useSettingsStore, type DetachablePopupKey } from "../settings.store";
import { PageHeader } from "../SettingsFields";

/** What each work popup is, in the words of the Popups page. */
const POPUP_LABELS: Record<DetachablePopupKey, string> = {
  usages: "Usages of a ⌘clicked declaration",
  fileSearch: "Go to file or symbol",
  findInFiles: "Find in Files",
  subChat: "Sub chats",
  renamePreview: "Rename preview",
  image: "Images of the chat",
  screenshots: "Screenshot picker",
};

/** Which work popups open in a window of their own; the button in each popup's title bar switches the same setting. */
export function PopupsPage() {
  const detachedPopups = useSettingsStore((state) => state.detachedPopups);
  const setPopupDetached = useSettingsStore((state) => state.setPopupDetached);
  const resetDetachedPopups = useSettingsStore((state) => state.resetDetachedPopups);
  const isDefault = (Object.keys(DEFAULT_DETACHED_POPUPS) as DetachablePopupKey[]).every((key) => detachedPopups[key] === DEFAULT_DETACHED_POPUPS[key]);

  return (
    <section>
      <PageHeader title="Popups" hint="Which popups open in a window of their own" isDefault={isDefault} onReset={resetDetachedPopups} />
      <div className="flex flex-col gap-2">
        {(Object.keys(POPUP_LABELS) as DetachablePopupKey[]).map((key) => (
          <label key={key} className="flex items-center gap-2 text-sm text-neutral-100">
            <input type="checkbox" checked={detachedPopups[key]} onChange={(event) => setPopupDetached(key, event.target.checked)} className="hunt-checkbox" />
            {POPUP_LABELS[key]}
          </label>
        ))}
        <p className="text-[13px] leading-snug text-neutral-500">
          A popup in a window of its own can be moved anywhere, also onto another display, and stays open until Esc, ⌘W or its close button. Inside the app window a
          click outside closes it.
        </p>
      </div>
    </section>
  );
}
