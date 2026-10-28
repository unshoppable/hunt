import { CommentIcon } from "../ui/Icons";

/**
 * Review comments of a file as a speech bubble with their count; nothing while there are none. The text size comes
 * from `className` or the parent. `isGhost` renders an invisible copy without tooltip that only reserves the room, so
 * text beside it truncates before the visible one.
 */
export function CommentCount({
  count,
  className = "",
  iconClassName = "size-4",
  isGhost = false,
}: {
  count: number;
  className?: string;
  iconClassName?: string;
  isGhost?: boolean;
}) {
  if (!count) return null;
  return (
    <span
      className={`flex shrink-0 items-center gap-1 text-neutral-400 tabular-nums ${className}`}
      title={isGhost ? undefined : `${count} review ${count === 1 ? "comment" : "comments"}`}
      aria-hidden={isGhost}
    >
      <CommentIcon className={iconClassName} />
      {/* Lifted to the middle of the bubble, which sits above its tail. */}
      <span className="relative -top-px">{count}</span>
    </span>
  );
}
