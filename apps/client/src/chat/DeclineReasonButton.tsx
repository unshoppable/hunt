import { useId, useRef, useState, type KeyboardEvent } from "react";
import type { GuardrailDeclineReason } from "../ipc/types";
import { GHOST_BUTTON_XS } from "../ui/buttons";
import { OptionMenu } from "../ui/Dropdown";
import { stepEnabled } from "../ui/floatingMenu";
import { DECLINE_REASONS } from "./guardrailSuggestion";

/**
 * "Decline" button of the guardrail chat that asks why first: a click or an arrow key opens the reasons, a click on one
 * or Enter on the highlighted one calls `onDecline` with it; Escape or a click outside closes the list.
 */
export function DeclineReasonButton({ disabled, onDecline }: { disabled: boolean; onDecline: (reason: GuardrailDeclineReason) => void }) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  function pick(index: number) {
    setIsOpen(false);
    onDecline(DECLINE_REASONS[index].id);
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex(stepEnabled(DECLINE_REASONS, isOpen ? activeIndex : -1, event.key === "ArrowDown" ? 1 : -1));
      setIsOpen(true);
      return;
    }
    if (event.key !== "Enter" || !isOpen || activeIndex < 0) return;
    event.preventDefault();
    pick(activeIndex);
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => {
          setActiveIndex(-1);
          setIsOpen(!isOpen);
        }}
        onKeyDown={onKeyDown}
        disabled={disabled}
        title="Decline the suggestion and close"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={isOpen ? listId : undefined}
        className={GHOST_BUTTON_XS}
      >
        Decline
      </button>
      {isOpen ? (
        <OptionMenu
          id={listId}
          label="Why do you decline the suggestion?"
          options={DECLINE_REASONS}
          selectedId={null}
          activeIndex={activeIndex}
          onActivate={setActiveIndex}
          onPick={pick}
          onClose={() => setIsOpen(false)}
          anchorRef={buttonRef}
        />
      ) : null}
    </>
  );
}
