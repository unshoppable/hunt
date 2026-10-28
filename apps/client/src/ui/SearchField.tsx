import { useRef, useState } from "react";
import { CloseIcon, SearchIcon } from "./Icons";

type SearchFieldProps = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel: string;
  autoFocus?: boolean;
  /** Called by Escape on an empty field instead of blurring it, e.g. to close the list the field filters. */
  onEscape?: () => void;
  /** Margins and other layout classes of the field itself; the field is 40px high and fills its width. */
  className?: string;
};

/**
 * The search box of the session sidebar, shared with every list that filters the same way: a magnifier, the text
 * and a clear button once there is text. Escape clears the text, a second Escape on an empty field blurs it or
 * calls `onEscape`.
 */
export function SearchField({ value, onChange, placeholder = "Search", ariaLabel, autoFocus = false, onEscape, className = "" }: SearchFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [initialFocus] = useState(autoFocus);

  return (
    <label className={`relative flex h-10 shrink-0 items-center rounded-md border border-white/10 bg-(--surface-input) text-neutral-200 focus-within:border-white/20 ${className}`}>
      <SearchIcon className="pointer-events-none absolute left-3 size-4.5 text-neutral-500" />
      <input
        ref={inputRef}
        type="text"
        value={value}
        autoFocus={initialFocus}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          if (value) {
            onChange("");
          } else if (onEscape) {
            onEscape();
          } else {
            event.currentTarget.blur();
          }
        }}
        placeholder={placeholder}
        spellCheck={false}
        aria-label={ariaLabel}
        className="h-full min-w-0 flex-1 bg-transparent pr-9 pl-9.5 text-[15px] outline-none placeholder:text-neutral-500"
      />
      {value ? (
        <button
          type="button"
          onClick={() => {
            onChange("");
            inputRef.current?.focus();
          }}
          className="absolute right-1 flex size-8 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-white/10 hover:text-white"
          aria-label="Clear search"
        >
          <CloseIcon className="size-3" />
        </button>
      ) : null}
    </label>
  );
}
