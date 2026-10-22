import { useFileIconUrl } from "../diff/fileIcons";
import { SECONDARY_BUTTON_XS } from "../ui/buttons";
import { splitPath } from "../ui/path";
import type { FileLocation } from "./changeReferences";
import { describeLines, describeSelection } from "./SelectionCard";

/**
 * Card with one row per file location: icon, `name:L3-L9`, the folder dimmed, and an "Open in editor" button when
 * `onOpen` is given.
 */
export function FileReferenceList({ locations, onOpen, className = "" }: { locations: FileLocation[]; onOpen?: (location: FileLocation) => void; className?: string }) {
  const fileIconUrl = useFileIconUrl();
  return (
    <div className={`divide-y divide-(--line) overflow-hidden rounded-lg border border-(--line) bg-(--surface-inset) text-[13px] ${className}`}>
      {locations.map((location, index) => {
        const { dir, name } = splitPath(location.path);
        return (
          <div key={index} className="flex items-center gap-2.5 px-3 py-2">
            <img src={fileIconUrl(location.path)} alt="" className="size-4 shrink-0" />
            <span className="flex min-w-0 flex-1 items-baseline gap-2" title={describeSelection(location)}>
              <span className="max-w-full shrink-0 truncate font-mono text-neutral-200">
                {name}:{describeLines(location)}
              </span>
              <span className="min-w-0 truncate text-neutral-500">{dir}</span>
            </span>
            {onOpen ? (
              <button type="button" onClick={() => onOpen(location)} className={SECONDARY_BUTTON_XS} title="Show the lines in the Editor tab">
                Open in editor
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
