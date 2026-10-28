import type { ReactNode } from "react";
import type { IconRule } from "./settings.store";
import { ICON_BUTTON_SM } from "../ui/buttons.constants";
import { TrashIcon } from "../ui/Icons";
import { IconPicker } from "./IconPicker";
import { DraftInput } from "./SettingsFields";

/** One rule: its glob, the icon picker over `icons`, extra controls (`children`) and the buttons that order and delete it. */
export function IconRuleRow({
  rule,
  icons,
  globExample = "apps/api/**",
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
  children,
}: {
  rule: IconRule;
  icons?: readonly string[];
  globExample?: string;
  onChange: (patch: Partial<IconRule>) => void;
  onRemove: () => void;
  onMoveUp: (() => void) | undefined;
  onMoveDown: (() => void) | undefined;
  children?: ReactNode;
}) {
  return (
    <li className="flex items-center gap-2">
      <DraftInput value={rule.glob} onCommit={(glob) => onChange({ glob })} placeholder={`Glob, e.g. ${globExample}`} ariaLabel="Glob" title={rule.glob} className="min-w-0 flex-1" />
      <IconPicker value={rule.icon} onChange={(icon) => onChange({ icon })} icons={icons} className="w-52" />
      {children}
      <button type="button" onClick={onMoveUp} disabled={!onMoveUp} className={ICON_BUTTON_SM} aria-label="Move rule up">
        <ArrowIcon direction="up" />
      </button>
      <button type="button" onClick={onMoveDown} disabled={!onMoveDown} className={ICON_BUTTON_SM} aria-label="Move rule down">
        <ArrowIcon direction="down" />
      </button>
      <button type="button" onClick={onRemove} className={`${ICON_BUTTON_SM} hover:text-red-300`} aria-label="Delete rule">
        <TrashIcon />
      </button>
    </li>
  );
}

function ArrowIcon({ direction }: { direction: "up" | "down" }) {
  return (
    <svg viewBox="0 0 16 16" className={`size-3.5 ${direction === "down" ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
    </svg>
  );
}
