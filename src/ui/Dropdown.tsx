import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { findTypeahead, placeMenu, stepEnabled, type DropdownOption } from "./floatingMenu";
import { CheckIcon, ChevronDownIcon } from "./icons";
import { useDismiss } from "./useDismiss";

/** How long after the last key press typing starts a new typeahead search. */
const TYPEAHEAD_RESET_MS = 700;
const OPENING_KEYS = new Set(["ArrowDown", "ArrowUp", "Enter", " "]);

/** DOM ID of the option at `index` in the list `listId`, for `aria-activedescendant`. */
export function optionId(listId: string, index: number): string {
  return `${listId}-option-${index}`;
}

/**
 * Replacement for a native select: a trigger showing the chosen option's name and a floating list of the options. The
 * focus stays on the trigger while the list is open, as in a select-only combobox: arrows, Home/End and typing move the
 * highlight, Enter or Space picks it, Escape, Tab or a click outside closes the list. `className` styles the trigger; a
 * value missing from `options` shows as is, or as `placeholder` when it is empty.
 */
export function Dropdown({
  value,
  options,
  onChange,
  title,
  disabled = false,
  placeholder = "",
  icon,
  className,
}: {
  value: string;
  options: DropdownOption[];
  onChange: (id: string) => void;
  /** Tooltip and accessible name of the trigger and its list. */
  title: string;
  disabled?: boolean;
  placeholder?: string;
  /** Shown before the label, e.g. a branch icon. */
  icon?: ReactNode;
  className: string;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const typeaheadRef = useRef({ query: "", timer: 0 });
  const listId = useId();
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const selectedIndex = options.findIndex((option) => option.id === value);
  const label = options[selectedIndex]?.name ?? (value || placeholder);

  useEffect(() => {
    if (!disabled) return;
    setIsOpen(false);
  }, [disabled]);

  useEffect(() => () => window.clearTimeout(typeaheadRef.current.timer), []);

  function open(index = selectedIndex >= 0 ? selectedIndex : stepEnabled(options, -1, 1)) {
    setActiveIndex(index);
    setIsOpen(true);
  }

  function pick(index: number) {
    const option = options[index];
    if (!option || option.isDisabled) return;
    setIsOpen(false);
    if (option.id !== value) {
      onChange(option.id);
    }
  }

  function typeahead(key: string) {
    const typed = typeaheadRef.current;
    window.clearTimeout(typed.timer);
    typed.query += key;
    typed.timer = window.setTimeout(() => {
      typed.query = "";
    }, TYPEAHEAD_RESET_MS);
    const index = findTypeahead(options, typed.query, isOpen ? activeIndex : selectedIndex);
    if (index < 0) return;
    open(index);
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Tab") {
      setIsOpen(false);
      return;
    }
    if (event.key.length === 1 && event.key !== " ") {
      event.preventDefault();
      typeahead(event.key);
      return;
    }
    if (!isOpen) {
      if (!OPENING_KEYS.has(event.key)) return;
      event.preventDefault();
      open();
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      pick(activeIndex);
      return;
    }
    const next =
      event.key === "ArrowDown"
        ? stepEnabled(options, activeIndex, 1)
        : event.key === "ArrowUp"
          ? stepEnabled(options, activeIndex, -1)
          : event.key === "Home"
            ? stepEnabled(options, -1, 1)
            : event.key === "End"
              ? stepEnabled(options, options.length, -1)
              : null;
    if (next === null) return;
    event.preventDefault();
    setActiveIndex(next);
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={isOpen ? listId : undefined}
        aria-activedescendant={isOpen && activeIndex >= 0 ? optionId(listId, activeIndex) : undefined}
        aria-label={title}
        title={title}
        disabled={disabled}
        onClick={() => {
          // WebKit does not focus a clicked button; the keys of the open list need the focus here.
          triggerRef.current?.focus();
          if (isOpen) {
            setIsOpen(false);
          } else {
            open();
          }
        }}
        onKeyDown={onKeyDown}
        className={`${className} aria-expanded:bg-(--row-active)`}
      >
        {icon}
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDownIcon className="size-3 shrink-0 text-neutral-500" />
      </button>
      {isOpen ? (
        <OptionMenu
          id={listId}
          label={title}
          options={options}
          selectedId={value}
          activeIndex={activeIndex}
          onActivate={setActiveIndex}
          onPick={pick}
          onClose={() => setIsOpen(false)}
          anchorRef={triggerRef}
        />
      ) : null}
    </>
  );
}

/**
 * Floating list of `options` next to `anchorRef`, at least as wide as the anchor and rendered into the document body so
 * that no clipping ancestor cuts it off. The anchor keeps the focus and moves `activeIndex` with its keys; the mouse
 * moves the highlight too and a click picks the option. Escape, a mouse press outside the list and the anchor, or
 * leaving the window close it.
 */
export function OptionMenu({
  id,
  label,
  options,
  selectedId,
  activeIndex,
  onActivate,
  onPick,
  onClose,
  anchorRef,
}: {
  id: string;
  label: string;
  options: DropdownOption[];
  /** The option shown with a check mark, if any. */
  selectedId: string | null;
  /** The highlighted option; -1 for none. */
  activeIndex: number;
  onActivate: (index: number) => void;
  onPick: (index: number) => void;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  const isPointerActivationRef = useRef(false);
  const placement = useMenuPlacement(anchorRef, listRef);
  useDismiss(listRef, onClose, { anchorRefs: [anchorRef], closeOnWindowBlur: true });

  // Keeps the option the keys highlight in view; one the mouse highlights is in view already.
  useEffect(() => {
    if (isPointerActivationRef.current) {
      isPointerActivationRef.current = false;
      return;
    }
    if (!placement) return;
    listRef.current?.querySelector("[data-active]")?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, placement]);

  return createPortal(
    <ul
      ref={listRef}
      id={id}
      role="listbox"
      aria-label={label}
      onMouseDown={(event) => event.preventDefault()}
      style={placement ?? { left: 0, top: 0, visibility: "hidden" }}
      className="fixed z-[70] w-max max-w-[min(26rem,calc(100vw-16px))] overflow-y-auto rounded-xl border border-neutral-600 bg-(--surface-chat) p-1 text-sm shadow-2xl shadow-black/50"
    >
      {options.map((option, index) => {
        const isActive = index === activeIndex;
        const isSelected = option.id === selectedId;
        return (
          <li
            key={option.id}
            id={optionId(id, index)}
            role="option"
            aria-selected={isSelected}
            aria-disabled={option.isDisabled || undefined}
            data-active={isActive || undefined}
            onMouseMove={() => {
              if (isActive || option.isDisabled) return;
              isPointerActivationRef.current = true;
              onActivate(index);
            }}
            onClick={() => onPick(index)}
            className={`flex items-center gap-3 rounded-lg px-2.5 py-1.5 ${option.isDisabled ? "text-neutral-600" : isActive ? "bg-(--row-active) text-neutral-100" : "text-neutral-200"}`}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate">{option.name}</span>
              {option.description ? <span className="block text-[12px] leading-snug text-neutral-500">{option.description}</span> : null}
            </span>
            <CheckIcon className={`size-3.5 shrink-0 text-neutral-400 ${isSelected ? "" : "invisible"}`} />
          </li>
        );
      })}
    </ul>,
    document.body,
  );
}

/**
 * Fixed-position style that places `menuRef` next to `anchorRef` (see `placeMenu`), measured after every render and
 * again when the window resizes or anything outside the menu scrolls; `null` until the first measurement.
 */
function useMenuPlacement(anchorRef: RefObject<HTMLElement | null>, menuRef: RefObject<HTMLElement | null>): CSSProperties | null {
  const [style, setStyle] = useState<CSSProperties | null>(null);

  const place = useCallback(() => {
    const anchor = anchorRef.current;
    const menu = menuRef.current;
    if (!anchor || !menu) return;
    const rect = anchor.getBoundingClientRect();
    const size = { width: Math.max(menu.offsetWidth, rect.width), height: menu.scrollHeight + menu.offsetHeight - menu.clientHeight };
    const { left, top, maxHeight } = placeMenu(rect, size, { width: window.innerWidth, height: window.innerHeight });
    setStyle((current) =>
      current?.left === left && current.top === top && current.maxHeight === maxHeight && current.minWidth === rect.width ? current : { left, top, maxHeight, minWidth: rect.width },
    );
  }, [anchorRef, menuRef]);

  useLayoutEffect(place);

  useEffect(() => {
    function onScroll(event: Event) {
      if (menuRef.current?.contains(event.target as Node)) return;
      place();
    }
    window.addEventListener("resize", place);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [place, menuRef]);

  return style;
}
