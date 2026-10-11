export type PillOption = { id: string; name: string };

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
  options: PillOption[];
  onChange: (id: string) => void;
  disabled?: boolean;
  title: string;
  /** Text color classes replacing the neutral default, e.g. the accent of the current mode. */
  className?: string;
}) {
  const isKnown = options.some((option) => option.id === value);
  const label = options.find((option) => option.id === value)?.name ?? value;
  return (
    <label
      title={title}
      className={`relative inline-grid h-8 items-center rounded-md text-sm transition-colors hover:bg-(--row-hover) has-disabled:opacity-50 ${className || "text-neutral-300"}`}
    >
      {/* The sizer keeps the pill as wide as the selected option; a native select would size to its widest one. */}
      <span aria-hidden="true" className="invisible col-start-1 row-start-1 whitespace-nowrap pl-2.5 pr-6">
        {label}
      </span>
      <select
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="col-start-1 row-start-1 h-full w-0 min-w-full appearance-none bg-transparent pl-2.5 pr-6 outline-none"
      >
        {!isKnown ? <option value={value}>{value}</option> : null}
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
      </select>
      <svg
        viewBox="0 0 16 16"
        className="pointer-events-none absolute right-1.5 size-3 text-neutral-500"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="m4 6 4 4 4-4" />
      </svg>
    </label>
  );
}
