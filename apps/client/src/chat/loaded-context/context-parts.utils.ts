import type { ContextPart, ContextPartKind } from "./loaded-context.types";

/** Label and text color of each kind of context part, in the order the kind filter lists them. */
export const PART_KINDS: Record<ContextPartKind, { label: string; colorClass: string; borderClass: string }> = {
  systemPrompt: { label: "System prompt", colorClass: "text-rose-300", borderClass: "border-rose-300/60" },
  tools: { label: "Tools", colorClass: "text-orange-300", borderClass: "border-orange-300/60" },
  instructions: { label: "Instructions", colorClass: "text-amber-300", borderClass: "border-amber-300/60" },
  skill: { label: "Skill", colorClass: "text-violet-300", borderClass: "border-violet-300/60" },
  reminder: { label: "Reminder", colorClass: "text-neutral-400", borderClass: "border-neutral-400/60" },
  summary: { label: "Summary", colorClass: "text-teal-300", borderClass: "border-teal-300/60" },
  user: { label: "User", colorClass: "text-sky-300", borderClass: "border-sky-300/60" },
  assistant: { label: "Assistant", colorClass: "text-emerald-300", borderClass: "border-emerald-300/60" },
  thinking: { label: "Thinking", colorClass: "text-neutral-500", borderClass: "border-neutral-500/60" },
  toolCall: { label: "Tool call", colorClass: "text-indigo-300", borderClass: "border-indigo-300/60" },
  toolResult: { label: "Tool result", colorClass: "text-slate-300", borderClass: "border-slate-300/60" },
};

/** Parts at most this long start expanded, as do prompts and replies; the rest start collapsed. */
const SHORT_PART_CHARS = 400;

/** Characters per token for the estimate shown beside each part; Claude's tokenizer averages about four on English and code. */
const CHARS_PER_TOKEN = 4;

/** The rough number of tokens `text` takes in the context. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Whether a part starts expanded: prompts, replies and the compaction summary always, other parts while they are short. */
export function startsExpanded(part: ContextPart): boolean {
  return part.kind === "user" || part.kind === "assistant" || part.kind === "summary" || part.text.length <= SHORT_PART_CHARS;
}

/** The kinds that occur in `parts` with their count and estimated tokens, in the order of `PART_KINDS`. */
export function partKindTotals(parts: ContextPart[]): { kind: ContextPartKind; count: number; tokens: number }[] {
  return (Object.keys(PART_KINDS) as ContextPartKind[])
    .map((kind) => {
      const ofKind = parts.filter((part) => part.kind === kind);
      return { kind, count: ofKind.length, tokens: ofKind.reduce((sum, part) => sum + estimateTokens(part.text), 0) };
    })
    .filter((total) => total.count);
}
