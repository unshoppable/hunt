import { useRef, useState } from "react";
import { commands } from "../ipc/commands";
import { BUTTON_BASE } from "../ui/buttons";
import { ChevronIcon, WebstormIcon } from "../ui/icons";
import { useDismiss } from "../ui/useDismiss";

const MENU_ITEM = "block w-full rounded px-2 py-1 text-left hover:bg-(--row-hover)";

/** Split button: "Open" opens the session's worktree in WebStorm, the chevron lists the other WebStorm actions. */
export function OpenInWebstormButton({ sessionId, disabled }: { sessionId: string; disabled: boolean }) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const chevronRef = useRef<HTMLButtonElement>(null);
  useDismiss(menuRef, () => setIsMenuOpen(false), { anchorRefs: [chevronRef], closeOnWindowBlur: true, isEnabled: isMenuOpen });

  function run(action: () => Promise<void>) {
    setIsMenuOpen(false);
    void action();
  }

  return (
    <div className={`relative flex h-8 shrink-0 rounded-md border border-white/10 bg-white/4 text-neutral-200 ${disabled ? "pointer-events-none opacity-40" : ""}`}>
      <button
        type="button"
        onClick={() => void commands.openWorktreeInWebstorm(sessionId)}
        disabled={disabled}
        title="Open the worktree in WebStorm"
        className={`${BUTTON_BASE} h-full gap-2 rounded-r-none pr-3 pl-2.5 text-sm hover:bg-white/6`}
      >
        <WebstormIcon />
        Open
      </button>
      <span className="my-1.5 w-px bg-white/10" aria-hidden="true" />
      <button
        ref={chevronRef}
        type="button"
        onClick={() => setIsMenuOpen((current) => !current)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={isMenuOpen}
        aria-label="More WebStorm actions"
        className={`${BUTTON_BASE} h-full w-8 rounded-l-none text-neutral-400 hover:bg-white/6 hover:text-white`}
      >
        <ChevronIcon expanded />
      </button>
      {isMenuOpen ? (
        <div
          ref={menuRef}
          role="menu"
          className="absolute top-full right-0 z-50 mt-1 min-w-48 rounded border border-neutral-600 bg-(--surface-inset) p-1 text-[13px] font-normal shadow-lg"
        >
          <button type="button" role="menuitem" onClick={() => run(() => commands.openWorktreeInWebstorm(sessionId))} className={MENU_ITEM}>
            Open worktree
          </button>
          <button type="button" role="menuitem" onClick={() => run(() => commands.openChangedFilesDiffInWebstorm(sessionId))} className={MENU_ITEM}>
            Diff changed files
          </button>
        </div>
      ) : null}
    </div>
  );
}
