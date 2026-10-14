import type { ReactNode } from "react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";

/** Resizable pane group whose layout survives restarts (persisted in localStorage under `id`). */
export function PersistentGroup({
  id,
  orientation = "horizontal",
  className,
  children,
}: {
  id: string;
  orientation?: "horizontal" | "vertical";
  className?: string;
  children: ReactNode;
}) {
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ groupId: id, onlySaveAfterUserInteractions: true });
  return (
    <Group id={id} orientation={orientation} defaultLayout={defaultLayout} onLayoutChanged={onLayoutChanged} className={className}>
      {children}
    </Group>
  );
}

export function PaneSeparator({ orientation = "horizontal" }: { orientation?: "horizontal" | "vertical" }) {
  const isHorizontal = orientation === "horizontal";
  return (
    <Separator
      className={`group relative shrink-0 bg-(--line) transition-colors hover:bg-blue-500 data-[separator=active]:bg-blue-500 ${isHorizontal ? "w-px cursor-col-resize" : "h-px cursor-row-resize"}`}
    >
      <span className={`absolute ${isHorizontal ? "-left-1 top-0 h-full w-2" : "-top-1 left-0 h-2 w-full"}`} />
    </Separator>
  );
}

export { Panel };
