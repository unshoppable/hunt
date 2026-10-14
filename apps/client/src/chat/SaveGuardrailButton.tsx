import type { MouseEvent } from "react";
import { AGENT_GLOW } from "../ui/buttons";
import { SaveIcon } from "../ui/icons";

/**
 * "Guardrail" button at the right end of the row above the prompt box. It opens the guardrail sub chat at itself (`onOpen`
 * gets its bounds) and glows while the agent suggests a guardrail (`isSuggested`), so clicking it takes up the suggestion.
 */
export function SaveGuardrailButton({ isSuggested, isDisabled, onOpen }: { isSuggested: boolean; isDisabled: boolean; onOpen: (bounds: DOMRect) => void }) {
  return (
    <button
      type="button"
      onClick={(event: MouseEvent<HTMLButtonElement>) => onOpen(event.currentTarget.getBoundingClientRect())}
      disabled={isDisabled}
      className={`ml-auto flex h-[31px] items-center gap-1.5 rounded-md px-[9.5px] text-[14px] transition-colors hover:bg-(--row-hover) hover:text-white disabled:pointer-events-none disabled:opacity-40 ${isSuggested ? `${AGENT_GLOW} text-white` : "text-neutral-400"}`}
    >
      <SaveIcon className="size-4" />
      Guardrail
    </button>
  );
}
