import { useEffect, useRef, useState } from "react";
import { INPUT } from "../../ui/styles.constants";
import { GHOST_BUTTON_MD, PRIMARY_BUTTON_MD, SECONDARY_BUTTON_MD } from "../../ui/buttons.constants";
import { Modal } from "../../ui/Modal";
import { useDialogSize } from "../../ui/dialog-size.hook";
import { errorText } from "../../ui/error-text.utils";
import { baseName, isInsideFolder } from "../../common/path/path.utils";
import type { DocumentWorkspace } from "../documents/documents.service";
import { RenamePreview } from "../language/RenameDialog";
import { applyPathRename, planPathRename, type PathRenameOptions, type RenamePlan } from "../language/language-service.utils";
import { newNameProblem, renamedTo } from "../language/path-rename.utils";

/** The options of the last path rename in this window; the dialog reopens with them like WebStorm's. */
let lastOptions: PathRenameOptions = { textOccurrences: true };

type RenamePathDialogProps = {
  workspace: DocumentWorkspace;
  /** The worktree path of the file or folder to rename. */
  path: string;
  isDir: boolean;
  onClose: () => void;
  /** Called once the file or folder is at `to`, before the dialog closes. */
  onRenamed: (from: string, to: string) => void;
};

/**
 * WebStorm's Rename dialog for a file or folder of the project tree: asks for the new name and whether the old path's
 * mentions in every file change too; the import specifiers the language server rewrites always do. Refactor renames at
 * once; Preview lists every occurrence with a check box first, and so does Refactor when it found text occurrences.
 * Enter refactors, Esc closes. A folder with unsaved files below it cannot be renamed until they are saved.
 */
export function RenamePathDialog({ workspace, path, isDir, onClose, onRenamed }: RenamePathDialogProps) {
  const dialog = useDialogSize("renamePath");
  const currentName = baseName(path);
  const [newName, setNewName] = useState(currentName);
  const [options, setOptions] = useState(lastOptions);
  const [busy, setBusy] = useState<"refactor" | "preview" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ plan: RenamePlan; reason: string | null } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    lastOptions = options;
  }, [options]);

  // The name without its extension is selected, as in WebStorm, so typing replaces just that.
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const extension = isDir ? -1 : currentName.lastIndexOf(".");
    input.setSelectionRange(0, extension > 0 ? extension : currentName.length);
  }, [currentName, isDir]);

  const name = newName.trim();
  const problem = name ? newNameProblem(name) : null;
  const canSubmit = !!name && name !== currentName && !problem && !busy;
  const kind = isDir ? "folder" : "file";

  const apply = async (plan: RenamePlan, included: ReadonlySet<string>) => {
    await applyPathRename(workspace, plan, included);
    onRenamed(plan.name, plan.newName);
  };

  async function submit(showsPreview: boolean) {
    if (!canSubmit) return;
    const unsaved = workspace.dirtyPaths().filter((dirty) => dirty === path || isInsideFolder(dirty, path));
    if (unsaved.length) {
      setError(`Save ${unsaved.length === 1 ? unsaved[0] : `the ${unsaved.length} unsaved files in ${path}`} before renaming.`);
      return;
    }
    setBusy(showsPreview ? "preview" : "refactor");
    setError(null);
    try {
      const plan = await planPathRename(workspace, path, renamedTo(path, name), options);
      const hasTextMatches = plan.occurrences.some((occurrence) => occurrence.group !== "code");
      if (showsPreview || hasTextMatches) {
        setPreview({ plan, reason: showsPreview ? null : "The old path was found as text. Check the occurrences before the rename." });
        return;
      }
      await apply(plan, new Set(plan.occurrences.map((occurrence) => occurrence.key)));
      onClose();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(null);
    }
  }

  if (preview) {
    return (
      <RenamePreview
        workspace={workspace}
        plan={preview.plan}
        reason={preview.reason}
        apply={(included) => apply(preview.plan, included)}
        onBack={() => setPreview(null)}
        onClose={onClose}
      />
    );
  }

  return (
    <Modal label={`Rename ${kind}`} onClose={onClose} isCloseable={!busy} className="bg-(--surface-chat) p-4" style={dialog.style} resize={dialog.resize}>
      <h2 className="mb-3 text-base font-semibold">Rename {kind}</h2>
      <label htmlFor="rename-path-new-name" className="mb-1.5 block truncate text-[13px] text-neutral-300" title={`Rename ${kind} '${path}' and its usages to:`}>
        Rename {kind} '<span className="font-mono">{path}</span>' and its usages to:
      </label>
      <input
        id="rename-path-new-name"
        ref={inputRef}
        value={newName}
        onChange={(event) => setNewName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void submit(false);
          }
        }}
        autoFocus
        spellCheck={false}
        className={`${INPUT} font-mono`}
      />
      {problem ? <p className="mt-1.5 text-[13px] text-red-400">{problem}</p> : null}
      <div className="mt-4 mb-4 flex flex-wrap gap-x-6 gap-y-2 text-[13px] text-neutral-200">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={options.textOccurrences} onChange={(event) => setOptions({ textOccurrences: event.target.checked })} className="hunt-checkbox" />
          Search for text occurrences of the path
        </label>
      </div>
      {error ? <p className="mb-3 text-[13px] text-red-400">{error}</p> : null}
      <div className="mt-auto flex justify-end gap-2">
        <button type="button" onClick={onClose} disabled={!!busy} className={GHOST_BUTTON_MD}>
          Cancel
        </button>
        <button type="button" onClick={() => void submit(true)} disabled={!canSubmit} className={SECONDARY_BUTTON_MD}>
          {busy === "preview" ? "Searching…" : "Preview"}
        </button>
        <button type="button" onClick={() => void submit(false)} disabled={!canSubmit} className={PRIMARY_BUTTON_MD}>
          {busy === "refactor" ? "Renaming…" : "Refactor"}
        </button>
      </div>
    </Modal>
  );
}
