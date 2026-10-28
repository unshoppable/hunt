import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { filterOptions, findTypeahead, placeMenu, stepEnabled, type DropdownOption } from "./floating-menu.utils";
import { SECONDARY_BUTTON_XS } from "./buttons.constants";
import { CheckIcon, ChevronDownIcon, PlusIcon, SearchIcon } from "./Icons";
import { useDismiss } from "./dismiss.hook";

/** How long after the last key press typing starts a new typeahead search. */
const TYPEAHEAD_RESET_MS = 700;
const OPENING_KEYS = new Set(["ArrowDown", "ArrowUp", "Enter", " "]);

/** DOM ID of the option at `index` in the list `listId`, for `aria-activedescendant`. */
export function optionId(listId: string, index: number): string {
  return `${listId}-option-${index}`;
}

/** A button beside the search field of a dropdown, e.g. "New branch"; `onRun` gets the text typed into the field. */
export type SearchAction = { label: string; title: string; onRun: (query: string) => void };

/** The search field at the top of an `OptionMenu`, next to its anchor when the menu opens above it. */
export type MenuSearch = {
  query: string;
  placeholder: string;
  onChange: (query: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  action?: { label: string; title: string; onRun: () => void };
};

/**
 * Replacement for a native select: a trigger showing the chosen option's name and a floating list of the options. The
 * focus stays on the trigger while the list is open, as in a select-only combobox: arrows, Home/End and typing move the
 * highlight, Enter or Space picks it, Escape, Tab or a click outside closes the list. With `isSearchable` the list gets
 * a search field instead, which takes the focus and filters the options by name or ID: typing on the closed trigger
 * opens the list with that text, arrows move the highlight, Enter picks it. `searchAction` puts a button beside the
 * field, which Enter runs too while nothing matches. `className` styles the trigger; a value
 * missing from `options` shows as is, or as `placeholder` when it is empty.
 */
export function Dropdown({
  value,
  options,
  onChange,
  title,
  disabled = false,
  placeholder = "",
  isSearchable = false,
  searchPlaceholder = "Search",
  searchAction,
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
  isSearchable?: boolean;
  searchPlaceholder?: string;
  searchAction?: SearchAction;
  /** Shown before the label, e.g. a branch icon. */
  icon?: ReactNode;
  className: string;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const typeaheadRef = useRef({ query: "", timer: 0 });
  const listId = useId();
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [query, setQuery] = useState("");
  const selectedIndex = options.findIndex((option) => option.id === value);
  const label = options[selectedIndex]?.name ?? (value || placeholder);
  const shownOptions = isSearchable ? filterOptions(options, query) : options;

  useEffect(() => {
    if (!disabled) return;
    setIsOpen(false);
  }, [disabled]);

  useEffect(() => () => window.clearTimeout(typeaheadRef.current.timer), []);

  /** The option highlighted for `search`: the selected one without a search, otherwise the first enabled match. */
  function initialIndex(search: string): number {
    if (!search.trim() && selectedIndex >= 0) return selectedIndex;
    const matches = isSearchable ? filterOptions(options, search) : options;
    return stepEnabled(matches, -1, 1);
  }

  function open(index = initialIndex(""), search = "") {
    setQuery(search);
    setActiveIndex(index);
    setIsOpen(true);
  }

  /** Closes the list; the search field had the focus, so it returns to the trigger. */
  function close() {
    setIsOpen(false);
    if (!isSearchable) return;
    triggerRef.current?.focus();
  }

  function pick(index: number) {
    const option = shownOptions[index];
    if (!option || option.isDisabled) return;
    close();
    if (option.id !== value) {
      onChange(option.id);
    }
  }

  function runSearchAction() {
    if (!searchAction) return;
    close();
    searchAction.onRun(query);
  }

  function search(text: string) {
    setQuery(text);
    setActiveIndex(initialIndex(text));
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

  /** The option an arrow key moves the highlight to; `null` for any other key. */
  function stepFor(key: string): number | null {
    if (key === "ArrowDown") return stepEnabled(shownOptions, activeIndex, 1);
    if (key === "ArrowUp") return stepEnabled(shownOptions, activeIndex, -1);
    return null;
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Tab") {
      setIsOpen(false);
      return;
    }
    if (event.key.length === 1 && event.key !== " ") {
      event.preventDefault();
      if (isSearchable) {
        open(initialIndex(event.key), event.key);
      } else {
        typeahead(event.key);
      }
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
      event.key === "Home" ? stepEnabled(options, -1, 1) : event.key === "End" ? stepEnabled(options, options.length, -1) : stepFor(event.key);
    if (next === null) return;
    event.preventDefault();
    setActiveIndex(next);
  }

  function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Tab") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (shownOptions.length === 0) {
        runSearchAction();
      } else {
        pick(activeIndex);
      }
      return;
    }
    const next = stepFor(event.key);
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
        aria-activedescendant={isOpen && !isSearchable && activeIndex >= 0 ? optionId(listId, activeIndex) : undefined}
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
          options={shownOptions}
          selectedId={value}
          activeIndex={activeIndex}
          onActivate={setActiveIndex}
          onPick={pick}
          onClose={close}
          anchorRef={triggerRef}
          search={
            isSearchable
              ? {
                  query,
                  placeholder: searchPlaceholder,
                  onChange: search,
                  onKeyDown: onSearchKeyDown,
                  action: searchAction ? { label: searchAction.label, title: searchAction.title, onRun: runSearchAction } : undefined,
                }
              : undefined
          }
        />
      ) : null}
    </>
  );
}

/**
 * Floating list of `options` next to `anchorRef`, at least as wide as the anchor and rendered into the document body so
 * that no clipping ancestor cuts it off. The anchor keeps the focus and moves `activeIndex` with its keys; the mouse
 * moves the highlight too and a click picks the option. Escape, a mouse press outside the list and the anchor, or
 * leaving the window close it. With `search` the menu has a fixed width and a search field that takes the focus
 * instead of the anchor; it stays on the side of the anchor it opened on while the matches shrink.
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
  search,
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
  search?: MenuSearch;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const isPointerActivationRef = useRef(false);
  const placement = useMenuPlacement(anchorRef, menuRef, listRef, !!search);
  const isPlaced = !!placement;
  useDismiss(menuRef, onClose, { anchorRefs: [anchorRef], closeOnWindowBlur: true });

  // Keeps the option the keys highlight in view; one the mouse highlights is in view already.
  useEffect(() => {
    if (isPointerActivationRef.current) {
      isPointerActivationRef.current = false;
      return;
    }
    if (!isPlaced) return;
    listRef.current?.querySelector("[data-active]")?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, isPlaced]);

  // The menu is invisible until it is placed, and an invisible field cannot take the focus.
  useEffect(() => {
    if (!isPlaced) return;
    searchRef.current?.focus({ preventScroll: true });
  }, [isPlaced]);

  const isAbove = placement?.isAbove ?? false;
  return createPortal(
    <div
      ref={menuRef}
      style={placement?.style ?? { left: 0, top: 0, visibility: "hidden" }}
      className={`fixed z-[70] flex overflow-hidden rounded-xl border border-neutral-600 bg-(--surface-chat) text-sm shadow-2xl shadow-black/50 ${isAbove ? "flex-col-reverse" : "flex-col"} ${search ? "w-[min(26rem,calc(100vw-16px))]" : "w-max max-w-[min(26rem,calc(100vw-16px))]"}`}
    >
      {search ? (
        <div className={`flex shrink-0 items-center gap-2 border-(--line) pr-1.5 pl-3.5 ${isAbove ? "border-t" : "border-b"}`}>
          <SearchIcon className="size-4 shrink-0 text-neutral-500" />
          <input
            ref={searchRef}
            type="text"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded
            aria-controls={id}
            aria-activedescendant={activeIndex >= 0 ? optionId(id, activeIndex) : undefined}
            aria-label={label}
            value={search.query}
            onChange={(event) => search.onChange(event.target.value)}
            onKeyDown={search.onKeyDown}
            placeholder={search.placeholder}
            spellCheck={false}
            className="h-11 min-w-0 flex-1 bg-transparent text-[15px] text-neutral-200 outline-none placeholder:text-neutral-500"
          />
          {search.action ? (
            <button type="button" onClick={search.action.onRun} title={search.action.title} className={SECONDARY_BUTTON_XS}>
              <PlusIcon className="size-3.5 shrink-0" />
              {search.action.label}
            </button>
          ) : null}
        </div>
      ) : null}
      <ul ref={listRef} id={id} role="listbox" aria-label={label} onMouseDown={(event) => event.preventDefault()} className="min-h-0 overflow-y-auto p-1 empty:hidden">
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
              className={`flex items-center gap-3 rounded px-2.5 py-1.5 ${option.isDisabled ? "text-neutral-600" : isActive ? "bg-(--row-selected) text-neutral-100" : "text-neutral-200"}`}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate">{option.name}</span>
                {option.description ? <span className="block text-[12px] leading-snug text-neutral-500">{option.description}</span> : null}
              </span>
              <CheckIcon className={`size-3.5 shrink-0 text-neutral-400 ${isSelected ? "" : "invisible"}`} />
            </li>
          );
        })}
      </ul>
      {search && options.length === 0 ? <p className="px-3.5 py-2.5 text-neutral-500">No matches</p> : null}
    </div>,
    document.body,
  );
}

/**
 * Fixed-position style that places `menuRef` next to `anchorRef` (see `placeMenu`), measured after every render and
 * again when the window resizes or anything outside the menu scrolls; `null` until the first measurement. `listRef` is
 * the part of the menu that scrolls. With `keepsSide` the menu stays above or below the anchor, as first placed.
 */
function useMenuPlacement(
  anchorRef: RefObject<HTMLElement | null>,
  menuRef: RefObject<HTMLElement | null>,
  listRef: RefObject<HTMLElement | null>,
  keepsSide: boolean,
): { style: CSSProperties; isAbove: boolean } | null {
  const [placement, setPlacement] = useState<{ style: CSSProperties; isAbove: boolean } | null>(null);
  const sideRef = useRef<boolean | undefined>(undefined);

  const place = useCallback(() => {
    const anchor = anchorRef.current;
    const menu = menuRef.current;
    const list = listRef.current;
    if (!anchor || !menu || !list) return;
    const rect = anchor.getBoundingClientRect();
    const size = { width: Math.max(menu.offsetWidth, rect.width), height: menu.offsetHeight + list.scrollHeight - list.clientHeight };
    const { left, top, maxHeight, isAbove } = placeMenu(rect, size, { width: window.innerWidth, height: window.innerHeight }, keepsSide ? sideRef.current : undefined);
    if (keepsSide) {
      sideRef.current = isAbove;
    }
    setPlacement((current) =>
      current?.isAbove === isAbove &&
      current.style.left === left &&
      current.style.top === top &&
      current.style.maxHeight === maxHeight &&
      current.style.minWidth === rect.width
        ? current
        : { style: { left, top, maxHeight, minWidth: rect.width }, isAbove },
    );
  }, [anchorRef, menuRef, listRef, keepsSide]);

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

  return placement;
}
