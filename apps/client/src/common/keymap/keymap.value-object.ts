import * as z from "zod/mini";
import { ValueObject } from "../../../../../libs/domain/src/model/value-object.model.ts";
import { KEYMAP_COMMANDS, type CommandId, type KeymapCommand } from "./keymap-commands.data";
import { Shortcut, type KeyPress } from "./shortcut.value-object";

const COMMANDS_BY_ID = new Map<string, KeymapCommand>(KEYMAP_COMMANDS.map((command) => [command.id, command]));
const COMMAND_IDS: CommandId[] = KEYMAP_COMMANDS.map((command) => command.id);

/** The keymap command `id`; throws for an id KEYMAP_COMMANDS does not hold. */
export function keymapCommand(id: CommandId): KeymapCommand {
  const command = COMMANDS_BY_ID.get(id);
  if (!command) throw new Error(`unknown keymap command ${id}`);
  return command;
}

const BINDING_RULE = "a binding is a shortcut a command can take: a key that types text needs ⌘, ⌃ or ⌥";
const UNIQUE_RULE = "a command lists each binding once";
const DEFAULTS_RULE = "a keymap holds only the bindings that differ from the command's defaults";

function isBindable(text: string): boolean {
  return Shortcut.parse(text)?.bindingProblem === null;
}

function isSameTexts(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((text, index) => text === right[index]);
}

const ZodKeymapState = z
  .partialRecord(
    z.enum(COMMAND_IDS),
    z.array(z.string().check(z.refine(isBindable, BINDING_RULE))).check(z.refine((texts) => new Set(texts).size === texts.length, UNIQUE_RULE)),
  )
  .check(z.refine((bindings) => Object.entries(bindings).every(([id, texts]) => !texts || !isSameTexts(texts, COMMANDS_BY_ID.get(id)?.defaults ?? [])), DEFAULTS_RULE));

/** The stored form of a keymap: the canonical texts of the bindings the user changed, per command. */
export type StoredKeymap = z.infer<typeof ZodKeymapState>;

export interface Keymap extends StoredKeymap {}

/**
 * The bindings of every command of KEYMAP_COMMANDS: the user's where they changed them, the command's defaults
 * otherwise; an empty list unbinds a command. The state is the stored form, so `toJSON` is what the settings persist.
 */
export class Keymap extends ValueObject<typeof ZodKeymapState> {
  static readonly schema = ZodKeymapState;

  constructor(value: z.input<typeof ZodKeymapState>) {
    super(value);
  }

  /** The keymap that binds every command to its defaults. */
  static defaults(): Keymap {
    return new Keymap({});
  }

  /** A stored keymap with unknown commands, malformed lists, shortcuts no command can take and default bindings left out. */
  static fromStored(stored: unknown): Keymap {
    let keymap = Keymap.defaults();
    if (!stored || typeof stored !== "object") return keymap;
    for (const [id, texts] of Object.entries(stored)) {
      if (!COMMANDS_BY_ID.has(id) || !Array.isArray(texts)) continue;
      const shortcuts = texts.flatMap((text) => (typeof text === "string" ? (Shortcut.parse(text) ?? []) : [])).filter((shortcut) => !shortcut.bindingProblem);
      keymap = keymap.with(id as CommandId, shortcuts);
    }
    return keymap;
  }

  /** The bindings KEYMAP_COMMANDS gives `commandId`. */
  static defaultBindingsOf(commandId: CommandId): Shortcut[] {
    return keymapCommand(commandId).defaults.flatMap((text) => Shortcut.parse(text) ?? []);
  }

  /** Whether every command has its default bindings. */
  get isDefault(): boolean {
    return Object.keys(this._state).length === 0;
  }

  bindingsOf(commandId: CommandId): Shortcut[] {
    return this.textsOf(commandId).flatMap((text) => Shortcut.parse(text) ?? []);
  }

  isDefaultBinding(commandId: CommandId): boolean {
    return !this._state[commandId];
  }

  /** The first binding of `commandId` as macOS menus show it (`⌘S`), or null while it is unbound. */
  labelOf(commandId: CommandId): string | null {
    return this.bindingsOf(commandId)[0]?.label ?? null;
  }

  /** Whether `event` presses one of the bindings of `commandId`. */
  matches(event: KeyPress, commandId: CommandId): boolean {
    const pressed = Shortcut.fromEvent(event);
    return !!pressed && this.textsOf(commandId).includes(pressed.text);
  }

  /** The first of `commandIds` that `event` presses, or null. */
  commandFor<T extends CommandId>(event: KeyPress, commandIds: readonly T[]): T | null {
    const pressed = Shortcut.fromEvent(event);
    if (!pressed) return null;
    return commandIds.find((commandId) => this.textsOf(commandId).includes(pressed.text)) ?? null;
  }

  /** The other commands of the scope of `commandId` that share one of its bindings. */
  conflictsOf(commandId: CommandId): CommandId[] {
    const own = this.textsOf(commandId);
    const scope = keymapCommand(commandId).scope;
    return KEYMAP_COMMANDS.filter(
      (command) => command.id !== commandId && command.scope === scope && this.textsOf(command.id).some((text) => own.includes(text)),
    ).map((command) => command.id);
  }

  /** The keymap with `commandId` bound to `shortcuts`, each once; bindings equal to the defaults drop the user's entry. */
  with(commandId: CommandId, shortcuts: readonly Shortcut[]): Keymap {
    const texts = [...new Set(shortcuts.map((shortcut) => shortcut.text))];
    const { [commandId]: _previous, ...others } = this._state;
    return new Keymap(isSameTexts(texts, keymapCommand(commandId).defaults) ? others : { ...others, [commandId]: texts });
  }

  private textsOf(commandId: CommandId): readonly string[] {
    return this._state[commandId] ?? keymapCommand(commandId).defaults;
  }
}
