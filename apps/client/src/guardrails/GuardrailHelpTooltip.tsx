import { createPortal } from "react-dom";
import type { HoverAnchor } from "../ui/hover-anchor.hook";
import type { GuardrailKind } from "./guardrail.types";
import { KIND_LABELS, kindHelp } from "./guardrail-kind.utils";
import { LINT_HELP, LINT_TAB_LABEL } from "./lint-rules.utils";

/** A tab of the window: a guardrail kind, or the ESLint rules (see LintRulesPane.tsx). */
export type GuardrailTab = GuardrailKind | "lint";

/** How long the mouse rests on a tab before its kind's explanation shows. */
export const HELP_OPEN_DELAY = 700;
const HELP_WIDTH = 480;
const HELP_MARGIN = 8;

/** Explanation of the hovered tab's kind below it (`anchor`); the mouse may move into it to select its text. */
export function GuardrailHelpTooltip({ anchor, onEnter, onLeave }: { anchor: HoverAnchor<GuardrailTab>; onEnter: () => void; onLeave: () => void }) {
  const title = anchor.key === "lint" ? LINT_TAB_LABEL : KIND_LABELS[anchor.key].plural;
  const help = anchor.key === "lint" ? LINT_HELP : kindHelp(anchor.key);
  const width = Math.min(HELP_WIDTH, window.innerWidth - 2 * HELP_MARGIN);
  const left = Math.max(HELP_MARGIN, Math.min(anchor.rect.left, window.innerWidth - width - HELP_MARGIN));

  return createPortal(
    <div
      role="tooltip"
      aria-label={title}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      className="fixed z-50 overflow-y-auto rounded-md border border-neutral-600 bg-(--surface-inset) p-3.5 text-[14px] leading-relaxed text-neutral-200 shadow-lg shadow-black/40"
      style={{ width, left, top: anchor.rect.bottom + 4, maxHeight: window.innerHeight - anchor.rect.bottom - 4 - HELP_MARGIN }}
    >
      <h3 className="mb-1 font-semibold text-neutral-100">{title}</h3>
      <p>{help.what}</p>
      <h4 className="mt-2.5 font-semibold text-neutral-100">How it is loaded</h4>
      <p>{help.loading}</p>
      <h4 className="mt-2.5 font-semibold text-neutral-100">When to use it</h4>
      <p>{help.use}</p>
    </div>,
    document.body,
  );
}
