import { useOnViewportChange, useReactFlow, useStore, type Viewport } from "@xyflow/react";
import { snapViewport } from "./viewport.utils";

/**
 * Keeps the text and lines of the surrounding diagram sharp. xyflow scales its viewport with a CSS transform, which
 * WebKit draws as a bitmap rasterized at 100 % and then scaled, so at any other zoom the diagram blurs. Once the view
 * comes to rest (wheel, drag, fitView, minimap, search) its pan is rounded to whole device pixels, since a fractional
 * pan smears text over two pixel rows as well, and the scale moves from the transform into CSS `zoom`, which lays the
 * diagram out at its shown size. Only above 100 %: zoomed out, WebKit raises the shrunken text to its minimum font
 * size, so it overflows its rows, while a bitmap scaled down stays sharp. The next move hands the scale back to the
 * transform, which is cheap to animate.
 * xyflow measures nodes and handles in diagram units either way.
 */
export function SharpViewport() {
  const { setViewport } = useReactFlow();
  const domNode = useStore((state) => state.domNode);
  const viewportElement = () => domNode?.querySelector<HTMLElement>(".react-flow__viewport") ?? null;
  useOnViewportChange({
    onStart: (viewport) => {
      const element = viewportElement();
      if (element) scaleByTransform(element, viewport);
    },
    onEnd: (viewport) => {
      const snapped = snapViewport(viewport, window.devicePixelRatio);
      if (snapped.x !== viewport.x || snapped.y !== viewport.y) {
        void setViewport(snapped);
        return;
      }
      const element = viewportElement();
      if (element && viewport.zoom > 1) scaleByZoom(element, viewport);
    },
  });
  return null;
}

/** xyflow's own styling of the viewport. */
function scaleByTransform(element: HTMLElement, { x, y, zoom }: Viewport): void {
  element.style.zoom = "";
  element.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
}

/** `zoom` scales the translation too, so it is divided out. */
function scaleByZoom(element: HTMLElement, { x, y, zoom }: Viewport): void {
  element.style.zoom = String(zoom);
  element.style.transform = `translate(${x / zoom}px, ${y / zoom}px)`;
}
