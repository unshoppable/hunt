/**
 * The `[Image #n]` tokens in a prompt's text that refer to its n-th attached image, numbered from 1 in attachment
 * order: the convention Claude Code uses for pasted images, so the agent can match a mention to an image block.
 */

const REFERENCE_PATTERN = /\[Image #(\d+)\]/g;

/** The reference of the image at `index` (1-based). */
export function imageReference(index: number): string {
  return `[Image #${index}]`;
}

/**
 * Inserts the reference of image `index` at `caret`, separated from neighbouring text by a space on each side,
 * and returns the text with the caret placed after the reference.
 */
export function insertImageReference(text: string, caret: number, index: number): { text: string; caret: number } {
  const before = text.slice(0, caret);
  const after = text.slice(caret);
  const needsSpaceBefore = before.length > 0 && !/\s$/.test(before);
  const needsSpaceAfter = !/^\s/.test(after);
  const inserted = `${needsSpaceBefore ? " " : ""}${imageReference(index)}${needsSpaceAfter ? " " : ""}`;
  return { text: before + inserted + after, caret: before.length + inserted.length };
}

/** Removes every reference of image `index` and renumbers the references of the images after it. */
export function removeImageReference(text: string, index: number): string {
  const removed = text.replace(new RegExp(`\\[Image #${index}\\] ?`, "g"), "").replace(/ +$/, "");
  return removed.replace(REFERENCE_PATTERN, (match, number: string) => (Number(number) > index ? imageReference(Number(number) - 1) : match));
}

/** Renumbers every reference by `offset`, for a prompt taken back into a box that already holds `offset` images. */
export function shiftImageReferences(text: string, offset: number): string {
  if (!offset) return text;
  return text.replace(REFERENCE_PATTERN, (_match, number: string) => imageReference(Number(number) + offset));
}
