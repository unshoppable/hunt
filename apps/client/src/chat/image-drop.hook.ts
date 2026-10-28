import { useEffect, useRef, useState, type RefObject } from "react";
import { commands } from "../ipc/commands";
import { listenToFileDrag } from "../ipc/events";
import type { Screenshot } from "./chat.types";

type ImageDropHandlers = {
  /** The image files dropped inside the zone, in drop order. */
  onDrop: (images: Screenshot[]) => void;
  /** Files were dropped inside the zone, but none of them is an image. */
  onNoImages: () => void;
};

type Point = { x: number; y: number };

/**
 * Takes native file drops inside `zoneRef`, resolving the image files among the dragged paths through the backend.
 * Returns whether a drag that carries at least one image is over the zone right now, for highlighting the target.
 * The handlers are read when the drop happens, so they may be fresh closures.
 */
export function useImageDrop(zoneRef: RefObject<HTMLElement | null>, handlers: ImageDropHandlers): boolean {
  const [isOver, setIsOver] = useState(false);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    /** The images among the files of the current drag; null between drags. */
    let dragged: Promise<Screenshot[]> | null = null;
    let hasImages = false;
    let position: Point = { x: -1, y: -1 };

    const isInside = (point: Point) => {
      const rect = zoneRef.current?.getBoundingClientRect();
      if (!rect) return false;
      return point.x >= rect.left && point.x < rect.right && point.y >= rect.top && point.y < rect.bottom;
    };
    const reset = () => {
      dragged = null;
      hasImages = false;
      setIsOver(false);
    };

    const unlisten = listenToFileDrag((event) => {
      if (event.type === "leave") {
        reset();
        return;
      }
      position = event.position;
      if (event.type === "enter") {
        const images = commands.imageFiles(event.paths).catch(() => []);
        dragged = images;
        void images.then((found) => {
          if (dragged !== images) return;
          hasImages = found.length > 0;
          setIsOver(hasImages && isInside(position));
        });
        return;
      }
      if (event.type === "over") {
        setIsOver(hasImages && isInside(position));
        return;
      }
      const images = dragged ?? commands.imageFiles(event.paths).catch(() => []);
      if (isInside(position)) {
        void images.then((found) => (found.length ? handlersRef.current.onDrop(found) : handlersRef.current.onNoImages()));
      }
      reset();
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, [zoneRef]);

  return isOver;
}
