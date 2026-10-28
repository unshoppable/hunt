import { useStatusToastStore } from "./status-toasts.store";
import { ICON_BUTTON_XS } from "./buttons.constants";
import { AlertIcon, CheckIcon, CloseIcon } from "./Icons";

/**
 * The outcomes of async actions (`reportSuccess`, `reportFailure` in `ui/status-toasts.store.ts`), stacked in the window's
 * bottom right corner, the newest at the bottom. A success closes itself, a failure stays until its × is clicked. Each
 * card carries its tone as a colored bar at the left and a tinted icon badge.
 */
export function StatusToasts() {
  const toasts = useStatusToastStore((state) => state.toasts);
  const dismissToast = useStatusToastStore((state) => state.dismissToast);
  if (!toasts.length) return null;
  return (
    <div className="pointer-events-none fixed right-5 bottom-5 z-[70] flex w-[min(440px,calc(100vw-40px))] flex-col items-end gap-2.5">
      {toasts.map((toast) => {
        const isError = toast.tone === "error";
        return (
          <div
            key={toast.id}
            role={isError ? "alert" : "status"}
            className={`pointer-events-auto flex w-full items-start gap-3 overflow-hidden rounded-xl border border-white/10 bg-(--surface-inspector)/90 py-3 pr-2 pl-4 text-[13.5px] leading-snug text-neutral-100 shadow-[0_12px_40px_rgba(0,0,0,0.55),0_0_0_1px_rgba(0,0,0,0.4)] ring-1 ring-black/40 backdrop-blur-xl transition duration-300 ease-out starting:translate-x-4 starting:opacity-0 ${
              isError ? "border-l-[3px] border-l-red-400/90" : "border-l-[3px] border-l-green-400/90"
            }`}
          >
            <span
              className={`mt-px flex size-7 shrink-0 items-center justify-center rounded-full ${isError ? "bg-red-400/15 text-red-300" : "bg-green-400/15 text-green-300"}`}
            >
              {isError ? <AlertIcon className="size-4" /> : <CheckIcon className="size-4" />}
            </span>
            <div className="min-w-0 flex-1 py-0.5">
              <p className="mb-0.5 text-[11px] font-semibold tracking-wide text-neutral-400 uppercase">{isError ? "Failed" : "Done"}</p>
              <p className="max-h-60 overflow-y-auto break-words whitespace-pre-wrap select-text">{toast.message}</p>
            </div>
            <button type="button" onClick={() => dismissToast(toast.id)} className={`${ICON_BUTTON_XS} -mt-1`} title="Close" aria-label="Close">
              <CloseIcon />
            </button>
          </div>
        );
      })}
    </div>
  );
}
