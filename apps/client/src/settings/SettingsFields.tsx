import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { BUTTON_XS } from "../ui/buttons.constants";
import { OptionMenu, optionId } from "../ui/Dropdown";
import { filterOptions, stepEnabled } from "../ui/floating-menu.utils";

export const FORM_INPUT = "w-56 rounded border border-neutral-600 bg-(--surface-input) px-2 py-1 text-sm text-neutral-200 outline-none placeholder:text-neutral-600 focus:border-neutral-400";

/** Page heading with the hint below and a reset button once a value differs from the defaults. */
export function PageHeader({ title, hint, isDefault, onReset }: { title: string; hint: string; isDefault: boolean; onReset: () => void }) {
  return (
    <div className="mb-4 flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <h3 className="text-base font-semibold text-neutral-100">{title}</h3>
        <p className="mt-0.5 text-[13px] text-neutral-500">{hint}</p>
      </div>
      {isDefault ? null : (
        <button type="button" onClick={onReset} className={`${BUTTON_XS} shrink-0 text-neutral-500 hover:bg-(--row-hover) hover:text-neutral-200`}>
          Reset
        </button>
      )}
    </div>
  );
}

/** Free text that commits when the field is left; a store change from outside (reset, reorder) replaces the draft. */
export function DraftInput({
  value,
  onCommit,
  placeholder,
  ariaLabel,
  title,
  className = "",
}: {
  value: string;
  onCommit: (value: string) => void;
  placeholder: string;
  ariaLabel: string;
  title?: string;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);

  useEffect(() => setDraft(value), [value]);

  return (
    <input
      type="text"
      value={draft}
      spellCheck={false}
      placeholder={placeholder}
      title={title}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft.trim() !== value) {
          onCommit(draft);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        }
      }}
      className={`truncate rounded border border-neutral-600 bg-(--surface-input) px-2 py-1 font-mono text-sm text-neutral-200 outline-none placeholder:font-sans placeholder:text-neutral-600 focus:border-neutral-400 ${className}`}
      aria-label={ariaLabel}
    />
  );
}

/**
 * Row with a free-text field that commits when it is left (Enter leaves it). The store decides what to keep, so the
 * field shows the stored value afterwards: a rejected value (empty, or an absolute or `..` path for a folder) snaps
 * back, a normalized one (trimmed, `./` stripped) takes its stored form. A store change from outside (reset, preset)
 * replaces the draft. `presets` are suggested below the field: all of them on a click or ↓, the matching ones while
 * typing; ↑/↓ highlight one, Enter or a click takes it.
 */
export function TextRow({
  label,
  ariaLabel = label,
  value,
  onChange,
  presets,
  isMonospace = false,
  inputStyle,
  placeholder,
}: {
  label: string;
  ariaLabel?: string;
  value: string;
  onChange: (value: string) => void;
  presets?: { label?: string; value: string }[];
  isMonospace?: boolean;
  inputStyle?: CSSProperties;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState(value);
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const presetOptions = (presets ?? []).map((preset) => ({ id: preset.value, name: preset.label ?? preset.value, description: preset.label ? preset.value : null }));
  const suggestions = filterOptions(presetOptions, draft === value ? "" : draft);
  const showsSuggestions = isSuggesting && suggestions.length > 0;

  useEffect(() => setDraft(value), [value]);

  // Leaving the field unchanged stores nothing (a store write reaches every window).
  const commit = () => {
    if (draft.trim() !== value) {
      onChange(draft);
    }
    setDraft(value);
  };

  function suggest(index: number) {
    if (!presets) return;
    setActiveIndex(index);
    setIsSuggesting(true);
  }

  function pick(index: number) {
    const preset = suggestions[index];
    if (!preset) return;
    setIsSuggesting(false);
    setDraft(preset.id);
    if (preset.id !== value) {
      onChange(preset.id);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      if (showsSuggestions && activeIndex >= 0) {
        pick(activeIndex);
      } else {
        event.currentTarget.blur();
      }
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    if (showsSuggestions) {
      setActiveIndex(stepEnabled(suggestions, activeIndex, event.key === "ArrowDown" ? 1 : -1));
    } else {
      suggest(stepEnabled(suggestions, -1, 1));
    }
  }

  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1 text-sm text-neutral-100">{label}</div>
      <input
        ref={inputRef}
        type="text"
        role={presets ? "combobox" : undefined}
        aria-autocomplete={presets ? "list" : undefined}
        aria-expanded={presets ? showsSuggestions : undefined}
        aria-controls={showsSuggestions ? listId : undefined}
        aria-activedescendant={showsSuggestions && activeIndex >= 0 ? optionId(listId, activeIndex) : undefined}
        value={draft}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(event) => {
          setDraft(event.target.value);
          suggest(-1);
        }}
        onClick={() => suggest(-1)}
        onBlur={() => {
          setIsSuggesting(false);
          commit();
        }}
        onKeyDown={onKeyDown}
        style={inputStyle}
        className={`w-56 truncate rounded border border-neutral-600 bg-(--surface-input) px-2 py-1 text-sm text-neutral-200 outline-none focus:border-neutral-400 ${isMonospace ? "font-mono" : ""}`}
        aria-label={ariaLabel}
      />
      {showsSuggestions ? (
        <OptionMenu
          id={listId}
          label={ariaLabel}
          options={suggestions}
          selectedId={value}
          activeIndex={activeIndex}
          onActivate={setActiveIndex}
          onPick={pick}
          onClose={() => setIsSuggesting(false)}
          anchorRef={inputRef}
        />
      ) : null}
      {/* Keeps the field aligned with the unit column of NumberRow. */}
      <span className="w-6" />
    </div>
  );
}

/** Multi-line free text that commits when the field loses focus; ⌘↩ commits too. */
export function TextArea({ ariaLabel, value, onChange }: { ariaLabel: string; value: string; onChange: (value: string) => void }) {
  const [draft, setDraft] = useState(value);

  useEffect(() => setDraft(value), [value]);

  // Leaving the field unchanged stores nothing (a store write reaches every window).
  const commit = () => {
    if (draft.trim() !== value) {
      onChange(draft);
    }
    setDraft(value);
  };

  return (
    <textarea
      value={draft}
      spellCheck={false}
      rows={14}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter" && event.metaKey) {
          event.currentTarget.blur();
        }
      }}
      className="min-h-40 w-full resize-y rounded border border-neutral-600 bg-(--surface-input) px-2 py-1.5 font-mono text-[13px] leading-snug text-neutral-200 outline-none focus:border-neutral-400"
      aria-label={ariaLabel}
    />
  );
}
