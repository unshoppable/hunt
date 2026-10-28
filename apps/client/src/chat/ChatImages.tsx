import { useMemo, useState } from "react";
import { PopupModeButton, PopupWindowTitleBar } from "../ui/PopupTitleBar";
import { useDetachedPopup } from "../ui/detached-popup.hook";
import { useSettingsStore } from "../settings/settings.store";
import { Modal } from "../ui/Modal";
import { useDialogSize } from "../ui/dialog-size.hook";

/**
 * Images of a chat message or tool result as a row of thumbnails; a click on one shows it full size, fitted into a
 * dialog the user resizes by dragging its edges or into a window of its own (see ui/detached-popup.hook.ts). `urls`
 * are asset URLs of screenshots the user attached or `data:` URLs that `imageDataUrl` (chat/image-data.utils.ts) accepted;
 * they are only ever loaded by an `<img>`.
 */
export function ChatImages({ urls, className = "" }: { urls: string[]; className?: string }) {
  const [shownUrl, setShownUrl] = useState<string | null>(null);
  const isDetached = useSettingsStore((state) => state.detachedPopups.image);
  if (!urls.length) return null;

  const close = () => setShownUrl(null);
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
      {shownUrl ? isDetached ? <DetachedImage url={shownUrl} onClose={close} /> : <ImageDialog url={shownUrl} onClose={close} /> : null}
    </>
  );
}

/** What the image window shows (see ui/popup-protocol.utils.ts). */
export type ImageContent = { url: string };

function ImageDialog({ url, onClose }: { url: string; onClose: () => void }) {
  const dialog = useDialogSize("image", { fillsHeight: true });
  return (
    <Modal label="Image" onClose={onClose} className="bg-(--surface-inset)" style={dialog.style} resize={dialog.resize}>
      <img src={url} alt="" className="block h-full w-full object-contain" />
      <span className="absolute top-2 right-2 rounded-md bg-black/50">
        <PopupModeButton popupKey="image" isDetached={false} />
      </span>
    </Modal>
  );
}

/** The image window's host side. */
function DetachedImage({ url, onClose }: { url: string; onClose: () => void }) {
  const content = useMemo<ImageContent>(() => ({ url }), [url]);
  useDetachedPopup("image", content, { revision: url, anchor: () => "center", onAction: () => {}, onClose });
  return null;
}

/** The image window's page side (see popup/PopupWindow.tsx): the image fitted into the window. */
export function ImageWindowContent({ content }: { content: ImageContent }) {
  return (
    <div className="flex h-screen flex-col bg-(--surface-inset)">
      <PopupWindowTitleBar popupKey="image">
        <span className="min-w-0 flex-1 truncate text-neutral-300">Image</span>
      </PopupWindowTitleBar>
      <img src={content.url} alt="" className="block min-h-0 w-full flex-1 object-contain" />
    </div>
  );
}
