import { useState, type KeyboardEvent } from "react";
import { useSettingsStore } from "../settings.store";
import { KEYMAP_COMMANDS, type CommandId, type KeymapCommand } from "../../common/keymap/keymap-commands.data";
import { Keymap, keymapCommand } from "../../common/keymap/keymap.value-object";
import { Shortcut } from "../../common/keymap/shortcut.value-object";
import { BUTTON_XS, ICON_BUTTON_SM } from "../../ui/buttons.constants";
import { CloseIcon, PlusIcon } from "../../ui/Icons";
import { PageHeader } from "../SettingsFields";

/** The keymap's commands in the order of their groups' first command. */
const KEYMAP_GROUPS: { title: string; commands: KeymapCommand[] }[] = [...new Set(KEYMAP_COMMANDS.map((command) => command.group))].map((group) => ({
  title: group,
  commands: KEYMAP_COMMANDS.filter((command) => command.group === group),
}));

/**
 * The keymap: every shortcut Hunt handles itself, grouped like the app. A command may have several bindings; "+"
 * records one more, × removes one, and two commands that listen in the same place are flagged when they share one.
 */
export function KeymapPage() {
  const keymap = useSettingsStore((state) => state.keymap);
  const resetKeymap = useSettingsStore((state) => state.resetKeymap);

  return (
    <section>
      <PageHeader title="Keymap" hint="Keyboard shortcuts of Hunt's own commands; text fields and dialogs keep their keys" isDefault={keymap.isDefault} onReset={resetKeymap} />
      <div className="flex flex-col gap-5">
        {KEYMAP_GROUPS.map((group) => (
          <div key={group.title} className="flex flex-col">
            <h4 className="pb-1.5 text-[12px] font-medium tracking-wide text-neutral-500 uppercase">{group.title}</h4>
            <ul className="flex flex-col divide-y divide-(--line) border-y border-(--line)">
              {group.commands.map((command) => (
                <KeymapRow key={command.id} id={command.id as CommandId} />
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

/** One command: its label, its bindings as removable chips, the button that records another and a reset. */
function KeymapRow({ id }: { id: CommandId }) {
  const keymap = useSettingsStore((state) => state.keymap);
  const setKeyBindings = useSettingsStore((state) => state.setKeyBindings);
  const [isRecording, setIsRecording] = useState(false);
  const command = keymapCommand(id);
  const bindings = keymap.bindingsOf(id);
  const defaults = Keymap.defaultBindingsOf(id);
  const conflicts = keymap.conflictsOf(id);

  return (
    <li className="flex flex-col gap-1 py-2">
      <div className="flex min-h-7 items-center gap-3">
        <div className="min-w-0 flex-1 text-sm text-neutral-100">
          {command.label}
          {command.note ? <span className="ml-2 text-[13px] text-neutral-500">{command.note}</span> : null}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {bindings.map((shortcut) => (
            <span key={shortcut.text} className="flex h-7 items-center gap-1 rounded-md border border-neutral-600 bg-(--surface-input) pr-1 pl-2 text-[13px] text-neutral-200">
              <kbd className="font-sans">{shortcut.label}</kbd>
              <button
                type="button"
                onClick={() => setKeyBindings(id, bindings.filter((other) => !other.isEqualTo(shortcut)))}
                className="flex size-5 items-center justify-center rounded text-neutral-500 hover:bg-(--row-hover) hover:text-white"
                aria-label={`Remove ${shortcut.label} from ${command.label}`}
              >
                <CloseIcon className="size-3" />
              </button>
            </span>
          ))}
          {isRecording ? (
            <ShortcutRecorder
              onRecord={(shortcut) => {
                setKeyBindings(id, [...bindings, shortcut]);
                setIsRecording(false);
              }}
              onCancel={() => setIsRecording(false)}
            />
          ) : (
            <button type="button" onClick={() => setIsRecording(true)} className={ICON_BUTTON_SM} aria-label={`Add a shortcut to ${command.label}`} title="Add a shortcut">
              <PlusIcon />
            </button>
          )}
          {keymap.isDefaultBinding(id) ? null : (
            <button
              type="button"
              onClick={() => setKeyBindings(id, defaults)}
              className={`${BUTTON_XS} text-neutral-500 hover:bg-(--row-hover) hover:text-neutral-200`}
              title={`Default: ${defaults.map((shortcut) => shortcut.label).join(", ") || "none"}`}
            >
              Reset
            </button>
          )}
        </div>
      </div>
      {conflicts.length ? (
        <p className="text-[13px] leading-snug text-red-300">Also bound to {conflicts.map((other) => `“${keymapCommand(other).label}”`).join(", ")}; only one of them runs.</p>
      ) : null}
    </li>
  );
}

/**
 * Takes the focus and turns the next key press into a shortcut, Escape and ⌘W included, so the window's own keys do not
 * act meanwhile. Modifiers held so far show as a preview; a press the keymap cannot bind shows why. Leaving the field
 * cancels.
 */
function ShortcutRecorder({ onRecord, onCancel }: { onRecord: (shortcut: Shortcut) => void; onCancel: () => void }) {
  const [preview, setPreview] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const showModifiers = (event: KeyboardEvent<HTMLButtonElement>) => setPreview(Shortcut.modifiersLabel(event));

  return (
    <span className="flex flex-col items-end">
      <button
        type="button"
        autoFocus
        onBlur={onCancel}
        onKeyDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          const shortcut = Shortcut.fromEvent(event.nativeEvent);
          if (!shortcut) {
            showModifiers(event);
            return;
          }
          const reason = shortcut.bindingProblem;
          if (reason) {
            setPreview(shortcut.label);
            setProblem(reason);
            return;
          }
          onRecord(shortcut);
        }}
        onKeyUp={(event) => {
          event.stopPropagation();
          showModifiers(event);
        }}
        className="flex h-7 min-w-36 items-center justify-center rounded-md border border-blue-400 bg-blue-400/10 px-2 text-[13px] text-neutral-200 outline-none"
        aria-label="Press the new shortcut"
      >
        {preview || "Press a shortcut…"}
      </button>
      {problem ? <span className="mt-1 text-[12px] text-red-300">{problem}</span> : null}
    </span>
  );
}
