import { useState } from "react";
import { isFolderIconRulesDefault, useSettingsStore, type FolderIconRule } from "../settings.store";
import { FOLDER_ICON_NAMES, resolveFolderIcon } from "../../ui/file-icons/file-icons.utils";
import { useFolderIconUrl } from "../../ui/file-icons/file-icons.hook";
import { SECONDARY_BUTTON_XS } from "../../ui/buttons.constants";
import { PlusIcon } from "../../ui/Icons";
import { ruleListEdits } from "../rule-list.utils";
import { IconRuleRow } from "../IconRuleRow";
import { PageHeader } from "../SettingsFields";

/** Example folder the folder icon preview starts with; it hits the default user interface rule. */
const PREVIEW_FOLDER_EXAMPLE = "apps/admin-ui";

/**
 * Which icon a folder gets: an ordered list of glob rules over the worktree-relative folder path, each for the matching
 * folder alone or for every folder below it too, with a live preview.
 */
export function FolderIconsPage() {
  const rules = useSettingsStore((state) => state.folderIconRules);
  const setFolderIconRules = useSettingsStore((state) => state.setFolderIconRules);
  const resetFolderIconRules = useSettingsStore((state) => state.resetFolderIconRules);
  const { update, remove, move, add } = ruleListEdits(() => useSettingsStore.getState().folderIconRules, setFolderIconRules);

  return (
    <section>
      <PageHeader title="Folder icons" hint="Which icon a folder gets, by glob over its path relative to the repository root" isDefault={isFolderIconRulesDefault(rules)} onReset={resetFolderIconRules} />
      <div className="flex flex-col gap-4">
        <p className="text-[13px] leading-snug text-neutral-500">
          Rules are tried top to bottom; the first whose glob matches wins, otherwise the folder name decides. A glob without a slash matches the folder name at any depth. With
          “Subfolders” every folder below a matching one gets the icon too; without it only the matching folder does.
        </p>
        <ul className="flex flex-col gap-1.5">
          {rules.map((rule, index) => (
            // Rows are positional: a rule has no identity of its own, and keying by index keeps the drafts with their row while typing.
            <IconRuleRow
              key={index}
              rule={rule}
              icons={FOLDER_ICON_NAMES}
              globExample="apps/admin-ui"
              onChange={(patch) => update(index, patch)}
              onRemove={() => remove(index)}
              onMoveUp={index > 0 ? () => move(index, -1) : undefined}
              onMoveDown={index < rules.length - 1 ? () => move(index, 1) : undefined}
            >
              <label className="flex shrink-0 items-center gap-1.5 text-[13px] text-neutral-300" title="Also give every folder below a matching one this icon">
                <input type="checkbox" checked={rule.includeSubfolders} onChange={(event) => update(index, { includeSubfolders: event.target.checked })} className="hunt-checkbox" />
                Subfolders
              </label>
            </IconRuleRow>
          ))}
        </ul>
        <div>
          <button type="button" onClick={() => add({ glob: "", icon: "", includeSubfolders: false })} className={SECONDARY_BUTTON_XS}>
            <PlusIcon />
            Add rule
          </button>
        </div>
        <FolderIconPreviewRow rules={rules} />
      </div>
    </section>
  );
}

/** Shows which icon a folder of the user's choosing gets under the current rules, closed, as they type. */
function FolderIconPreviewRow({ rules }: { rules: FolderIconRule[] }) {
  const folderIconUrl = useFolderIconUrl();
  const [path, setPath] = useState(PREVIEW_FOLDER_EXAMPLE);
  const trimmed = path.trim();

  return (
    <div className="flex items-center gap-3 border-t border-(--line) pt-4">
      <div className="min-w-0 flex-1 text-sm text-neutral-100">Preview</div>
      <input
        type="text"
        value={path}
        spellCheck={false}
        onChange={(event) => setPath(event.target.value)}
        placeholder="Folder to try, e.g. apps/admin-ui/src"
        className="w-72 truncate rounded border border-neutral-600 bg-(--surface-input) px-2 py-1 font-mono text-sm text-neutral-200 outline-none focus:border-neutral-400"
        aria-label="Folder to preview the icon of"
      />
      <div className="flex w-40 items-center gap-2 text-[13px] text-neutral-400">
        {trimmed ? <img src={folderIconUrl(trimmed)} alt="" className="size-4 shrink-0" /> : <span className="size-4 shrink-0" />}
        <span className="truncate font-mono">{trimmed ? resolveFolderIcon(trimmed, rules) : ""}</span>
      </div>
    </div>
  );
}
