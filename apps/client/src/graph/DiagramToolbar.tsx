import { useRef, useState } from "react";
import { DIAGRAMS_DIR } from "../common/diagram/diagram-file.utils";
import type { DiagramType } from "../common/diagram/diagram.types";
import type { GraphStatus } from "./graph.types";
import { commands } from "../ipc/commands";
import { useHuntStore } from "../sessions/hunt.store";
import { useSettingsStore } from "../settings/settings.store";
import { BUTTON_BASE, PRIMARY, PRIMARY_BUTTON_XS, SECONDARY_BUTTON_XS } from "../ui/buttons.constants";
import { confirmDestructive } from "../ui/confirm.utils";
import { Dropdown } from "../ui/Dropdown";
import { ChevronDownIcon } from "../ui/Icons";
import { useDismiss } from "../ui/dismiss.hook";
import { errorText } from "../ui/error-text.utils";
import { useLoad } from "../ui/load.hook";
import { baseName, dirName } from "../common/path/path.utils";
import { DIAGRAM_FILES, DIAGRAM_TYPES } from "./diagram-types.constants";
import { defaultDiagramName, diagramFilePath, expandSaveFolders } from "./diagram-save.utils";

const BADGE_BASE = "rounded-md border px-2 py-0.5 text-[12px] font-medium";

/**
 * Picks which diagram template the Architecture tab shows for `sessionId`; the choice is remembered per session. Each
 * template shows the session's diagram of that type in `.hunt/diagrams/`, and those whose file exists carry a badge.
 * A diagram file of the repository is no option: it opens through "Show in Architecture", the trigger then shows no
 * template, and picking one returns to the session's diagrams.
 */
export function DiagramTypeDropdown({ sessionId }: { sessionId: string }) {
  const diagramType = useSettingsStore((state) => state.diagramTypes[sessionId] ?? "dependencies");
  const file = useSettingsStore((state) => state.diagramFiles[sessionId]);
  const setDiagramType = useSettingsStore((state) => state.setDiagramType);
  const graphVersion = useHuntStore((state) => state.chats[sessionId]?.graphVersion ?? 0);
  const [existing, setExisting] = useState<ReadonlySet<string>>(new Set());

  useLoad(
    () => commands.listDir(sessionId, DIAGRAMS_DIR).catch(() => []),
    { onValue: (entries) => setExisting(new Set(entries.filter((entry) => !entry.isDir).map((entry) => entry.name))), onError: () => setExisting(new Set()) },
    [sessionId, graphVersion],
  );

  const options = DIAGRAM_TYPES.map((type) => ({
    id: type.id,
    name: type.name,
    description: type.description,
    badge: existing.has(baseName(DIAGRAM_FILES[type.id])) ? "created" : undefined,
  }));
  return (
    <Dropdown
      title={file ? `Diagram template (showing ${file})` : "Diagram template"}
      value={file ? "" : diagramType}
      placeholder="Template"
      options={options}
      onChange={(id) => setDiagramType(sessionId, id as DiagramType)}
      className={SECONDARY_BUTTON_XS}
    />
  );
}

/**
 * Saves a generated diagram into the repository: a popover offers the folders the save pattern from the settings
 * names (one per app with the default `apps/*` pattern) and a file name, writes the file there as a worktree change
 * and hands its path to `onSaved`. Overwriting an existing file asks first.
 */
export function SaveDiagramButton({ sessionId, diagram, content, onSaved }: { sessionId: string; diagram: { type: string; title?: string }; content: () => string; onSaved: (path: string) => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const pattern = useSettingsStore((state) => state.diagramSaveDir);
  const [isOpen, setIsOpen] = useState(false);
  const [folders, setFolders] = useState<string[] | null>(null);
  const [folder, setFolder] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const close = () => setIsOpen(false);
  useDismiss(rootRef, close, { anchorRefs: [buttonRef], isEnabled: isOpen });

  const open = () => {
    setIsOpen(true);
    setError(null);
    setName(defaultDiagramName(diagram));
    setFolders(null);
    const listFolders = async (path: string) => (await commands.listDir(sessionId, path)).filter((entry) => entry.isDir).map((entry) => entry.name);
    void expandSaveFolders(pattern, listFolders).then((found) => {
      setFolders(found);
      setFolder((current) => (found.includes(current) ? current : (found[0] ?? "")));
    });
  };

  const save = async () => {
    const path = diagramFilePath(folder, name);
    setIsSaving(true);
    try {
      const existing = await commands.listDir(sessionId, dirName(path)).catch(() => []);
      if (existing.some((entry) => entry.name === baseName(path)) && !(await confirmDestructive(`${path} exists already. Overwrite it?`, "Overwrite"))) return;
      await commands.writeFile(sessionId, path, content());
      close();
      onSaved(path);
    } catch (reason) {
      setError(`Saving failed: ${errorText(reason)}`);
    } finally {
      setIsSaving(false);
    }
  };

  const canSave = Boolean(folder) && Boolean(name.trim()) && !isSaving;
  return (
    <div className="relative inline-flex shrink-0">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => (isOpen ? close() : open())}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        title="Save the diagram into the repository"
        className={SECONDARY_BUTTON_XS}
      >
        Save…
      </button>
      {isOpen ? (
        <div ref={rootRef} role="dialog" aria-label="Save diagram" className="absolute top-full left-0 z-20 mt-1 flex w-[28rem] max-w-[calc(100vw-2rem)] flex-col gap-2 rounded-md border border-neutral-600 bg-(--surface-inset) p-2 text-[13px] shadow-lg">
          <div className="flex flex-col gap-1">
            <span className="text-neutral-400">Folder</span>
            {folders === null ? (
              <span className="text-neutral-500">Looking for folders…</span>
            ) : folders.length ? (
              <div role="listbox" aria-label="Folder" className="flex max-h-48 flex-col overflow-y-auto rounded border border-neutral-600 bg-(--surface-input) p-0.5">
                {folders.map((path) => (
                  <button
                    key={path}
                    type="button"
                    role="option"
                    aria-selected={path === folder}
                    onClick={() => setFolder(path)}
                    className={`truncate rounded px-2 py-1 text-left font-mono text-[12px] ${path === folder ? "bg-blue-500/25 text-neutral-100" : "text-neutral-300 hover:bg-(--row-hover)"}`}
                  >
                    {path}
                  </button>
                ))}
              </div>
            ) : (
              <span className="text-amber-300/90">No folder matches {pattern}; change the pattern under Settings → Architecture.</span>
            )}
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-neutral-400">File name</span>
            <input
              type="text"
              value={name}
              spellCheck={false}
              autoFocus
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && canSave) {
                  event.preventDefault();
                  void save();
                }
              }}
              className="h-7 rounded border border-neutral-600 bg-(--surface-input) px-2"
            />
            {folder && name.trim() ? <span className="truncate text-[12px] text-neutral-500">{diagramFilePath(folder, name)}</span> : null}
          </label>
          {error ? <p className="text-red-300">{error}</p> : null}
          <div className="flex justify-end">
            <button type="button" disabled={!canSave} onClick={() => void save()} className={PRIMARY_BUTTON_XS}>
              {isSaving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * "Outdated" once files the diagram was derived from changed since it was written, "Up to date" otherwise; nothing
 * without a diagram. An opened diagram file shows its name before the chip, and the chip only when the file records
 * hashed sources (`hasSources`), since nothing else tells what it was derived from. Floats in the top-left corner of
 * the diagram canvas, so its parent must be positioned.
 */
export function DiagramStatusBadge({
  status,
  hasDiagram,
  filePath,
  hasSources = false,
}: {
  status: GraphStatus | null;
  hasDiagram: boolean;
  filePath?: string | null;
  hasSources?: boolean;
}) {
  if (!hasDiagram) return null;
  return (
    <div className="absolute top-3 left-3 z-10 flex max-w-[calc(100%-1.5rem)] items-center gap-2">
      {filePath ? (
        <span className="flex min-w-0 font-mono text-[12px] text-neutral-400" title={filePath}>
          {dirName(filePath) ? <span className="truncate">{dirName(filePath)}/</span> : null}
          <span className="shrink-0 font-semibold text-neutral-300">{baseName(filePath)}</span>
        </span>
      ) : null}
      {filePath && !hasSources ? null : status?.isOutdated ? (
        <span className={`${BADGE_BASE} shrink-0 border-amber-400/30 bg-amber-400/10 text-amber-300`} title="Files the diagram was derived from changed since it was written.">
          Outdated
        </span>
      ) : (
        <span className={`${BADGE_BASE} shrink-0 border-emerald-400/30 bg-emerald-400/10 text-emerald-300`} title="No file the diagram was derived from changed since it was written.">
          Up to date
        </span>
      )}
    </div>
  );
}

/**
 * The generate button of a diagram: its main part generates with the standard prompt, the chevron beside it opens a
 * popover with a text box whose instructions go along with that one run. ⌘/Ctrl+Enter in the box submits.
 */
export function GenerateSplitButton({
  label,
  isDisabled,
  title,
  onGenerate,
}: {
  label: string;
  isDisabled: boolean;
  /** Tooltip of the main part. */
  title?: string;
  onGenerate: (instructions: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const chevronRef = useRef<HTMLButtonElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [text, setText] = useState("");

  const close = () => setIsOpen(false);
  useDismiss(rootRef, close, { anchorRefs: [chevronRef], isEnabled: isOpen });

  const submit = () => {
    onGenerate(text.trim());
    setText("");
    close();
  };

  return (
    <div className="relative inline-flex shrink-0">
      <button type="button" disabled={isDisabled} onClick={() => onGenerate("")} title={title} className={`${PRIMARY_BUTTON_XS} rounded-r-none`}>
        {label}
      </button>
      <button
        ref={chevronRef}
        type="button"
        disabled={isDisabled}
        onClick={() => setIsOpen((value) => !value)}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-label="Generate with additional instructions"
        title="Generate with additional instructions"
        className={`${BUTTON_BASE} ${PRIMARY} h-[29px] rounded-l-none border-l border-white/20 px-2 text-[13px]`}
      >
        <ChevronDownIcon className="size-3.5" />
      </button>
      {isOpen ? (
        <div ref={rootRef} role="dialog" aria-label="Additional instructions" className="absolute top-full left-0 z-20 mt-1 w-[32rem] max-w-[calc(100vw-2rem)] rounded-md border border-neutral-600 bg-(--surface-inset) p-2 shadow-lg">
          <label className="mb-1 block text-[13px] text-neutral-400">Additional instructions</label>
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                submit();
              }
            }}
            placeholder="Focus on the payment flow"
            autoFocus
            rows={4}
            className="mb-2 w-full resize-y rounded border border-neutral-600 bg-(--surface-input) px-2 py-1 text-[13px]"
          />
          <div className="flex justify-end">
            <button type="button" disabled={isDisabled} onClick={submit} className={PRIMARY_BUTTON_XS}>
              Generate
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
