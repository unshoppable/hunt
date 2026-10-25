import { create } from "zustand";

/** How long a success stays on screen; a failure stays until it is closed. */
export const SUCCESS_TOAST_MS = 4000;
/** Toasts shown at once; a new one pushes out the oldest. */
export const MAX_TOASTS = 4;

export type ToastTone = "success" | "error";

/** The outcome of an async action, shown in the window's bottom right corner (`ui/StatusToasts.tsx`). */
export type StatusToast = { id: number; tone: ToastTone; message: string };

/** `toasts` with `toast` appended, keeping the newest `MAX_TOASTS`. */
export function withToast(toasts: readonly StatusToast[], toast: StatusToast): StatusToast[] {
  return [...toasts, toast].slice(-MAX_TOASTS);
}

type StatusToastState = {
  toasts: StatusToast[];
  /** Shows `message`; a success closes itself after `SUCCESS_TOAST_MS`. */
  showToast: (tone: ToastTone, message: string) => void;
  dismissToast: (id: number) => void;
};

let nextToastId = 1;

/** The status toasts of this window; every window has a store of its own. */
export const useStatusToastStore = create<StatusToastState>((set, get) => ({
  toasts: [],

  showToast: (tone, message) => {
    const id = nextToastId++;
    set((state) => ({ toasts: withToast(state.toasts, { id, tone, message }) }));
    if (tone === "success") {
      setTimeout(() => get().dismissToast(id), SUCCESS_TOAST_MS);
    }
  },

  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
}));

/** Reports that an async action succeeded; for event handlers and plain functions outside React. */
export function reportSuccess(message: string) {
  useStatusToastStore.getState().showToast("success", message);
}

/** Reports that an async action failed; the toast stays until the user closes it. */
export function reportFailure(message: string) {
  useStatusToastStore.getState().showToast("error", message);
}
