import type { ReactNode } from "react";

/** The colours of a chip naming the agent's state: amber for a question, green once its work is done, red for a failure. */
export const AGENT_CHIP = {
  question: "border-amber-400/40 bg-amber-400/10 text-amber-300",
  done: "border-emerald-400/40 bg-emerald-400/10 text-emerald-300",
  failed: "border-red-400/40 bg-red-400/10 text-red-300",
};

/** A small bordered label at the end of a title line, as in the lists of pull requests and session VMs and the chat header. */
export function Chip({ className, title, children }: { className: string; title?: string; children: ReactNode }) {
  return (
    <span className={`flex shrink-0 items-center gap-1 rounded-md border px-1.5 text-[11px] whitespace-nowrap ${className}`} title={title}>
      {children}
    </span>
  );
}
