import { KIND_LABELS } from "../../guardrails/guardrail-kind.utils";
import type { GuardrailKind } from "../../guardrails/guardrail.types";

/**
 * Card at the top of the guardrail chat: the kind of the guardrail the agent suggested and why the agent deems it worth
 * recording, so that the user can judge the request before sending it.
 */
export function SuggestedGuardrailCard({ kind, reason }: { kind: GuardrailKind; reason: string }) {
  return (
    <div className="rounded-lg border border-[#7c6cff]/60 bg-[#7c6cff]/10 px-3 py-2.5">
      <div className="flex items-center gap-2 text-[13px] text-neutral-400">
        Suggested guardrail
        <span className="rounded bg-[#7c6cff]/40 px-1.5 text-[13px] font-medium leading-[20px] text-white">{KIND_LABELS[kind].singular}</span>
      </div>
      {reason ? <p className="mt-2 text-[14px] leading-snug text-neutral-300">{reason}</p> : null}
    </div>
  );
}
