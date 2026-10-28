import { useState } from "react";
import { useFileIconUrl } from "../ui/file-icons/file-icons.hook";
import { SECONDARY_BUTTON_XS } from "../ui/buttons.constants";
import { errorText } from "../ui/error-text.utils";
import { splitPath } from "../common/path/path.utils";
import { ChevronIcon } from "../ui/Icons";
import { Collapsible } from "../ui/Collapsible";
import { CodeBlock } from "../editor/CodeBlock";
import { monacoLanguage } from "../editor/language-id.utils";
import type { FileLocation } from "./change-references.utils";
import { describeLines, describeSelection } from "./SelectionCard";

/**
 * Card with one row per file location: icon, `name:L3-L9`, the folder dimmed, and an "Open in editor" button when
 * `onOpen` is given. With `readFile` (worktree-relative path to the file's text), a chevron in front of each row shows
 * or hides the location's lines below it.
 */
export function FileReferenceList({
  locations,
  onOpen,
  readFile,
  className = "",
}: {
  locations: FileLocation[];
  onOpen?: (location: FileLocation) => void;
  readFile?: (path: string) => Promise<string>;
  className?: string;
}) {
  return (
    <div className={`divide-y divide-(--line) overflow-hidden rounded-lg border border-(--line) bg-(--surface-inset) text-[13px] ${className}`}>
      {locations.map((location, index) =>
        readFile ? (
          <FileReferenceCode key={index} location={location} onOpen={onOpen} readFile={readFile} />
        ) : (
          <FileReferenceRow key={index} location={location} onOpen={onOpen} />
        ),
      )}
    </div>
  );
}

/**
 * Row of `FileReferenceList` whose chevron shows the lines of `location` below it, collapsed at first; the file is read
 * each time they are shown, so they follow later edits, and they open once the first read is done. Shown, the code
 * scrolls beyond half the window height.
 */
function FileReferenceCode({ location, onOpen, readFile }: { location: FileLocation; onOpen?: (location: FileLocation) => void; readFile: (path: string) => Promise<string> }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function toggle() {
    setIsExpanded(!isExpanded);
    if (isExpanded) return;
    readFile(location.path)
      .then((text) => {
        setCode(text.split(/\r?\n/).slice(location.startLine - 1, location.endLine).join("\n"));
        setError(null);
      })
      .catch((reason) => setError(errorText(reason)));
  }

  return (
    <div>
      <FileReferenceRow location={location} onOpen={onOpen} isExpanded={isExpanded} onToggle={toggle} />
      <Collapsible isOpen={isExpanded && (code !== null || error !== null)}>
        <div className="max-h-[50vh] overflow-auto border-t border-(--line)">
          {error ? (
            <div className="px-3 py-2 text-red-300 break-words">{error}</div>
          ) : (
            <CodeBlock
              text={code ?? ""}
              language={monacoLanguage(location.path)}
              path={location.path}
              startLine={location.startLine}
              className="px-3 py-2 font-mono text-[13px] leading-snug text-neutral-300"
            />
          )}
        </div>
      </Collapsible>
    </div>
  );
}

const LABEL_CLASS = "flex min-w-0 flex-1 items-baseline gap-2";

/**
 * One row of `FileReferenceList`, also the header of a code block that shows `location`. With `onToggle`, a chevron in
 * front and the label show or hide that code block, as `isExpanded` says; otherwise, with `onOpen`, the label opens
 * `location` like the "Open in editor" button.
 */
export function FileReferenceRow({
  location,
  onOpen,
  isExpanded = false,
  onToggle,
  className = "",
}: {
  location: FileLocation;
  onOpen?: (location: FileLocation) => void;
  isExpanded?: boolean;
  onToggle?: () => void;
  className?: string;
}) {
  const fileIconUrl = useFileIconUrl();
  const { dir, name } = splitPath(location.path);
  const onLabelClick = onToggle ?? (onOpen ? () => onOpen(location) : null);
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
      {onToggle ? (
        <button
          type="button"
          aria-expanded={isExpanded}
          onClick={onToggle}
          title={isExpanded ? "Hide the code" : "Show the code"}
          className="flex size-5 shrink-0 items-center justify-center rounded text-neutral-500 hover:bg-(--row-hover) hover:text-neutral-200"
        >
          <ChevronIcon expanded={isExpanded} />
        </button>
      ) : null}
      <img src={fileIconUrl(location.path)} alt="" className="size-4 shrink-0" />
      {onLabelClick ? (
        <button
          type="button"
          aria-expanded={onToggle ? isExpanded : undefined}
          onClick={onLabelClick}
          className={`${LABEL_CLASS} group/label text-left`}
          title={describeSelection(location)}
        >
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
