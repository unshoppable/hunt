import type { SessionView } from "../ipc/types";
import { useSettingsStore } from "../state/settings";
import { SECONDARY, SURFACE_BUTTON_MD } from "../ui/buttons";
import type { FileLocation } from "./changeReferences";
import { FileReferenceList } from "./FileReferenceList";

/**
 * Box above the messages with the code a sub chat was opened from and the session's summary bullets; shown while the
 * "Summary" setting is on.
 */
export function SessionSummary({ session, onOpenFile }: { session: SessionView; onOpenFile: (location: FileLocation) => void }) {
  return (
    <div className="border-b border-(--line) bg-white/8 px-5 pt-4 pb-[18px]">
      <div className="chat-column">
        <div className="mb-1.5 text-[13px] font-medium uppercase tracking-wide text-neutral-500">Summary</div>
        {session.selection ? <FileReferenceList locations={[session.selection]} onOpen={onOpenFile} className="mb-2.5" /> : null}
        {session.summary.length ? (
          <ul className="space-y-1 text-[14px] leading-snug text-neutral-300">
            {session.summary.map((line, index) => (
              <li key={index} className="flex gap-2">
                <span className="mt-[0.55em] size-1 shrink-0 select-none rounded-full bg-neutral-500" />
                <span>{line}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="text-[14px] text-neutral-500">No summary yet. It is written after the first finished prompt.</div>
        )}
      </div>
    </div>
  );
}

/** Header button that shows or hides the summary box; the choice is remembered across sessions and restarts. */
export function SessionSummaryToggle() {
  const showSummary = useSettingsStore((state) => state.showSummary);
  const toggleSummary = useSettingsStore((state) => state.toggleSummary);
  return (
    <button
      type="button"
      aria-pressed={showSummary}
      title={showSummary ? "Hide the summary box" : "Show the summary box"}
      onClick={toggleSummary}
      className={`${SURFACE_BUTTON_MD} ${showSummary ? "border border-white/15 bg-white/12 text-white hover:bg-white/15 active:bg-white/10" : SECONDARY}`}
    >
      <InfoIcon />
      Summary
    </button>
  );
}

function InfoIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <circle cx="8" cy="8" r="6.3" />
      <path d="M8 7.2v4" />
      <circle cx="8" cy="4.9" r="0.5" fill="currentColor" />
    </svg>
  );
}
