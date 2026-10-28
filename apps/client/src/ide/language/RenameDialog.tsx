import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type * as monaco from "monaco-editor";
import { INPUT } from "../../ui/styles.constants";
import { PaneSeparator, Panel, PersistentGroup } from "../../ui/ResizablePanes";
import { PopupModeButton, PopupWindowTitleBar } from "../../ui/PopupTitleBar";
import type { PopupActions } from "../../ui/popup-protocol.utils";
import { useDetachedPopup } from "../../ui/detached-popup.hook";
import { openInHostWindow } from "../../ui/detached-popup.utils";
import { useSettingsStore } from "../../settings/settings.store";
import { GHOST_BUTTON_MD, PRIMARY_BUTTON_MD, SECONDARY_BUTTON_MD } from "../../ui/buttons.constants";
import { Modal } from "../../ui/Modal";
import { splitPath } from "../../common/path/path.utils";
import { useDialogSize } from "../../ui/dialog-size.hook";
import { errorText } from "../../ui/error-text.utils";
import type { DocumentWorkspace } from "../documents/documents.service";
import { FilePreview } from "../search/FileSearchDialog";
import { applyRename, planRename, type RenameOptions, type RenamePlan, type RenameTarget } from "./language-service.utils";
import { GROUP_LABELS, nameProblem, OCCURRENCE_GROUPS, occurrenceSummary, type RenameOccurrence } from "./rename.utils";
import { kindLabel } from "./usages.utils";

/** Smallest heights in pixels the list and the preview can be dragged to: two rows and three lines. */
const MIN_LIST_HEIGHT = 56;
const MIN_PREVIEW_HEIGHT = 64;

/** The options of the last rename in this window; the dialog reopens with them like WebStorm's. */
let lastOptions: RenameOptions = { commentsAndStrings: false, textOccurrences: false };

type RenameDialogProps = {
  workspace: DocumentWorkspace;
  /** The model the rename started in and the symbol there (see `renameTarget`). */
  model: monaco.editor.ITextModel;
  target: RenameTarget;
  onClose: () => void;
};

/**
 * WebStorm's Rename dialog: asks for the new name of `target` and whether the old name's matches in comments and
 * strings and in non-code files change too. Refactor renames at once; Preview lists every occurrence with a check box
 * first, and so does Refactor when it found matches in comments, strings or other files. Enter refactors, Esc closes.
 */
export function RenameDialog({ workspace, model, target, onClose }: RenameDialogProps) {
  const dialog = useDialogSize("rename");
  const [newName, setNewName] = useState(target.name);
  const [options, setOptions] = useState(lastOptions);
  const [busy, setBusy] = useState<"refactor" | "preview" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ plan: RenamePlan; reason: string | null } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    lastOptions = options;
  }, [options]);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  const name = newName.trim();
  const problem = name && !target.isStringLiteral ? nameProblem(name, target.name, target.kind) : null;
  const canSubmit = !!name && name !== target.name && !problem && !busy;

  async function submit(showsPreview: boolean) {
    if (!canSubmit) return;
    setBusy(showsPreview ? "preview" : "refactor");
    setError(null);
    try {
      const plan = await planRename(workspace, model, target, name, options);
      const hasTextMatches = plan.occurrences.some((occurrence) => occurrence.group !== "code");
      if (showsPreview || hasTextMatches) {
        setPreview({ plan, reason: showsPreview ? null : "Occurrences were found in comments, strings or non-code files. Check them before the rename." });
        return;
      }
      await applyRename(workspace, plan, new Set(plan.occurrences.map((occurrence) => occurrence.key)));
      onClose();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(null);
    }
  }

  if (preview) return <RenamePreview workspace={workspace} plan={preview.plan} reason={preview.reason} onBack={() => setPreview(null)} onClose={onClose} />;

  const kind = kindLabel(target.kind).toLowerCase();
  return (
    <Modal label="Rename" onClose={onClose} isCloseable={!busy} className="bg-(--surface-chat) p-4" style={dialog.style} resize={dialog.resize}>
      <h2 className="mb-3 text-base font-semibold">Rename</h2>
      <label htmlFor="rename-new-name" className="mb-1.5 block truncate text-[13px] text-neutral-300" title={`Rename ${kind} '${target.name}' and its usages to:`}>
        Rename {kind} '<span className="font-mono">{target.name}</span>' and its usages to:
      </label>
      <input
        id="rename-new-name"
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
          <input
            type="checkbox"
            checked={options.commentsAndStrings}
            onChange={(event) => setOptions({ ...options, commentsAndStrings: event.target.checked })}
            className="hunt-checkbox"
          />
          Search in comments and strings
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={options.textOccurrences}
            onChange={(event) => setOptions({ ...options, textOccurrences: event.target.checked })}
            className="hunt-checkbox"
          />
          Search for text occurrences
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

/** What the rename preview lists: the plan without the file texts, which only the host needs to rename. */
type PreviewedPlan = Pick<RenamePlan, "name" | "newName" | "occurrences">;

/** What the rename preview window shows (see detached-popup.hook.ts); the host renames and reports progress and failure here. */
export type RenamePreviewContent = { sessionId: string; plan: PreviewedPlan; reason: string | null; isApplying: boolean; error: string | null };

type RenamePreviewProps = {
  workspace: DocumentWorkspace;
  plan: RenamePlan;
  /** Why the preview opened although Refactor was pressed; null after Preview. */
  reason: string | null;
  onBack: () => void;
  onClose: () => void;
};

/**
 * The rename preview (see `RenamePreviewView`) inside the app window or in a window of its own, as the user chose (see
 * detached-popup.hook.ts); either way the host renames the checked occurrences through `workspace` and closes once done.
 */
function RenamePreview({ workspace, plan, reason, onBack, onClose }: RenamePreviewProps) {
  const isDetached = useSettingsStore((state) => state.detachedPopups.renamePreview);
  const [isApplying, setIsApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function apply(included: ReadonlySet<string>) {
    if (isApplying) return;
    setIsApplying(true);
    setError(null);
    try {
      await applyRename(workspace, plan, included);
      onClose();
    } catch (failure) {
      setError(errorText(failure));
      setIsApplying(false);
    }
  }

  if (isDetached) {
    return (
      <DetachedRenamePreview
        sessionId={workspace.sessionId}
        plan={plan}
        reason={reason}
        isApplying={isApplying}
        error={error}
        onApply={(included) => void apply(included)}
        onBack={onBack}
        onClose={onClose}
      />
    );
  }
  return (
    <RenamePreviewView
      sessionId={workspace.sessionId}
      plan={plan}
      reason={reason}
      isApplying={isApplying}
      error={error}
      isDetached={false}
      onApply={(included) => void apply(included)}
      onBack={onBack}
      onClose={onClose}
    />
  );
}

type RenamePreviewViewProps = {
  sessionId: string;
  plan: PreviewedPlan;
  reason: string | null;
  isApplying: boolean;
  error: string | null;
  isDetached: boolean;
  /** Renames the occurrences with these keys. */
  onApply: (included: ReadonlySet<string>) => void;
  onBack: () => void;
  onClose: () => void;
};

/** The rename preview window's host side: hands the plan over, renames what is checked there and goes back on request. */
function DetachedRenamePreview({
  sessionId,
  plan,
  reason,
  isApplying,
  error,
  onApply,
  onBack,
  onClose,
}: Omit<RenamePreviewViewProps, "plan" | "isDetached"> & { plan: RenamePlan }) {
  const content = useMemo<RenamePreviewContent>(
    () => ({ sessionId, plan: { name: plan.name, newName: plan.newName, occurrences: plan.occurrences }, reason, isApplying, error }),
    [sessionId, plan, reason, isApplying, error],
  );
  useDetachedPopup("renamePreview", content, {
    revision: plan,
    anchor: () => "center",
    onAction: (action: PopupActions["renamePreview"]) => openInHostWindow(() => (action.type === "apply" ? onApply(new Set(action.keys)) : onBack())),
    onClose,
  });
  return null;
}

/** The rename preview in its own window (see PopupWindow.tsx); the host window renames and goes back to its Rename dialog. */
export function RenamePreviewWindowContent({
  content,
  onAction,
  onClose,
}: {
  content: RenamePreviewContent;
  onAction: (action: PopupActions["renamePreview"]) => void;
  onClose: () => void;
}) {
  return (
    <RenamePreviewView
      sessionId={content.sessionId}
      plan={content.plan}
      reason={content.reason}
      isApplying={content.isApplying}
      error={content.error}
      isDetached
      onApply={(included) => onAction({ type: "apply", keys: [...included] })}
      onBack={() => onAction({ type: "back" })}
      onClose={onClose}
    />
  );
}

/**
 * WebStorm's refactoring preview: the occurrences grouped into code usages, comments and strings, and text
 * occurrences, each with a check box (a group's box switches all of its rows), and the selected one shown in its file
 * below. ↑/↓ select a row, Space switches its box; Do Refactor renames the checked occurrences. Inside the app it is a
 * dialog; `isDetached` fills a popup window instead.
 */
function RenamePreviewView({ sessionId, plan, reason, isApplying, error, isDetached, onApply, onBack, onClose }: RenamePreviewViewProps) {
  const dialog = useDialogSize("renamePreview", { fillsHeight: true, min: { width: 560, height: 320 } });
  const [included, setIncluded] = useState(() => new Set(plan.occurrences.map((occurrence) => occurrence.key)));
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const groups = useMemo(
    () =>
      OCCURRENCE_GROUPS.map((group) => ({ group, occurrences: plan.occurrences.filter((occurrence) => occurrence.group === group) })).filter(
        (entry) => entry.occurrences.length,
      ),
    [plan],
  );
  const selected = plan.occurrences[Math.min(selectedIndex, plan.occurrences.length - 1)] as RenameOccurrence | undefined;
  const checked = plan.occurrences.filter((occurrence) => included.has(occurrence.key));

  useEffect(() => {
    listRef.current?.focus();
  }, []);

  useEffect(() => {
    listRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const toggle = (keys: string[], isOn: boolean) => {
    setIncluded((current) => {
      const next = new Set(current);
      for (const key of keys) {
        if (isOn) {
          next.add(key);
        } else {
          next.delete(key);
        }
      }
      return next;
    });
  };

  const refactor = () => {
    if (!checked.length || isApplying) return;
    onApply(included);
  };

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.defaultPrevented || !plan.occurrences.length) return;
    const count = plan.occurrences.length;
    if (event.key === "ArrowDown") {
      setSelectedIndex((index) => Math.min(index + 1, count - 1));
    } else if (event.key === "ArrowUp") {
      setSelectedIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === " " && selected) {
      toggle([selected.key], !included.has(selected.key));
    } else {
      return;
    }
    event.preventDefault();
  };

  const heading = (
    <>
      <span className="min-w-0 truncate font-semibold text-neutral-200">
        Rename '<span className="font-mono">{plan.name}</span>' to '<span className="font-mono">{plan.newName}</span>'
      </span>
      <span className="min-w-0 flex-1 truncate text-neutral-500">{occurrenceSummary(plan.occurrences)}</span>
    </>
  );
  const body = (
    <>
      {isDetached ? (
        <PopupWindowTitleBar popupKey="renamePreview">{heading}</PopupWindowTitleBar>
      ) : (
        <div className="flex h-10 shrink-0 items-center gap-3 border-b border-(--line) px-3 text-[13px]">
          {heading}
          <PopupModeButton popupKey="renamePreview" isDetached={false} />
        </div>
      )}
      {reason ? <p className="shrink-0 border-b border-(--line) bg-amber-300/10 px-3 py-2 text-[13px] text-amber-200">{reason}</p> : null}
      <PersistentGroup id="rename-preview" fillPane="preview" orientation="vertical" className="flex min-h-0 flex-1 flex-col">
        <Panel id="list" defaultSize="45" minSize={MIN_LIST_HEIGHT} className="flex min-h-0 flex-col">
          <div ref={listRef} tabIndex={0} onKeyDown={onKeyDown} className="min-h-0 flex-1 overflow-auto py-1 text-[13px] outline-none">
            {groups.length ? null : <p className="px-3 py-2 text-neutral-500">Nothing to rename.</p>}
            {groups.map(({ group, occurrences }) => {
              const keys = occurrences.map((occurrence) => occurrence.key);
              const checkedCount = keys.filter((key) => included.has(key)).length;
              return (
                <div key={group}>
                  <label className="flex items-center gap-2 px-3 py-1 font-medium text-neutral-300">
                    <input
                      type="checkbox"
                      checked={checkedCount === keys.length}
                      ref={(box) => {
                        if (box) {
                          box.indeterminate = checkedCount > 0 && checkedCount < keys.length;
                        }
                      }}
                      onChange={(event) => toggle(keys, event.target.checked)}
                      className="hunt-checkbox"
                    />
                    {GROUP_LABELS[group]}
                    <span className="font-normal text-neutral-500">{occurrenceSummary(occurrences)}</span>
                  </label>
                  {occurrences.map((occurrence) => {
                    const index = plan.occurrences.indexOf(occurrence);
                    const { name: fileName, dir } = splitPath(occurrence.path);
                    const isIncluded = included.has(occurrence.key);
                    return (
                      <div
                        key={occurrence.key}
                        onMouseDown={(event) => {
                          if (!(event.target instanceof HTMLInputElement)) {
                            event.preventDefault();
                          }
                        }}
                        onClick={() => {
                          setSelectedIndex(index);
                          listRef.current?.focus();
                        }}
                        data-selected={occurrence === selected}
                        className="tree-row flex cursor-pointer items-center gap-2 py-1 pr-3 pl-8"
                      >
                        <input
                          type="checkbox"
                          checked={isIncluded}
                          onChange={(event) => toggle([occurrence.key], event.target.checked)}
                          className="hunt-checkbox"
                          aria-label={`Rename ${occurrence.path}:${occurrence.line}`}
                        />
                        <span className={`min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-pre ${isIncluded ? "text-neutral-200" : "text-neutral-500"}`}>
                          {occurrence.text.slice(0, occurrence.matchStart)}
                          <mark className={`rounded-sm text-inherit ${isIncluded ? "bg-amber-300/30" : "bg-transparent"}`}>{occurrence.text.slice(occurrence.matchStart, occurrence.matchEnd)}</mark>
                          {occurrence.text.slice(occurrence.matchEnd)}
                        </span>
                        <span className="flex max-w-[45%] min-w-0 shrink-0 text-neutral-500">
                          {dir ? <span className="truncate">{dir}/</span> : null}
                          <span className="shrink-0 text-neutral-400">{fileName}</span>
                          <span className="ml-2 shrink-0 tabular-nums">{occurrence.line}</span>
                        </span>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </Panel>
        <PaneSeparator orientation="vertical" />
        <Panel id="preview" defaultSize="55" minSize={MIN_PREVIEW_HEIGHT} className="flex min-h-0 flex-col">
          {selected ? (
            <FilePreview
              sessionId={sessionId}
              path={selected.path}
              line={selected.line}
              column={selected.column}
              endColumn={selected.endLine === selected.line ? selected.endColumn : undefined}
              isReadOnly
            />
          ) : null}
        </Panel>
      </PersistentGroup>
      <div className="flex shrink-0 items-center gap-2 border-t border-(--line) px-3 py-2 text-[13px]">
        <span className="min-w-0 flex-1 truncate text-red-400" title={error ?? undefined}>
          {error}
        </span>
        <button type="button" onClick={onBack} disabled={isApplying} className={GHOST_BUTTON_MD}>
          Back
        </button>
        <button type="button" onClick={onClose} disabled={isApplying} className={GHOST_BUTTON_MD}>
          Cancel
        </button>
        <button type="button" onClick={refactor} disabled={!checked.length || isApplying} className={PRIMARY_BUTTON_MD}>
          {isApplying ? "Renaming…" : `Do Refactor (${checked.length})`}
        </button>
      </div>
    </>
  );

  if (isDetached) {
    return (
      <div role="dialog" aria-label="Rename preview" className="flex h-screen flex-col bg-(--surface-inspector)">
        {body}
      </div>
    );
  }
  return (
    <Modal label="Rename preview" onClose={onClose} isCloseable={!isApplying} className="bg-(--surface-inspector)" style={dialog.style} resize={dialog.resize}>
      {body}
    </Modal>
  );
}
