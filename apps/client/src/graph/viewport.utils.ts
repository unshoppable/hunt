import type { Viewport } from "@xyflow/react";

/** The viewport with its pan rounded to whole device pixels; the zoom stays. */
export function snapViewport(viewport: Viewport, pixelRatio: number): Viewport {
  return { x: Math.round(viewport.x * pixelRatio) / pixelRatio, y: Math.round(viewport.y * pixelRatio) / pixelRatio, zoom: viewport.zoom };
}
