import { useState } from "react";
import { isIconRulesDefault, useSettingsStore, type IconRule } from "../settings.store";
import { resolveFileIcon } from "../../ui/file-icons/file-icons.utils";
import { useFileIconUrl } from "../../ui/file-icons/file-icons.hook";
import { SECONDARY_BUTTON_XS } from "../../ui/buttons.constants";
import { PlusIcon } from "../../ui/Icons";
import { ruleListEdits } from "../rule-list.utils";
import { IconRuleRow } from "../IconRuleRow";
import { PageHeader } from "../SettingsFields";

/** Example path the preview starts with; it hits the default NestJS service rule. */
const PREVIEW_PATH_EXAMPLE = "apps/api/src/user/user.service.ts";

/** Which icon a file gets: an ordered list of glob rules over the worktree-relative path, with a live preview. */
export function FileIconsPage() {
  const rules = useSettingsStore((state) => state.iconRules);
  const setIconRules = useSettingsStore((state) => state.setIconRules);
  const resetIconRules = useSettingsStore((state) => state.resetIconRules);
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const isShown = (rule: IconRule) => !needle || rule.glob.toLowerCase().includes(needle) || rule.icon.toLowerCase().includes(needle);

  const { update, remove, move, add } = ruleListEdits(() => useSettingsStore.getState().iconRules, setIconRules);

  return (
    <section>
      <PageHeader title="File icons" hint="Which icon a file gets, by glob over its path relative to the repository root" isDefault={isIconRulesDefault(rules)} onReset={resetIconRules} />
      <div className="flex flex-col gap-4">
        <p className="text-[13px] leading-snug text-neutral-500">
          Rules are tried top to bottom; the first whose glob matches wins, otherwise the file name decides. A glob without a slash matches the file name in any folder, <code>**</code> spans folders and{" "}
          <code>{"{a,b}"}</code> lists alternatives.
        </p>
        <input
          type="text"
          value={filter}
          spellCheck={false}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={`Filter ${rules.length} rules by glob or icon`}
          aria-label="Filter rules"
          className="w-full rounded border border-neutral-600 bg-(--surface-input) px-2 py-1 text-sm text-neutral-200 outline-none placeholder:text-neutral-600 focus:border-neutral-400"
        />
        <ul className="flex flex-col gap-1.5">
          {rules.map((rule, index) =>
            // Rows are positional: a rule has no identity of its own, and keying by index keeps the drafts with their row while typing.
            isShown(rule) ? (
              <IconRuleRow
                key={index}
                rule={rule}
                onChange={(patch) => update(index, patch)}
                onRemove={() => remove(index)}
                onMoveUp={index > 0 ? () => move(index, -1) : undefined}
                onMoveDown={index < rules.length - 1 ? () => move(index, 1) : undefined}
              />
            ) : null,
          )}
        </ul>
        <div>
          <button type="button" onClick={() => add({ glob: "", icon: "" })} className={SECONDARY_BUTTON_XS}>
            <PlusIcon />
            Add rule
          </button>
        </div>
        <IconPreviewRow rules={rules} />
      </div>
    </section>
  );
}

/** Shows which icon a path of the user's choosing gets under the current rules, as they type. */
function IconPreviewRow({ rules }: { rules: IconRule[] }) {
  const fileIconUrl = useFileIconUrl();
  const [path, setPath] = useState(PREVIEW_PATH_EXAMPLE);
  const trimmed = path.trim();

  return (
    <div className="flex items-center gap-3 border-t border-(--line) pt-4">
      <div className="min-w-0 flex-1 text-sm text-neutral-100">Preview</div>
      <input
        type="text"
        value={path}
        spellCheck={false}
        onChange={(event) => setPath(event.target.value)}
        placeholder="Path to try, e.g. apps/api/src/main.ts"
        className="w-72 truncate rounded border border-neutral-600 bg-(--surface-input) px-2 py-1 font-mono text-sm text-neutral-200 outline-none focus:border-neutral-400"
        aria-label="Path to preview the icon of"
      />
      <div className="flex w-40 items-center gap-2 text-[13px] text-neutral-400">
        {trimmed ? <img src={fileIconUrl(trimmed)} alt="" className="size-4 shrink-0" /> : <span className="size-4 shrink-0" />}
        <span className="truncate font-mono">{trimmed ? resolveFileIcon(trimmed, rules) : ""}</span>
      </div>
    </div>
  );
}
