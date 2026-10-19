import { useState } from "react";
import { Modal } from "../ui/Modal";
import { useDialogSize } from "../ui/useDialogSize";

/**
 * Images of a chat message or tool result as a row of thumbnails; a click on one shows it in a dialog, fitted into
 * the dialog, which the user resizes by dragging its edges. `urls` are asset URLs of screenshots the user attached or `data:` URLs that `imageDataUrl`
 * (chat/imageData.ts) accepted; they are only ever loaded by an `<img>`.
 */
export function ChatImages({ urls, className = "" }: { urls: string[]; className?: string }) {
  const [shownUrl, setShownUrl] = useState<string | null>(null);
  const dialog = useDialogSize("image", { fillsHeight: true });
  if (!urls.length) return null;

  return (
    <>
      <div className={`flex flex-wrap items-start gap-2 ${className}`}>
        {urls.map((url, index) => (
          <button
            key={index}
            type="button"
            aria-label={`Show image ${index + 1} full size`}
            onClick={() => setShownUrl(url)}
            className="max-w-full overflow-hidden rounded-md border border-white/10 bg-black/30 outline-none transition-colors hover:border-white/30 focus-visible:ring-2 focus-visible:ring-blue-400/60"
          >
            <img src={url} alt="" decoding="async" className="block max-h-32 max-w-full object-contain" />
          </button>
        ))}
      </div>
      {shownUrl ? (
        <Modal label="Image" onClose={() => setShownUrl(null)} className="bg-(--surface-inset)" style={dialog.style} resize={dialog.resize}>
          <img src={shownUrl} alt="" className="block h-full w-full object-contain" />
        </Modal>
      ) : null}
    </>
  );
}
