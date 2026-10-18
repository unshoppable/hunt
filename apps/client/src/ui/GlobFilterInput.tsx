import { useEffect, useState } from "react";

export const GLOB_FILTER_HELP =
  "Hides files whose path relative to the repository root matches one of these globs, separated by commas or spaces. A glob without a slash matches the file name in any folder, ** spans folders. Enter applies, Escape restores.";

/**
 * Text field for a list of globs that hide files. It applies its text through `onApply` on Enter or when it is left;
 * Escape restores the applied `value`, a second Escape leaves the field. `className` sizes the field.
 */
export function GlobFilterInput({ value, onApply, placeholder, className = "" }: { value: string; onApply: (globs: string) => void; placeholder: string; className?: string }) {
  const [draft, setDraft] = useState(value);

  useEffect(() => setDraft(value), [value]);

  return (
    <input
      type="text"
      value={draft}
      spellCheck={false}
      placeholder={placeholder}
      title={GLOB_FILTER_HELP}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft.trim() !== value) {
          onApply(draft);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          if (draft !== value) {
            setDraft(value);
          } else {
            event.currentTarget.blur();
          }
        }
      }}
      className={`h-7 rounded-md border border-white/10 bg-(--surface-input) px-2 font-mono text-[13px] text-neutral-200 outline-none placeholder:font-sans placeholder:text-neutral-500 focus:border-white/20 ${className}`}
    />
  );
}
