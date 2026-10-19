/** A branch or tag label of a commit; `head` is the checked-out branch (`HEAD -> name`) or a detached `HEAD`. */
export type DecorationChip = { kind: "head" | "local" | "remote" | "tag"; name: string };

/** Reads one entry of `git log --decorate`: `HEAD -> master`, `HEAD`, `tag: v1.0`, `origin/master` or `master`. */
export function parseDecoration(decoration: string): DecorationChip {
  if (decoration.startsWith("HEAD -> ")) return { kind: "head", name: decoration.slice("HEAD -> ".length) };
  if (decoration === "HEAD") return { kind: "head", name: "HEAD" };
  if (decoration.startsWith("tag: ")) return { kind: "tag", name: decoration.slice("tag: ".length) };
  if (decoration.includes("/")) return { kind: "remote", name: decoration };
  return { kind: "local", name: decoration };
}

const CHIP_CLASS: Record<DecorationChip["kind"], string> = {
  head: "border-blue-400/60 bg-blue-400/15 text-blue-100",
  local: "border-white/15 bg-white/8 text-neutral-200",
  remote: "border-white/10 bg-white/4 text-neutral-400",
  tag: "border-amber-400/40 bg-amber-400/10 text-amber-200",
};

/** The label of a branch or tag in a log row or the commit details; the checked-out branch's is highlighted. */
export function RefChip({ chip, isHead = false }: { chip: DecorationChip; isHead?: boolean }) {
  const kind = isHead && chip.kind === "local" ? "head" : chip.kind;
  return (
    <span className={`inline-flex max-w-48 shrink-0 items-center truncate rounded border px-1 text-[0.85em] leading-[1.6] ${CHIP_CLASS[kind]}`} title={chip.kind === "tag" ? `Tag ${chip.name}` : chip.name}>
      {chip.name}
    </span>
  );
}
