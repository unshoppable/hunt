import { Dropdown } from "../ui/Dropdown";
import type { DropdownOption } from "../ui/floating-menu.utils";

/** Borderless dropdown pill for the prompt toolbar, e.g. model, effort or mode. */
export function PillSelect({
  value,
  options,
  onChange,
  disabled = false,
  title,
  className = "",
}: {
  value: string;
  options: DropdownOption[];
  onChange: (id: string) => void;
  disabled?: boolean;
  title: string;
  /** Text color classes replacing the neutral default, e.g. the accent of the current mode. */
  className?: string;
}) {
  return (
    <Dropdown
      title={title}
      value={value}
      options={options}
      onChange={onChange}
      disabled={disabled}
      className={`inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md pl-2.5 pr-1.5 text-sm outline-none transition-colors hover:bg-(--row-hover) disabled:opacity-50 ${className || "text-neutral-300"}`}
    />
  );
}
