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
  return (
    <div className={`divide-y divide-(--line) overflow-hidden rounded-lg border border-(--line) bg-(--surface-inset) text-[13px] ${className}`}>
      {locations.map((location, index) => (
        <FileReferenceRow key={index} location={location} onOpen={onOpen} />
      ))}
    </div>
  );
}

const LABEL_CLASS = "flex min-w-0 flex-1 items-baseline gap-2";

/** One row of `FileReferenceList`, also the header of a code block that shows `location`; with `onOpen`, the label opens it too. */
export function FileReferenceRow({ location, onOpen, className = "" }: { location: FileLocation; onOpen?: (location: FileLocation) => void; className?: string }) {
  const fileIconUrl = useFileIconUrl();
  const { dir, name } = splitPath(location.path);
  const label = (
    <>
      <span className="max-w-full shrink-0 truncate font-mono text-neutral-200 group-hover/label:underline">
        {name}:{describeLines(location)}
      </span>
      <span className="min-w-0 truncate text-neutral-500">{dir}</span>
    </>
  );
  return (
    <div className={`flex items-center gap-2.5 px-3 py-2 ${className}`}>
      <img src={fileIconUrl(location.path)} alt="" className="size-4 shrink-0" />
      {onOpen ? (
        <button type="button" onClick={() => onOpen(location)} className={`${LABEL_CLASS} group/label text-left`} title={describeSelection(location)}>
          {label}
        </button>
      ) : (
        <span className={LABEL_CLASS} title={describeSelection(location)}>
          {label}
        </span>
      )}
      {onOpen ? (
        <button type="button" onClick={() => onOpen(location)} className={SECONDARY_BUTTON_XS} title="Show the lines in the Editor tab">
          Open in editor
        </button>
      ) : null}
    </div>
  );
}
