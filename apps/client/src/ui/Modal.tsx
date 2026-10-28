import type { CSSProperties, ReactNode } from "react";
import { createPortal } from "react-dom";
import { ResizeGrips, type ResizeHandlers } from "./ResizeGrips";
import { useEscapeToClose } from "./escape-to-close.hook";

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
  /** Inline size of the dialog panel, e.g. a remembered width and height. */
  style?: CSSProperties;
  /**
   * Makes the dialog resizable by dragging its edges (see usePopupSize): the sides and the bottom, plus the top
   * when it is centered. A dragged side moves both sides, because the dialog stays centered.
   */
  resize?: ResizeHandlers;
  children: ReactNode;
};

/**
 * A dialog over a dimmed backdrop above everything else in the window, closed by Escape or a press on the backdrop.
 * Keyboard shortcuts of the page do not fire while it is open (see useEscapeToClose); other keys reach the dialog.
 */
export function Modal({ label, onClose, isCloseable = true, align = "center", className, style, resize, children }: ModalProps) {
  useEscapeToClose(onClose, isCloseable);
  const isCentered = align === "center";
  const alignment = isCentered ? "items-center" : "items-start pt-[8vh]";
  return createPortal(
    <div className={`fixed inset-0 z-[60] flex justify-center bg-black/50 ${alignment}`} onMouseDown={isCloseable ? onClose : undefined}>
      <div
        role="dialog"
        aria-label={label}
        className={`relative flex flex-col overflow-hidden rounded-xl border border-neutral-600 shadow-2xl shadow-black/60 ${className}`}
        style={style}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {children}
        {resize ? <ResizeGrips edges={{ left: true, right: true, bottom: true, top: isCentered }} centered={{ x: true, y: isCentered }} {...resize} /> : null}
      </div>
    </div>,
    document.body,
  );
}
