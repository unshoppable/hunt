import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useEscapeToClose } from "./useEscapeToClose";

type ModalProps = {
  /** Name of the dialog for assistive technology. */
  label: string;
  /** Called on Escape and on a mouse press on the backdrop; the dialog stays while `isCloseable` is false (e.g. busy). */
  onClose: () => void;
  isCloseable?: boolean;
  /** Vertical placement: centered by default, `top` keeps the dialog near the top like a command palette. */
  align?: "center" | "top";
  /** Classes of the dialog panel: width, padding and surface; the border, radius and shadow are shared. */
  className: string;
  children: ReactNode;
};

/**
 * A dialog over a dimmed backdrop above everything else in the window, closed by Escape or a press on the backdrop.
 * Keyboard shortcuts of the page do not fire while it is open (see useEscapeToClose); other keys reach the dialog.
 */
export function Modal({ label, onClose, isCloseable = true, align = "center", className, children }: ModalProps) {
  useEscapeToClose(onClose, isCloseable);
  const alignment = align === "top" ? "items-start pt-[8vh]" : "items-center";
  return createPortal(
    <div className={`fixed inset-0 z-[60] flex justify-center bg-black/50 ${alignment}`} onMouseDown={isCloseable ? onClose : undefined}>
      <div
        role="dialog"
        aria-label={label}
        className={`flex flex-col overflow-hidden rounded-xl border border-neutral-600 shadow-2xl shadow-black/60 ${className}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
