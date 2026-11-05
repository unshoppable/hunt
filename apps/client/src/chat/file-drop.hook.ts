import { useEffect, useRef, useState, type RefObject } from "react";
import { commands } from "../ipc/commands";
import { listenToFileDrag } from "../ipc/events";
import type { Screenshot } from "./chat.types";

type FileDropHandlers = {
  /** Whether the zone takes files other than images; without it a drag highlights the zone only when it carries an image. */
  acceptsFiles: boolean;
  /** The image files dropped inside the zone and the paths of the other dropped files and folders, each in drop order. */
  onDrop: (images: Screenshot[], others: string[]) => void;
};

type Point = { x: number; y: number };

/**
 * Takes native file drops inside `zoneRef`, resolving the image files among the dragged paths through the backend.
 * Returns whether a drag the zone takes is over it right now, for highlighting the target.
 * The handlers are read when the drop happens, so they may be fresh closures.
 */
export function useFileDrop(zoneRef: RefObject<HTMLElement | null>, handlers: FileDropHandlers): boolean {
  const [isOver, setIsOver] = useState(false);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    /** The images among the files of the current drag; null between drags. */
    let dragged: Promise<Screenshot[]> | null = null;
    let isTaken = false;
    let position: Point = { x: -1, y: -1 };

    const isInside = (point: Point) => {
      const rect = zoneRef.current?.getBoundingClientRect();
      if (!rect) return false;
      return point.x >= rect.left && point.x < rect.right && point.y >= rect.top && point.y < rect.bottom;
    };
    const reset = () => {
      dragged = null;
      isTaken = false;
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
        const hasFiles = event.paths.length > 0;
        dragged = images;
        void images.then((found) => {
          if (dragged !== images) return;
          isTaken = found.length > 0 || (hasFiles && handlersRef.current.acceptsFiles);
          setIsOver(isTaken && isInside(position));
        });
        return;
      }
      if (event.type === "over") {
        setIsOver(isTaken && isInside(position));
        return;
      }
      const images = dragged ?? commands.imageFiles(event.paths).catch(() => []);
      const paths = event.paths;
      if (isInside(position)) {
        void images.then((found) => {
          const imagePaths = new Set(found.map((image) => image.path));
          handlersRef.current.onDrop(found, paths.filter((path) => !imagePaths.has(path)));
        });
      }
      reset();
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, [zoneRef]);

  return isOver;
}
