import type { MouseEvent } from "react";
import { KIND_LABELS } from "../guardrails/guardrails";
import { SaveIcon } from "../ui/icons";
import type { GuardrailSuggestion } from "./guardrailSuggestion";

/**
 * "Guardrail" button at the right end of the row above the prompt box. It opens the guardrail sub chat at itself (`onOpen`
 * gets its bounds). While the agent suggests a guardrail (`suggestion`) it turns violet, names the suggested kind and shows
 * the summary on hover, so clicking it takes up the suggestion; the guardrail sub chat's "Decline" button declines it.
 */
export function SaveGuardrailButton({
  suggestion,
  isDisabled,
  onOpen,
}: {
  suggestion: GuardrailSuggestion | null;
  isDisabled: boolean;
  onOpen: (bounds: DOMRect) => void;
}) {
  const kindLabel = suggestion ? KIND_LABELS[suggestion.kind].singular : "";
  return (
    <button
      type="button"
      onClick={(event: MouseEvent<HTMLButtonElement>) => onOpen(event.currentTarget.getBoundingClientRect())}
      disabled={isDisabled}
      title={suggestion ? `${kindLabel}: ${suggestion.summary}` : undefined}
      className={`ml-auto flex h-[31px] items-center gap-1.5 rounded-md px-[9.5px] text-[14px] transition-colors disabled:pointer-events-none disabled:opacity-40 ${suggestion ? "hunt-guardrail-suggested text-white" : "text-neutral-400 hover:bg-(--row-hover) hover:text-white"}`}
    >
      <SaveIcon className="size-4" />
      Guardrail
      {suggestion ? <span className="rounded bg-[#7c6cff]/40 px-1.5 text-[12px] font-medium leading-[18px]">{kindLabel}</span> : null}
    </button>
  );
}
