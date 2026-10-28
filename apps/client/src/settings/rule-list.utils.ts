/**
 * Positional edits of an ordered rule list. Each starts from the store's current rules (`current`), not the rendered
 * ones: two fields of a row may commit before a re-render.
 */
export function ruleListEdits<T extends object>(current: () => T[], set: (rules: T[]) => void) {
  return {
    update: (index: number, patch: Partial<T>) => set(current().map((rule, position) => (position === index ? { ...rule, ...patch } : rule))),
    remove: (index: number) => set(current().filter((_, position) => position !== index)),
    move: (index: number, offset: -1 | 1) => {
      const next = [...current()];
      const [rule] = next.splice(index, 1);
      next.splice(index + offset, 0, rule);
      set(next);
    },
    add: (rule: T) => set([...current(), rule]),
  };
}
