import type { DecorationChip } from "./logLabels";

const CHIP_CLASS: Record<DecorationChip["kind"], string> = {
  head: "bg-blue-400/20 text-blue-100",
  local: "bg-white/8 text-neutral-200",
  remote: "bg-white/5 text-neutral-400",
  tag: "bg-amber-400/12 text-amber-200",
};

/** The label of a branch or tag in the commit details, one per ref; the checked-out branch's is highlighted. */
export function RefChip({ chip, isHead = false }: { chip: DecorationChip; isHead?: boolean }) {
  const kind = isHead && chip.kind === "local" ? "head" : chip.kind;
  return (
    <span className={`inline-flex max-w-48 shrink-0 items-center truncate rounded px-1.5 text-[0.85em] leading-[1.6] ${CHIP_CLASS[kind]}`} title={chip.kind === "tag" ? `Tag ${chip.name}` : chip.name}>
      {chip.name}
    </span>
  );
}
