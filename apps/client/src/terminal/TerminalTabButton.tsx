import type { Description, Tone } from "../preview/preview-services.utils";
import { SessionMark } from "../sessions/SessionMark";
import { TAB_ACTIVE, TAB_BUTTON_SM, TAB_INACTIVE } from "../ui/buttons.constants";
import { CloseIcon } from "../ui/Icons";

const TONE_DOT: Record<Tone, string> = {
  ok: "bg-green-400",
  pending: "bg-neutral-400",
  warning: "bg-amber-300",
  error: "bg-red-400",
  idle: "bg-neutral-600",
};

/**
 * A tab of a Terminal panel's strip, with a dot for `state` when given, the mark of the other session the window belongs
 * to (`owner`) and × to end its process (also by middle click).
 */
export function TerminalTabButton({
  label,
  title,
  state,
  owner,
  isActive,
  onActivate,
  onClose,
}: {
  label: string;
  title: string;
  state: Description | null;
  owner: { id: string; mark: string } | null;
  isActive: boolean;
  onActivate: () => void;
  onClose: (() => void) | null;
}) {
  return (
    <div
      role="tab"
      aria-selected={isActive}
      title={title}
      onClick={onActivate}
      onAuxClick={(event) => {
        if (event.button === 1) {
          onClose?.();
        }
      }}
      className={`${TAB_BUTTON_SM} group cursor-pointer gap-1.5 ${isActive ? TAB_ACTIVE : TAB_INACTIVE}`}
    >
      {state ? <span className={`size-2 shrink-0 rounded-full ${TONE_DOT[state.tone]}`} title={state.text} /> : null}
      {owner ? <SessionMark sessionId={owner.id} mark={owner.mark} /> : null}
      <span className="whitespace-nowrap">{label}</span>
      {onClose ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
          title="End the process"
          className={`-my-1 -mr-1 flex size-5 items-center justify-center rounded text-neutral-500 hover:bg-white/10 hover:text-white ${isActive ? "" : "opacity-0 group-hover:opacity-100"}`}
        >
          <CloseIcon className="size-3" />
        </button>
      ) : null}
    </div>
  );
}
