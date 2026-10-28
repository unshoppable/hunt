import { usageColor } from "./usage-color.utils";

/** A thin fill bar for a percentage (0–100), colored along the pastel green-to-red scale of `usageColor`. Callers set the width. */
export function UsageBar({ percent, className = "" }: { percent: number; className?: string }) {
  const width = Math.min(Math.max(percent, 0), 100);
  return (
    <span aria-hidden="true" className={`block h-1 overflow-hidden rounded-full bg-white/10 ${className}`}>
      <span className="block h-full rounded-full" style={{ width: `${width}%`, backgroundColor: usageColor(percent) }} />
    </span>
  );
}
