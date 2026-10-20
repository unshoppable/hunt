import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ICON_NAMES, iconUrl } from "../diff/fileIcons";
import { useEscapeToClose } from "../ui/useEscapeToClose";

const POPOVER_WIDTH = 288;
const POPOVER_MAX_HEIGHT = 360;

/**
 * Picks one of `icons` (every vendored icon by default): a field showing the chosen icon with its name opens a popover that lists
 * every icon as image and name, narrowed down by a search box; Enter takes the first match. The popover is fixed
 * to the viewport so the settings page's scrolling does not clip it.
 */
export function IconPicker({
  value,
  onChange,
  icons = ICON_NAMES,
  className = "",
}: {
  value: string;
  onChange: (icon: string) => void;
  icons?: readonly string[];
  className?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [position, setPosition] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const url = icons.includes(value) ? iconUrl(value) : null;
  const isUnknown = Boolean(value) && !url;

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? icons.filter((icon) => icon.includes(needle)) : icons;
  }, [icons, query]);

  const close = () => {
    setIsOpen(false);
    setQuery("");
  };
  const pick = (icon: string) => {
    onChange(icon);
    close();
  };

  useEscapeToClose(close, isOpen);

  // Hangs below the field when there is room, else stands on it from above; never past the right edge of the window.
  useLayoutEffect(() => {
    if (!isOpen || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - POPOVER_WIDTH - 8));
    const fitsBelow = rect.bottom + 4 + POPOVER_MAX_HEIGHT <= window.innerHeight - 8;
    setPosition(fitsBelow ? { left, top: rect.bottom + 4 } : { left, bottom: window.innerHeight - rect.top + 4 });
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (popoverRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close();
    };
    window.addEventListener("mousedown", onMouseDown);
    return () => window.removeEventListener("mousedown", onMouseDown);
  }, [isOpen]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (isOpen ? close() : setIsOpen(true))}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label="Icon"
        title={value || "Choose an icon"}
        className={`flex h-[30px] items-center gap-2 rounded border bg-(--surface-inset) px-2 text-left text-sm outline-none focus-visible:border-neutral-400 ${
          isUnknown ? "border-red-400/70" : "border-neutral-600 hover:border-neutral-500"
        } ${className}`}
      >
        {url ? <img src={url} alt="" className="size-4 shrink-0" /> : <span className={`size-4 shrink-0 rounded border border-dashed ${isUnknown ? "border-red-400/70" : "border-neutral-600"}`} />}
        <span className={`min-w-0 flex-1 truncate font-mono ${value ? (isUnknown ? "text-red-300" : "text-neutral-200") : "font-sans text-neutral-600"}`}>{value || "Icon"}</span>
        <ChevronDownIcon />
      </button>
      {isOpen && position ? (
        <div
          ref={popoverRef}
          role="listbox"
          aria-label="Icons"
          style={{ left: position.left, top: position.top, bottom: position.bottom, width: POPOVER_WIDTH, maxHeight: POPOVER_MAX_HEIGHT }}
          className="fixed z-30 flex flex-col overflow-hidden rounded-md border border-neutral-600 bg-(--surface-inset) text-[13px] shadow-lg"
        >
          <input
            autoFocus
            type="text"
            value={query}
            spellCheck={false}
            placeholder="Search icons"
            aria-label="Search icons"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && matches[0]) {
                event.preventDefault();
                pick(matches[0]);
              }
            }}
            className="m-1.5 shrink-0 rounded border border-neutral-600 bg-(--surface-input) px-2 py-1 text-sm text-neutral-200 outline-none placeholder:text-neutral-600 focus:border-neutral-400"
          />
          <ul className="min-h-0 flex-1 overflow-y-auto p-1">
            {matches.map((icon) => (
              <li key={icon}>
                <button
                  type="button"
                  role="option"
                  aria-selected={icon === value}
                  onClick={() => pick(icon)}
                  className={`flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-(--row-hover) ${icon === value ? "bg-(--row-selected) text-neutral-100" : "text-neutral-300"}`}
                >
                  <img src={iconUrl(icon) ?? undefined} alt="" loading="lazy" className="size-4 shrink-0" />
                  <span className="truncate font-mono">{icon}</span>
                </button>
              </li>
            ))}
            {matches.length ? null : <li className="px-1.5 py-1 text-neutral-500">No icon matches</li>}
          </ul>
        </div>
      ) : null}
    </>
  );
}

function ChevronDownIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5 shrink-0 text-neutral-500" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.5 6 8 10.5 12.5 6" />
    </svg>
  );
}
